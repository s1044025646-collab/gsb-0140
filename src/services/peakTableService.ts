import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../utils/clock.js";
import { AppError } from "../utils/errors.js";
import { requireString, validatePeaks } from "./validation.js";

export interface PeakTableInput {
  name: string;
  description?: string;
  precursorMz?: number;
  precursorCharge?: number;
  peaks: { mz: number; intensity?: number; charge?: number }[];
}

/**
 * Import an observed peak table. Idempotent on name: re-submitting the same
 * table returns the existing id without duplicating data.
 */
export function importPeakTable(
  db: DatabaseSync,
  input: PeakTableInput,
  clock: Clock
): { id: number; peakCount: number; reused: boolean } {
  const name = requireString(input.name, "name");
  const peaks = validatePeaks(input.peaks);

  const existing = db.prepare("SELECT id FROM peak_tables WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (existing) {
    const count = (
      db
        .prepare("SELECT COUNT(*) AS c FROM peaks WHERE peak_table_id = ?")
        .get(existing.id) as { c: number }
    ).c;
    return { id: existing.id, peakCount: count, reused: true };
  }

  const tx = db.prepare("BEGIN");
  tx.run();
  try {
    const info = db
      .prepare(
        `INSERT INTO peak_tables(name, description, precursor_mz, precursor_charge, created_at)
         VALUES (?,?,?,?,?)`
      )
      .run(
        name,
        input.description ?? "",
        input.precursorMz ?? null,
        input.precursorCharge ?? null,
        clock.now()
      );
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      "INSERT INTO peaks(peak_table_id, peak_index, mz, intensity, charge) VALUES (?,?,?,?,?)"
    );
    peaks.forEach((p, i) => ins.run(id, i, p.mz, p.intensity, p.charge ?? null));
    db.exec("COMMIT");
    return { id, peakCount: peaks.length, reused: false };
  } catch (err) {
    db.exec("ROLLBACK");
    throw new AppError("TRANSACTION_FAILED", "Failed to import peak table", String(err));
  }
}

export function getPeakTable(db: DatabaseSync, id: number) {
  const header = db.prepare("SELECT * FROM peak_tables WHERE id = ?").get(id);
  if (!header) throw new AppError("NOT_FOUND", `Peak table ${id} not found`);
  const peaks = db
    .prepare("SELECT peak_index, mz, intensity, charge FROM peaks WHERE peak_table_id = ? ORDER BY peak_index")
    .all(id);
  return { ...(header as object), peaks };
}
