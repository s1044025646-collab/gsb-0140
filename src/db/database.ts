import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_RESIDUE_MASSES } from "../core/constants.ts";
import { MIGRATIONS } from "./schema.ts";

export interface Clock {
  now(): Date;
}

export const defaultClock: Clock = { now: () => new Date() };

/**
 * Open (or create) a SQLite database file and ensure every recorded migration
 * has run. Migration bookkeeping lives in schema_migrations; applying twice
 * is safe because the schema itself is idempotent.
 */
export function openDatabase(path: string, clock: Clock = defaultClock): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`);
  const appliedRows = db
    .prepare("SELECT id FROM schema_migrations ORDER BY id")
    .all() as Array<{ id: number }>;
  const applied = new Set(appliedRows.map((row) => row.id));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const tx = db.prepare(
      "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      tx.run(migration.id, migration.name, clock.now().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

/** Seed trypsin, default fixed mods and the default residue mass revision. Idempotent. */
export function seedReferenceData(db: DatabaseSync, clock: Clock = defaultClock): {
  massRevisionId: number;
  trypsinId: number;
  carbamidomethylId: number;
} {
  const ts = clock.now().toISOString();
  db
    .prepare(
      `INSERT OR IGNORE INTO enzymes (id, name, cut_residues, no_cut_before, created_at)
       VALUES (1, 'trypsin', 'KR', 'P', ?)`,
    )
    .run(ts);
  db
    .prepare(
      `INSERT OR IGNORE INTO fixed_modifications (id, name, residue, mass_shift, created_at)
       VALUES (1, 'carbamidomethyl_cys', 'C', 57.021464, ?)`,
    )
    .run(ts);

  const existing = db
    .prepare("SELECT id FROM mass_table_revisions WHERE label = 'default_v1'")
    .get() as { id: number } | undefined;
  let massRevisionId: number;
  if (existing) {
    massRevisionId = existing.id;
  } else {
    db
      .prepare(
        "INSERT INTO mass_table_revisions (label, created_at, is_current) VALUES ('default_v1', ?, 1)",
      )
      .run(ts);
    massRevisionId = Number(
      (
        db
          .prepare("SELECT last_insert_rowid() AS id")
          .get() as { id: number | bigint }
      ).id,
    );
    const insert = db.prepare(
      "INSERT INTO residue_masses (revision_id, residue, residue_mass) VALUES (?, ?, ?)",
    );
    for (const [residue, mass] of Object.entries(DEFAULT_RESIDUE_MASSES)) {
      insert.run(massRevisionId, residue, mass);
    }
  }
  return { massRevisionId, trypsinId: 1, carbamidomethylId: 1 };
}

export function loadResidueMassTable(
  db: DatabaseSync,
  revisionId: number,
): Map<string, number> {
  const rows = db
    .prepare(
      "SELECT residue, residue_mass AS residueMass FROM residue_masses WHERE revision_id = ?",
    )
    .all(revisionId) as Array<{ residue: string; residueMass: number }>;
  return new Map(rows.map((row) => [row.residue, row.residueMass]));
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
