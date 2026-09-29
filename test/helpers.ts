import { DatabaseSync } from "node:sqlite";
import { runMigrations, seedReferenceData } from "../src/db/database.js";
import { fixedClock } from "../src/utils/clock.js";

/** In-memory database with deterministic clock for reproducible tests. */
export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  const clock = fixedClock("2026-01-01T00:00:00.000Z", "test-uuid");
  runMigrations(db, clock);
  seedReferenceData(db, clock);
  return db;
}

export const FIXED_CLOCK = () => fixedClock("2026-01-01T00:00:00.000Z");

export async function importAll(db: DatabaseSync) {
  const { importProtein } = await import("../src/services/proteinService.js");
  const proteins = [
    { accession: "FAKE_ALPHA", name: "alpha", sequence: "GKAAGK", aliases: ["ALIAS_A"] },
    { accession: "FAKE_BETA", name: "beta", sequence: "LKAAGKR", aliases: ["ALIAS_B"] },
    { accession: "FAKE_GAMMA", name: "gamma", sequence: "AKRKPK" },
    { accession: "FAKE_DELTA", name: "delta", sequence: "ARPGAKR" },
  ];
  const clock = fixedClock("2026-01-01T00:00:00.000Z");
  return proteins.map((p) => importProtein(db, p, clock));
}
