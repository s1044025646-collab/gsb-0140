import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../db/database.ts";
import { ApiError } from "../api/errors.ts";
import { validateMatchParams } from "../core/matcher.ts";

export interface ParameterSetInput {
  label: string;
  precursorTolerance: number;
  precursorUnit: "ppm" | "da";
  fragmentTolerance: number;
  fragmentUnit: "ppm" | "da";
  charges: number[];
  fixedModificationIds?: number[];
  fragmentCharges?: number[];
  enzymeId?: number;
  maxMissedCleavages: number;
  massRevisionId?: number;
}

export function validateParameterInput(raw: Partial<ParameterSetInput>): ParameterSetInput {
  if (!raw.label || typeof raw.label !== "string") {
    throw new ApiError("VALIDATION_ERROR", "label is required");
  }
  if (raw.precursorUnit !== "ppm" && raw.precursorUnit !== "da") {
    throw new ApiError("VALIDATION_ERROR", "precursorUnit must be 'ppm' or 'da'");
  }
  if (raw.fragmentUnit !== "ppm" && raw.fragmentUnit !== "da") {
    throw new ApiError("VALIDATION_ERROR", "fragmentUnit must be 'ppm' or 'da'");
  }
  if (
    typeof raw.maxMissedCleavages !== "number" ||
    !Number.isInteger(raw.maxMissedCleavages) ||
    raw.maxMissedCleavages < 0
  ) {
    throw new ApiError("VALIDATION_ERROR", "maxMissedCleavages must be a non-negative integer");
  }
  if (!Array.isArray(raw.charges) || raw.charges.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "charges must be a non-empty integer array");
  }
  validateMatchParams({
    precursorTolerance: raw.precursorTolerance as number,
    precursorUnit: raw.precursorUnit,
    fragmentTolerance: raw.fragmentTolerance as number,
    fragmentUnit: raw.fragmentUnit,
    charges: raw.charges,
    fixedModificationIds: raw.fixedModificationIds ?? [],
  });
  return raw as ParameterSetInput;
}

/**
 * Create an immutable parameter set. Parameter or mass-table revision changes
 * always produce a new row, which is what keeps historical searches
 * reproducible.
 */
export function createParameterSet(
  db: DatabaseSync,
  raw: Partial<ParameterSetInput>,
  defaults: { massRevisionId: number; trypsinId: number },
  clock: Clock,
): number {
  const input = validateParameterInput(raw);
  const enzymeId = input.enzymeId ?? defaults.trypsinId;
  const massRevisionId = input.massRevisionId ?? defaults.massRevisionId;
  const enzyme = db.prepare("SELECT id FROM enzymes WHERE id = ?").get(enzymeId);
  if (!enzyme) throw new ApiError("NOT_FOUND", `enzyme ${enzymeId} not found`, 404);
  const revision = db
    .prepare("SELECT id FROM mass_table_revisions WHERE id = ?")
    .get(massRevisionId);
  if (!revision) throw new ApiError("NOT_FOUND", `mass revision ${massRevisionId} not found`, 404);
  const modIds = input.fixedModificationIds ?? [];
  const fragmentCharges = input.fragmentCharges ?? [1];
  const result = db
    .prepare(
      `INSERT INTO parameter_sets
       (label, precursor_tolerance, precursor_unit, fragment_tolerance, fragment_unit,
        charges, fixed_modification_ids, fragment_charges, enzyme_id,
        max_missed_cleavages, mass_revision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.label,
      input.precursorTolerance,
      input.precursorUnit,
      input.fragmentTolerance,
      input.fragmentUnit,
      JSON.stringify([...new Set(input.charges)].sort((a, b) => a - b)),
      JSON.stringify([...new Set(modIds)]),
      JSON.stringify([...new Set(fragmentCharges)].sort((a, b) => a - b)),
      enzymeId,
      input.maxMissedCleavages,
      massRevisionId,
      clock.now().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

export function getParameterSet(db: DatabaseSync, id: number) {
  const row = db.prepare("SELECT * FROM parameter_sets WHERE id = ?").get(id);
  if (!row) throw new ApiError("NOT_FOUND", `parameter set ${id} not found`, 404);
  return row;
}

export function listParameterSets(db: DatabaseSync, page: number, pageSize: number) {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM parameter_sets").get() as { c: number }).c;
  const items = db
    .prepare("SELECT * FROM parameter_sets ORDER BY id LIMIT ? OFFSET ?")
    .all(pageSize, (page - 1) * pageSize);
  return { items, total, page, pageSize };
}
