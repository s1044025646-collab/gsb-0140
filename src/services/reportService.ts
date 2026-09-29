import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../utils/clock.js";
import { AppError } from "../utils/errors.js";
import { TRYPSIN, type EnzymeRule } from "../domain/digestion.js";
import { loadMassTable, loadModificationDeltas } from "./massTableService.js";
import {
  searchCandidates,
  annotateAmbiguity,
  type CandidateMatch,
  type SearchParameters,
  type ObservedPeak,
  type ProteinSource,
} from "./searchEngine.js";

export interface AnalysisRow {
  id: number;
  name: string;
  enzyme_id: number;
  mass_table_id: number;
  max_missed_cleavages: number;
  precursor_charge: number;
  precursor_tolerance: number;
  precursor_tolerance_unit: string;
  fragment_tolerance: number;
  fragment_tolerance_unit: string;
  modification_ids: string;
  revision: number;
  supersedes_id: number | null;
}

export function getAnalysis(db: DatabaseSync, analysisId: number): AnalysisRow {
  const row = db.prepare("SELECT * FROM analyses WHERE id = ?").get(analysisId) as
    | AnalysisRow
    | undefined;
  if (!row) throw new AppError("NOT_FOUND", `Analysis ${analysisId} not found`);
  return row;
}

export function buildSearchParameters(db: DatabaseSync, a: AnalysisRow): SearchParameters {
  const enzymeRow = db.prepare("SELECT * FROM enzymes WHERE id = ?").get(a.enzyme_id) as
    | { name: string; cleave_after: string; exception_residue: string }
    | undefined;
  if (!enzymeRow) throw new AppError("NOT_FOUND", `Enzyme ${a.enzyme_id} not found`);
  const enzyme: EnzymeRule =
    enzymeRow.name === TRYPSIN.name
      ? TRYPSIN
      : {
          name: enzymeRow.name,
          cleaveAfter: JSON.parse(enzymeRow.cleave_after),
          exceptionResidue: enzymeRow.exception_residue,
        };
  const massTable = loadMassTable(db, a.mass_table_id);
  const modificationIds = JSON.parse(a.modification_ids) as number[];
  const modificationDeltas = loadModificationDeltas(db, modificationIds);
  return {
    enzyme,
    massTable,
    modificationDeltas,
    maxMissedCleavages: a.max_missed_cleavages,
    precursorCharge: a.precursor_charge,
    precursorTolerance: a.precursor_tolerance,
    precursorToleranceUnit: a.precursor_tolerance_unit as "ppm" | "da",
    fragmentTolerance: a.fragment_tolerance,
    fragmentToleranceUnit: a.fragment_tolerance_unit as "ppm" | "da",
    fragmentCharges: [1],
  };
}

function loadPeakTable(db: DatabaseSync, peakTableId: number) {
  const header = db.prepare("SELECT * FROM peak_tables WHERE id = ?").get(peakTableId) as
    | { id: number; name: string; precursor_mz: number | null; precursor_charge: number | null }
    | undefined;
  if (!header) throw new AppError("NOT_FOUND", `Peak table ${peakTableId} not found`);
  if (header.precursor_mz === null || header.precursor_mz === undefined) {
    throw new AppError(
      "INVALID_PEAK_TABLE",
      "Peak table has no precursor m/z; cannot search"
    );
  }
  const peaks = db
    .prepare("SELECT id, peak_index, mz, intensity FROM peaks WHERE peak_table_id = ? ORDER BY peak_index")
    .all(peakTableId) as { id: number; peak_index: number; mz: number; intensity: number }[];
  if (peaks.length === 0) {
    throw new AppError("INVALID_PEAK_TABLE", "Peak table contains no peaks");
  }
  const observed: ObservedPeak[] = peaks.map((p) => ({
    peakId: p.id,
    peakIndex: p.peak_index,
    mz: p.mz,
    intensity: p.intensity,
  }));
  return { header, observed };
}

function loadProteins(db: DatabaseSync): ProteinSource[] {
  const rows = db
    .prepare("SELECT id, accession, sequence FROM proteins")
    .all() as { id: number; accession: string; sequence: string }[];
  return rows.map((r) => ({
    proteinId: r.id,
    accession: r.accession,
    sequence: r.sequence,
  }));
}

export interface RunResult {
  reportId: number;
  reportUuid: string;
  reused: boolean;
  candidateCount: number;
}

/**
 * Execute a search and freeze a report.
 *
 * Idempotency: the (analysis_id, peak_table_id) pair is a logical key.
 * Re-submitting the same pair returns the existing frozen report instead of
 * creating a duplicate. Changing parameters or the mass table requires a new
 * analysis (new revision), which naturally produces a new report so historic
 * results remain reproducible.
 */
