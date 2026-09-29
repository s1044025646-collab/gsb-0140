import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.js";
import { DEFAULT_RESIDUE_MASSES, BUILTIN_MODIFICATIONS } from "../domain/constants.js";
import { TRYPSIN } from "../domain/digestion.js";
import type { Clock } from "../utils/clock.js";
import { realClock } from "../utils/clock.js";

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  return db;
}

/**
 * Run pending migrations. Safe to run repeatedly; already applied versions
 * are skipped.
 */
export function runMigrations(db: DatabaseSync, clock: Clock = realClock): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_version").all() as { version: number }[]).map(
      (r) => r.version
    )
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const tx = db.prepare("BEGIN");
    tx.run();
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?,?)").run(
        migration.version,
        clock.now()
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Insert built-in reference data (mass table, modifications, enzyme).
 * Idempotent: re-running leaves existing rows untouched.
 */
export function seedReferenceData(db: DatabaseSync, clock: Clock = realClock): void {
  const tx = db.prepare("BEGIN");
  tx.run();
  try {
    const enzymeExists = db
      .prepare("SELECT id FROM enzymes WHERE name = ?")
      .get(TRYPSIN.name);
    if (!enzymeExists) {
      db.prepare(
        "INSERT INTO enzymes(name, cleave_after, exception_residue) VALUES (?,?,?)"
      ).run(TRYPSIN.name, JSON.stringify(TRYPSIN.cleaveAfter), TRYPSIN.exceptionResidue);
    }

    const mtName = "monoisotopic_v1";
    let mt = db.prepare("SELECT id FROM mass_tables WHERE name = ?").get(mtName) as
      | { id: number }
      | undefined;
    if (!mt) {
      const info = db
        .prepare("INSERT INTO mass_tables(name, description, created_at) VALUES (?,?,?)")
        .run(mtName, "Standard 20 amino acid monoisotopic residue masses", clock.now());
      mt = { id: Number(info.lastInsertRowid) };
      const ins = db.prepare(
        "INSERT INTO residue_masses(mass_table_id, residue, mass) VALUES (?,?,?)"
      );
      for (const [res, mass] of Object.entries(DEFAULT_RESIDUE_MASSES)) {
        ins.run(mt.id, res, mass);
      }
    }

    const modIns = db.prepare(
      "INSERT OR IGNORE INTO modifications(name, residue, delta_mass, description) VALUES (?,?,?,?)"
    );
    for (const m of BUILTIN_MODIFICATIONS) {
      modIns.run(m.name, m.residue, m.deltaMass, m.description);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function initDatabase(path: string, clock: Clock = realClock): DatabaseSync {
  const db = openDatabase(path);
  runMigrations(db, clock);
  seedReferenceData(db, clock);
  return db;
}
