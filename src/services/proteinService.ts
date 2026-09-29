import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../utils/clock.js";
import { AppError } from "../utils/errors.js";
import { requireString } from "./validation.js";
import { validateProteinSequence } from "./validation.js";

export interface ProteinInput {
  accession: string;
  name: string;
  sequence: string;
  aliases?: string[];
}

export interface ProteinResult {
  id: number;
  accession: string;
  version: number;
  name: string;
  sequence: string;
  sequenceLength: number;
  aliases: string[];
  createdAt: string;
  updated: boolean;
}

/**
 * Import a protein sequence.
 *
 * Idempotent on (accession, version). If the accession already exists:
 *  - identical sequence -> no-op, return existing row
 *  - changed sequence   -> insert a new versioned row
 * Aliases are merged (existing aliases are preserved).
 */
export function importProtein(
  db: DatabaseSync,
  input: ProteinInput,
  clock: Clock
): ProteinResult {
  const accession = requireString(input.accession, "accession");
  const name = requireString(input.name, "name");
  const sequence = validateProteinSequence(input.sequence);
  const aliases = (input.aliases ?? []).map((a) => requireString(a, "alias"));

  const existing = db
    .prepare("SELECT * FROM proteins WHERE accession = ? ORDER BY version DESC LIMIT 1")
    .get(accession) as
    | {
        id: number;
        accession: string;
        version: number;
        name: string;
        sequence: string;
        sequence_length: number;
        created_at: string;
      }
    | undefined;

  if (existing) {
    if (existing.sequence === sequence) {
      mergeAliases(db, existing.id, aliases);
      return toResult(db, existing.id, existing, false);
    }
    const newVersion = existing.version + 1;
    const info = db
      .prepare(
        `INSERT INTO proteins(accession, version, name, sequence, sequence_length, created_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(accession, newVersion, name, sequence, sequence.length, clock.now());
    const id = Number(info.lastInsertRowid);
    mergeAliases(db, id, aliases);
    const row = db.prepare("SELECT * FROM proteins WHERE id = ?").get(id)!;
    return toResult(db, id, row as never, true);
  }

  const info = db
    .prepare(
      `INSERT INTO proteins(accession, version, name, sequence, sequence_length, created_at)
       VALUES (?,1,?,?,?,?)`
    )
    .run(accession, name, sequence, sequence.length, clock.now());
  const id = Number(info.lastInsertRowid);
  mergeAliases(db, id, aliases);
  const row = db.prepare("SELECT * FROM proteins WHERE id = ?").get(id)!;
  return toResult(db, id, row as never, true);
}

function mergeAliases(db: DatabaseSync, proteinId: number, aliases: string[]): void {
  const ins = db.prepare("INSERT OR IGNORE INTO protein_aliases(protein_id, alias) VALUES (?,?)");
  for (const alias of aliases) {
    ins.run(proteinId, alias);
  }
}

function toResult(
  db: DatabaseSync,
  id: number,
  row: {
    accession: string;
    version: number;
    name: string;
    sequence: string;
    sequence_length: number;
    created_at: string;
  },
  updated: boolean
): ProteinResult {
  const aliases = (
    db.prepare("SELECT alias FROM protein_aliases WHERE protein_id = ? ORDER BY alias").all(id) as {
      alias: string;
    }[]
  ).map((r) => r.alias);
  return {
    id,
    accession: row.accession,
    version: row.version,
    name: row.name,
    sequence: row.sequence,
    sequenceLength: row.sequence_length,
    aliases,
    createdAt: row.created_at,
    updated,
  };
}

export function getProtein(db: DatabaseSync, id: number): ProteinResult {
  const row = db.prepare("SELECT * FROM proteins WHERE id = ?").get(id) as
    | {
        id: number;
        accession: string;
        version: number;
        name: string;
        sequence: string;
        sequence_length: number;
        created_at: string;
      }
    | undefined;
  if (!row) throw new AppError("NOT_FOUND", `Protein ${id} not found`);
  const aliases = (
    db.prepare("SELECT alias FROM protein_aliases WHERE protein_id = ? ORDER BY alias").all(id) as {
      alias: string;
    }[]
  ).map((r) => r.alias);
  return {
    id: row.id,
    accession: row.accession,
    version: row.version,
    name: row.name,
    sequence: row.sequence,
    sequenceLength: row.sequence_length,
    aliases,
    createdAt: row.created_at,
    updated: false,
  };
}

export function resolveProteinId(db: DatabaseSync, accessionOrAlias: string): number {
  if (/^\d+$/.test(accessionOrAlias)) {
    const byId = db.prepare("SELECT id FROM proteins WHERE id = ?").get(
      Number(accessionOrAlias)
    ) as { id: number } | undefined;
    if (byId) return byId.id;
  }
  let row = db.prepare("SELECT id FROM proteins WHERE accession = ?").get(accessionOrAlias) as
    | { id: number }
    | undefined;
  if (row) return row.id;
  row = db.prepare("SELECT protein_id AS id FROM protein_aliases WHERE alias = ?").get(
    accessionOrAlias
  ) as { id: number } | undefined;
  if (row) return row.id;
  throw new AppError("NOT_FOUND", `No protein found for accession or alias '${accessionOrAlias}'`);
}