export function runAndFreeze(
  db: DatabaseSync,
  analysisId: number,
  peakTableId: number,
  clock: Clock
): RunResult {
  const analysis = getAnalysis(db, analysisId);
  const { header, observed } = loadPeakTable(db, peakTableId);
  const proteins = loadProteins(db);
  const params = buildSearchParameters(db, analysis);
  // Honor the peak table's declared precursor charge when present, so
  // multi-charge fixtures are searchable, while analysis stays the source of
  // the default charge.
  if (header.precursor_charge) {
    params.precursorCharge = header.precursor_charge;
  }

  const existing = db
    .prepare("SELECT id, report_uuid FROM reports WHERE analysis_id = ? AND peak_table_id = ?")
    .get(analysisId, peakTableId) as { id: number; report_uuid: string } | undefined;
  if (existing) {
    const count = (
      db
        .prepare("SELECT COUNT(*) AS c FROM peptide_matches WHERE report_id = ?")
        .get(existing.id) as { c: number }
    ).c;
    return { reportId: existing.id, reportUuid: existing.report_uuid, reused: true, candidateCount: count };
  }

  const matches = searchCandidates(proteins, observed, header.precursor_mz as number, params);
  annotateAmbiguity(matches);
  const reportUuid = clock.randomUuid();
  const frozenAt = clock.now();
  const parametersJson = JSON.stringify({ analysis, params: { ...params, massTable: "<by-id>", enzyme: params.enzyme.name } });

  const tx = db.prepare("BEGIN");
  tx.run();
  try {
    const info = db
      .prepare(
        `INSERT INTO reports
           (report_uuid, analysis_id, peak_table_id, status, frozen_at, parameters_json)
         VALUES (?,?,?, 'completed', ?, ?)`
      )
      .run(reportUuid, analysisId, peakTableId, frozenAt, parametersJson);
    const reportId = Number(info.lastInsertRowid);
    persistMatches(db, reportId, matches);
    db.exec("COMMIT");
    return { reportId, reportUuid, reused: false, candidateCount: matches.length };
  } catch (err) {
    db.exec("ROLLBACK");
    throw new AppError("TRANSACTION_FAILED", "Failed to persist report", String(err));
  }
}

function persistMatches(db: DatabaseSync, reportId: number, matches: CandidateMatch[]): void {
  const insMatch = db.prepare(
    `INSERT INTO peptide_matches
       (report_id, peptide_sequence, protein_id, protein_accession, start_position, end_position,
        missed_cleavages, neutral_mass, precursor_mz_theoretical, charge, mass_error_ppm,
        matched_fragments, total_fragments, fragment_coverage, score, rank, ambiguous_group)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insExp = db.prepare(
    `INSERT INTO peak_explanations
       (peptide_match_id, peak_id, peak_mz, ion_type, ion_number, ion_charge,
        theoretical_mz, mass_error_ppm, mass_error_da)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  matches.forEach((m, idx) => {
    // Persist one row per source so shared peptide -> protein mapping is
    // fully retained, all sharing the same rank.
    for (const src of m.sources) {
      const info = insMatch.run(
        reportId,
        m.peptide.sequence,
        src.proteinId,
        src.accession,
        src.start,
        src.end,
        m.peptide.missedCleavages,
        m.neutralMass,
        m.precursorMzTheoretical,
        m.charge,
        m.precursorErrorPpm,
        m.matchedFragments,
        m.totalFragments,
        m.fragmentCoverage,
        m.score,
        idx + 1,
        m.ambiguousGroup ?? null
      );
      const matchId = Number(info.lastInsertRowid);
      for (const a of m.assignments) {
        insExp.run(
          matchId,
          a.peakId,
          a.observedMz,
          a.ion.type,
          a.ion.number,
          a.ion.charge,
          a.theoreticalMz,
          a.errorPpm,
          a.errorDa
        );
      }
    }
  });
}

export function getReport(db: DatabaseSync, reportId: number) {
  const report = db
    .prepare(
      `SELECT r.*, a.name AS analysis_name, pt.name AS peak_table_name
       FROM reports r
       JOIN analyses a ON a.id = r.analysis_id
       JOIN peak_tables pt ON pt.id = r.peak_table_id
       WHERE r.id = ?`
    )
    .get(reportId);
  if (!report) throw new AppError("NOT_FOUND", `Report ${reportId} not found`);
  return report;
}

/**
 * Export a frozen report as a self-contained JSON document. Reports are
 * immutable: the export simply serializes stored rows, so historical
 * reproduction is guaranteed regardless of later parameter/mass changes.
 */
export function exportReport(db: DatabaseSync, reportId: number) {
  const report = getReport(db, reportId);
  const matches = db
    .prepare("SELECT * FROM peptide_matches WHERE report_id = ? ORDER BY rank, id")
    .all(reportId);
  const explanations = db
    .prepare(
      `SELECT pe.* FROM peak_explanations pe
       JOIN peptide_matches pm ON pm.id = pe.peptide_match_id
       WHERE pm.report_id = ?
       ORDER BY pm.rank, pe.id`
    )
    .all(reportId);
  return {
    report,
    matches,
    peakExplanations: explanations,
  };
}
