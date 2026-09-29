import type { DatabaseSync } from "node:sqlite";
import { transaction, type Clock } from "../db/database.ts";
import { ApiError } from "../api/errors.ts";

export interface ProteinInput {
  accession: string;
  name: string;
  aliases?: string[];
  sequence: string;
  /** Client-supplied idempotency key for repeat submissions. */
  clientId?: string;
}

const AA_RE = /^[ACDEFGHIKLMNPQRSTVWY]+$/;

export function normalizeSequence(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[\d*]/g, "");
  if (!AA_RE.test(cleaned)) {
    const invalid = new Set(
      cleaned.split("").filter((aa) => !/[ACDEFGHIKLMNPQRSTVWY]/.test(aa)),
    );
    throw new ApiError(
      "VALIDATION_ERROR",
      `Sequence contains unsupported residues: ${[...invalid].join(", ") || "empty sequence"}`,
    );
  }
  return cleaned;
}

/** Parse a minimal FASTA document into protein inputs. */
export function parseFasta(text: string): ProteinInput[] {
  const lines = text.split(/\r?\n/);
  const proteins: ProteinInput[] = [];
  let header: string | null = null;
  let seqParts: string[] = [];
  const flush = () => {
    if (header === null) return;
    const match = /^(\S+)\s*(.*)$/.exec(header);
    const accession = match?.[1] ?? `PROT${proteins.length + 1}`;
    const name = match?.[2] || accession;
    proteins.push({
      accession,
      name,
      sequence: normalizeSequence(seqParts.join("")),
    });
    seqParts = [];
  };
  for (const line of lines) {
    if (line.startsWith(">")) {
      flush();
      header = line.slice(1).trim();
    } else if (line.trim()) {
      seqParts.push(line);
    }
  }
  flush();
  return proteins;
}

/**
 * Upsert a protein and append a new immutable sequence version. Identical
 * sequence repeated is idempotent: no new version is created.
 * Returns the protein and sequence version ids.
 */
export function upsertProteinSequence(
  db: DatabaseSync,
  input: ProteinInput,
  clock: Clock,
): { proteinId: number; sequenceVersionId: number; created: boolean } {
  if (typeof input.sequence !== "string" || input.sequence.trim() === "") {
    throw new ApiError("VALIDATION_ERROR", "sequence is required");
  }
  const sequence = normalizeSequence(input.sequence);
  if (!input.accession?.trim()) {
    throw new ApiError("VALIDATION_ERROR", "accession is required");
  }
  return transaction(db, () => {
    let proteinRow = db
      .prepare("SELECT id FROM proteins WHERE accession = ?")
      .get(input.accession) as { id: number } | undefined;
    let created = false;
    if (!proteinRow) {
      db
        .prepare("INSERT INTO proteins (accession, name, created_at) VALUES (?, ?, ?)")
        .run(input.accession, input.name || input.accession, clock.now().toISOString());
      proteinRow = db
        .prepare("SELECT id FROM proteins WHERE accession = ?")
        .get(input.accession) as { id: number };
      created = true;
    } else if (input.name) {
      db.prepare("UPDATE proteins SET name = ? WHERE id = ?").run(input.name, proteinRow.id);
    }
    const proteinId = proteinRow.id;
    for (const alias of input.aliases ?? []) {
      db
        .prepare(
          "INSERT OR IGNORE INTO protein_aliases (protein_id, alias, created_at) VALUES (?, ?, ?)",
        )
        .run(proteinId, alias, clock.now().toISOString());
    }
    const current = db
      .prepare(
        "SELECT id, version FROM sequence_versions WHERE protein_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(proteinId) as { id: number; version: number } | undefined;
    if (current) {
      const currentSeq = db
        .prepare("SELECT sequence FROM sequence_versions WHERE id = ?")
        .get(current.id) as { sequence: string };
      if (currentSeq.sequence === sequence) {
        return { proteinId, sequenceVersionId: current.id, created };
      }
    }
    const nextVersion = (current?.version ?? 0) + 1;
    db.prepare("UPDATE sequence_versions SET is_current = 0 WHERE protein_id = ?").run(proteinId);
    db
      .prepare(
        "INSERT INTO sequence_versions (protein_id, version, sequence, is_current, created_at) VALUES (?, ?, ?, 1, ?)",
      )
      .run(proteinId, nextVersion, sequence, clock.now().toISOString());
    const row = db
      .prepare("SELECT last_insert_rowid() AS id")
      .get() as { id: number | bigint };
    return { proteinId, sequenceVersionId: Number(row.id), created };
  });
}

export function listProteins(
  db: DatabaseSync,
  page: number,
  pageSize: number,
): { items: unknown[]; total: number; page: number; pageSize: number } {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM proteins").get() as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT p.id, p.accession, p.name,
              (SELECT COUNT(*) FROM protein_aliases a WHERE a.protein_id = p.id) AS alias_count,
              (SELECT version FROM sequence_versions v WHERE v.protein_id = p.id AND v.is_current = 1) AS current_version
       FROM proteins p ORDER BY p.accession LIMIT ? OFFSET ?`,
    )
    .all(pageSize, (page - 1) * pageSize);
  return { items: rows, total, page, pageSize };
}

export function getProteinDetail(db: DatabaseSync, accession: string) {
  const protein = db
    .prepare("SELECT id, accession, name, created_at AS createdAt FROM proteins WHERE accession = ?")
    .get(accession);
  if (!protein) throw new ApiError("NOT_FOUND", `protein ${accession} not found`, 404);
  const aliases = db
    .prepare("SELECT alias FROM protein_aliases WHERE protein_id = ? ORDER BY alias")
    .all((protein as { id: number }).id) as Array<{ alias: string }>;
  const versions = db
    .prepare(
      "SELECT id, version, length(sequence) AS length, is_current AS isCurrent, created_at AS createdAt FROM sequence_versions WHERE protein_id = ? ORDER BY version",
    )
    .all((protein as { id: number }).id);
  return { ...protein, aliases: aliases.map((a) => a.alias), versions };
}
