import type { DatabaseSync } from "node:sqlite";
import { transaction, type Clock } from "../db/database.ts";
import { ApiError } from "../api/errors.ts";

export interface PeaklistInput {
  clientId: string;
  label: string;
  precursorMz: number;
  chargeHint?: number;
  peaks: Array<{ mz: number; intensity: number }>;
}

export function validatePeaklist(input: Partial<PeaklistInput>): PeaklistInput {
  if (!input.clientId || typeof input.clientId !== "string") {
    throw new ApiError("VALIDATION_ERROR", "clientId is required for idempotent import");
  }
  if (!input.label || typeof input.label !== "string") {
    throw new ApiError("VALIDATION_ERROR", "label is required");
  }
  if (
    typeof input.precursorMz !== "number" ||
    !Number.isFinite(input.precursorMz) ||
    input.precursorMz <= 0
  ) {
    throw new ApiError("VALIDATION_ERROR", "precursorMz must be a positive finite number");
  }
  if (
    input.chargeHint !== undefined &&
    (!Number.isInteger(input.chargeHint) || input.chargeHint < 1)
  ) {
    throw new ApiError("VALIDATION_ERROR", "chargeHint must be a positive integer");
  }
  if (!Array.isArray(input.peaks) || input.peaks.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "peaks must be a non-empty array");
  }
  input.peaks.forEach((peak, index) => {
    if (
      typeof peak.mz !== "number" ||
      !Number.isFinite(peak.mz) ||
      peak.mz <= 0
    ) {
      throw new ApiError("VALIDATION_ERROR", `peaks[${index}].mz invalid`);
    }
    if (
      typeof peak.intensity !== "number" ||
      !Number.isFinite(peak.intensity) ||
      peak.intensity < 0
    ) {
      throw new ApiError("VALIDATION_ERROR", `peaks[${index}].intensity invalid`);
    }
  });
  return input as PeaklistInput;
}

/**
 * Import a peaklist. Idempotent on clientId: a repeat submission with the
 * same payload returns the existing record without creating duplicates.
 */
export function importPeaklist(
  db: DatabaseSync,
  raw: Partial<PeaklistInput>,
  clock: Clock,
): { id: number; reused: boolean } {
  const input = validatePeaklist(raw);
  const existing = db
    .prepare("SELECT id FROM peaklists WHERE client_id = ?")
    .get(input.clientId) as { id: number } | undefined;
  if (existing) return { id: existing.id, reused: true };
  return transaction(db, () => {
    db
      .prepare(
        `INSERT INTO peaklists (client_id, label, precursor_mz, charge_hint, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.clientId,
        input.label,
        input.precursorMz,
        input.chargeHint ?? null,
        clock.now().toISOString(),
      );
    const id = Number(
      (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id,
    );
    const insert = db.prepare(
      "INSERT INTO peaks (peaklist_id, peak_index, mz, intensity) VALUES (?, ?, ?, ?)",
    );
    input.peaks.forEach((peak, index) => insert.run(id, index, peak.mz, peak.intensity));
    return { id, reused: false };
  });
}

export function getPeaklist(db: DatabaseSync, id: number) {
  const header = db
    .prepare(
      `SELECT id, client_id AS clientId, label, precursor_mz AS precursorMz,
              charge_hint AS chargeHint, created_at AS createdAt
       FROM peaklists WHERE id = ?`,
    )
    .get(id);
  if (!header) throw new ApiError("NOT_FOUND", `peaklist ${id} not found`, 404);
  const peaks = db
    .prepare("SELECT peak_index AS peakIndex, mz, intensity FROM peaks WHERE peaklist_id = ? ORDER BY peak_index")
    .all(id);
  return { ...header, peaks };
}

export function listPeaklists(db: DatabaseSync, page: number, pageSize: number) {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM peaklists").get() as { c: number }).c;
  const items = db
    .prepare(
      `SELECT id, client_id AS clientId, label, precursor_mz AS precursorMz,
              charge_hint AS chargeHint, created_at AS createdAt
       FROM peaklists ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(pageSize, (page - 1) * pageSize);
  return { items, total, page, pageSize };
}
