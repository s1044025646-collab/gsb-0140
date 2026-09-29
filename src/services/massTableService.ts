import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../utils/errors.js";

export function loadMassTable(
  db: DatabaseSync,
  massTableId: number
): Record<string, number> {
  const rows = db
    .prepare("SELECT residue, mass FROM residue_masses WHERE mass_table_id = ?")
    .all(massTableId) as { residue: string; mass: number }[];
  if (rows.length === 0) {
    throw new AppError("INVALID_MASS_TABLE", `Mass table ${massTableId} has no residues`);
  }
  const table: Record<string, number> = {};
  for (const r of rows) table[r.residue] = r.mass;
  return table;
}

export function loadModificationDeltas(
  db: DatabaseSync,
  modificationIds: number[]
): Record<string, number> {
  if (modificationIds.length === 0) return {};
  const placeholders = modificationIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT residue, delta_mass FROM modifications WHERE id IN (${placeholders})`
    )
    .all(...modificationIds) as { residue: string; delta_mass: number }[];
  if (rows.length !== modificationIds.length) {
    throw new AppError("NOT_FOUND", "One or more modification ids do not exist");
  }
  const deltas: Record<string, number> = {};
  for (const r of rows) {
    // Fixed modifications on the same residue must be consistent.
    if (deltas[r.residue] !== undefined && deltas[r.residue] !== r.delta_mass) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Conflicting fixed modifications on residue ${r.residue}`
      );
    }
    deltas[r.residue] = r.delta_mass;
  }
  return deltas;
}
