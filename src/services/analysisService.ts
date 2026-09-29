import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../utils/clock.js";
import { AppError } from "../utils/errors.js";
import {
  requireString,
  requireNonNegativeInt,
  requirePositiveInt,
  requirePositiveNumber,
  requireToleranceUnit,
  validateAnalysisUnits,
} from "./validation.js";

export interface AnalysisInput {
  name: string;
  enzyme?: string;
  massTable?: string;
  maxMissedCleavages: number;
  precursorCharge: number;
  precursorTolerance: number;
  precursorToleranceUnit: string;
  fragmentTolerance: number;
  fragmentToleranceUnit: string;
  modifications?: string[];
}

export interface AnalysisResult {
  id: number;
  revision: number;
  supersedesId: number | null;
  reused: boolean;
}

/**
 * Create an analysis parameter set.
 *
 * Revisioning: if an analysis with the same name exists and all parameters
 * are identical, it is reused (idempotent). If any parameter or the mass
 * table differs, a new revision is created (supersedes the previous one),
 * so searches under old parameters remain reproducible.
 */
export function createAnalysis(
  db: DatabaseSync,
  input: AnalysisInput,
  clock: Clock
): AnalysisResult {
  const name = requireString(input.name, "name");
  const maxMissed = requireNonNegativeInt(input.maxMissedCleavages, "maxMissedCleavages");
  const charge = requirePositiveInt(input.precursorCharge, "precursorCharge");
  const precTol = requirePositiveNumber(input.precursorTolerance, "precursorTolerance");
  const fragTol = requirePositiveNumber(input.fragmentTolerance, "fragmentTolerance");
  const precUnit = requireToleranceUnit(input.precursorToleranceUnit, "precursorToleranceUnit");
  const fragUnit = requireToleranceUnit(input.fragmentToleranceUnit, "fragmentToleranceUnit");
  validateAnalysisUnits(precUnit, fragUnit);

  const enzymeName = input.enzyme ?? "trypsin";
  const enzyme = db.prepare("SELECT id FROM enzymes WHERE name = ?").get(enzymeName) as
    | { id: number }
    | undefined;
  if (!enzyme) throw new AppError("NOT_FOUND", `Enzyme '${enzymeName}' not found`);

  const mtName = input.massTable ?? "monoisotopic_v1";
  const mt = db.prepare("SELECT id FROM mass_tables WHERE name = ?").get(mtName) as
    | { id: number }
    | undefined;
  if (!mt) throw new AppError("NOT_FOUND", `Mass table '${mtName}' not found`);

  const modIds: number[] = [];
  for (const modName of input.modifications ?? []) {
    const mod = db.prepare("SELECT id FROM modifications WHERE name = ?").get(modName) as
      | { id: number }
      | undefined;
    if (!mod) throw new AppError("NOT_FOUND", `Modification '${modName}' not found`);
    modIds.push(mod.id);
  }
  modIds.sort((a, b) => a - b);
  const modIdsJson = JSON.stringify(modIds);

  const existing = db
    .prepare("SELECT * FROM analyses WHERE name = ? ORDER BY revision DESC LIMIT 1")
    .get(name) as Record<string, unknown> | undefined;

  const same =
    existing &&
    existing.enzyme_id === enzyme.id &&
    existing.mass_table_id === mt.id &&
    Number(existing.max_missed_cleavages) === maxMissed &&
    Number(existing.precursor_charge) === charge &&
    Number(existing.precursor_tolerance) === precTol &&
    existing.precursor_tolerance_unit === precUnit &&
    Number(existing.fragment_tolerance) === fragTol &&
    existing.fragment_tolerance_unit === fragUnit &&
    existing.modification_ids === modIdsJson;

  if (existing && same) {
    return {
      id: Number(existing.id),
      revision: Number(existing.revision),
      supersedesId: (existing.supersedes_id as number) ?? null,
      reused: true,
    };
  }

  const revision = existing ? Number(existing.revision) + 1 : 1;
  const supersedesId = existing ? Number(existing.id) : null;
  const info = db
    .prepare(
      `INSERT INTO analyses
         (name, enzyme_id, mass_table_id, max_missed_cleavages, precursor_charge,
          precursor_tolerance, precursor_tolerance_unit, fragment_tolerance,
          fragment_tolerance_unit, modification_ids, revision, supersedes_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      name,
      enzyme.id,
      mt.id,
      maxMissed,
      charge,
      precTol,
      precUnit,
      fragTol,
      fragUnit,
      modIdsJson,
      revision,
      supersedesId,
      clock.now()
    );
  return { id: Number(info.lastInsertRowid), revision, supersedesId, reused: false };
}
