import type { DatabaseSync } from "node:sqlite";
import { loadResidueMassTable } from "../db/database.ts";
import { digestSequence, mergeOccurrences } from "../core/digest.ts";
import { peptideNeutralMass, precursorMz } from "../core/mass.ts";
import { search } from "../core/matcher.ts";
import { theoreticalSpectrum } from "../core/spectrum.ts";
import type {
  CandidateMatch,
  EnzymeRule,
  FixedModification,
  MatchParams,
  Peptide,
} from "../core/types.ts";
import { ApiError } from "../api/errors.ts";

export interface ParameterSetRow {
  id: number;
  label: string;
  precursor_tolerance: number;
  precursor_unit: "ppm" | "da";
  fragment_tolerance: number;
  fragment_unit: "ppm" | "da";
  charges: string;
  fixed_modification_ids: string;
  fragment_charges: string;
  enzyme_id: number;
  max_missed_cleavages: number;
  mass_revision_id: number;
}

export function loadEnzyme(db: DatabaseSync, enzymeId: number): EnzymeRule {
  const row = db
    .prepare("SELECT id, name, cut_residues AS cutResidues, no_cut_before AS noCutBefore FROM enzymes WHERE id = ?")
    .get(enzymeId) as
    | { id: number; name: string; cutResidues: string; noCutBefore: string }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `enzyme ${enzymeId} not found`, 404);
  return {
    id: row.id,
    name: row.name,
    cutResidues: row.cutResidues.split("").filter(Boolean),
    noCutBefore: row.noCutBefore.split("").filter(Boolean),
  };
}

export function loadFixedMods(
  db: DatabaseSync,
  ids: number[],
): FixedModification[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name, residue, mass_shift AS massShift FROM fixed_modifications WHERE id IN (${placeholders})`,
    )
    .all(...ids) as unknown as FixedModification[];
  if (rows.length !== new Set(ids).size) {
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new ApiError("NOT_FOUND", `fixed modifications not found: ${missing.join(", ")}`, 404);
  }
  return rows;
}

/** Digest every current protein version into a merged peptide universe. */
export function buildPeptideUniverse(
  db: DatabaseSync,
  enzyme: EnzymeRule,
  maxMissedCleavages: number,
  massRevisionId: number,
  fixedMods: FixedModification[],
): Peptide[] {
  const table = loadResidueMassTable(db, massRevisionId);
  const versions = db
    .prepare(
      `SELECT v.id AS sequenceVersionId, v.sequence, p.id AS proteinId, p.accession
       FROM sequence_versions v JOIN proteins p ON p.id = v.protein_id
       WHERE v.is_current = 1`,
    )
    .all() as Array<{
      sequenceVersionId: number;
      sequence: string;
      proteinId: number;
      accession: string;
    }>;
  const byProtein = versions.map((version) => ({
    proteinId: version.proteinId,
    proteinAccession: version.accession,
    sequenceVersionId: version.sequenceVersionId,
    fragments: digestSequence(version.sequence, enzyme, maxMissedCleavages),
  }));
  const merged = mergeOccurrences(byProtein);
  const peptides: Peptide[] = [];
  for (const [sequence, occurrences] of merged) {
    peptides.push({
      sequence,
      neutralMass: peptideNeutralMass(sequence, table, fixedMods),
      occurrences,
    });
  }
  peptides.sort((a, b) => a.sequence.localeCompare(b.sequence));
  return peptides;
}

export function paramsFromRow(row: ParameterSetRow): MatchParams {
  return {
    precursorTolerance: row.precursor_tolerance,
    precursorUnit: row.precursor_unit,
    fragmentTolerance: row.fragment_tolerance,
    fragmentUnit: row.fragment_unit,
    charges: JSON.parse(row.charges) as number[],
    fixedModificationIds: JSON.parse(row.fixed_modification_ids) as number[],
  };
}

export function runSearch(
  db: DatabaseSync,
  paramRow: ParameterSetRow,
  precursorMzObserved: number,
  peaks: Array<{ mz: number; intensity: number }>,
): CandidateMatch[] {
  const enzyme = loadEnzyme(db, paramRow.enzyme_id);
  const fixedMods = loadFixedMods(
    db,
    JSON.parse(paramRow.fixed_modification_ids) as number[],
  );
  const params = paramsFromRow(paramRow);
  const fragmentCharges = JSON.parse(paramRow.fragment_charges) as number[];
  const peptides = buildPeptideUniverse(
    db,
    enzyme,
    paramRow.max_missed_cleavages,
    paramRow.mass_revision_id,
    fixedMods,
  );
  const table = loadResidueMassTable(db, paramRow.mass_revision_id);
  return search(
    peptides,
    precursorMzObserved,
    peaks,
    params,
    table,
    fixedMods,
    fragmentCharges,
  );
}

export function previewDigest(
  db: DatabaseSync,
  sequence: string,
  enzyme: EnzymeRule,
  maxMissedCleavages: number,
  massRevisionId: number,
  fixedMods: FixedModification[],
) {
  const table = loadResidueMassTable(db, massRevisionId);
  return digestSequence(sequence, enzyme, maxMissedCleavages).map((fragment) => ({
    ...fragment,
    neutralMass: peptideNeutralMass(fragment.sequence, table, fixedMods),
    precursorMzCharge2: precursorMz(
      peptideNeutralMass(fragment.sequence, table, fixedMods),
      2,
    ),
  }));
}

export function generateTheoreticalSpectrum(
  db: DatabaseSync,
  sequence: string,
  massRevisionId: number,
  fixedMods: FixedModification[],
  fragmentCharges: number[],
) {
  const table = loadResidueMassTable(db, massRevisionId);
  return theoreticalSpectrum(sequence, table, fixedMods, fragmentCharges);
}
