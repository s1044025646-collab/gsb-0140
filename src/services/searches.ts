import type { DatabaseSync } from "node:sqlite";
import { transaction, type Clock } from "../db/database.ts";
import { ApiError } from "../api/errors.ts";
import { getPeaklist } from "./peaklists.ts";
import { getParameterSet } from "./parameters.ts";
import { paramsFromRow, runSearch, type ParameterSetRow } from "./engine.ts";

export interface SearchInput {
  clientId: string;
  peaklistId: number;
  parameterSetId: number;
}

/**
 * Execute and freeze a search. Idempotent on clientId: repeating the same
 * submission returns the stored search and its candidates exactly.
 */
export function executeSearch(
  db: DatabaseSync,
  raw: Partial<SearchInput>,
  clock: Clock,
): { searchId: number; reused: boolean } {
  if (!raw.clientId || typeof raw.clientId !== "string") {
    throw new ApiError("VALIDATION_ERROR", "clientId is required for idempotent search");
  }
  if (typeof raw.peaklistId !== "number") {
    throw new ApiError("VALIDATION_ERROR", "peaklistId is required");
  }
  if (typeof raw.parameterSetId !== "number") {
    throw new ApiError("VALIDATION_ERROR", "parameterSetId is required");
  }
  const existing = db
    .prepare("SELECT id FROM searches WHERE client_id = ?")
    .get(raw.clientId) as { id: number } | undefined;
  if (existing) return { searchId: existing.id, reused: true };

  const peaklist = getPeaklist(db, raw.peaklistId) as {
    precursorMz: number;
    peaks: Array<{ mz: number; intensity: number }>;
  };
  const paramRow = getParameterSet(db, raw.parameterSetId) as unknown as ParameterSetRow;
  const candidates = runSearch(
    db,
    paramRow,
    peaklist.precursorMz,
    peaklist.peaks,
  );

  return transaction(db, () => {
    db
      .prepare("INSERT INTO searches (client_id, peaklist_id, parameter_set_id, created_at) VALUES (?, ?, ?, ?)")
      .run(
        raw.clientId as string,
        raw.peaklistId as number,
        raw.parameterSetId as number,
        clock.now().toISOString(),
      );
    const searchId = Number(
      (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id,
    );
    persistCandidates(db, searchId, candidates);
    return { searchId, reused: false };
  });
}

function persistCandidates(
  db: DatabaseSync,
  searchId: number,
  candidates: ReturnType<typeof runSearch>,
): void {
  const insertCandidate = db.prepare(
    `INSERT INTO search_candidates
     (search_id, rank, peptide_sequence, precursor_charge, precursor_mz_theoretical,
      precursor_error_da, precursor_error_ppm, matched_peak_count,
      total_intensity_matched, score, ambiguous_protein)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertOccurrence = db.prepare(
    `INSERT INTO candidate_occurrences
     (candidate_id, protein_id, accession, sequence_version_id, start, "end")
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMatch = db.prepare(
    `INSERT INTO peak_matches
     (candidate_id, peak_index, observed_mz, intensity, ion_series, ion_number,
      ion_charge, theoretical_mz, error_da, error_ppm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  candidates.forEach((candidate, index) => {
    insertCandidate.run(
      searchId,
      index + 1,
      candidate.peptide.sequence,
      candidate.matchedPrecursorCharge,
      candidate.precursorMz,
      candidate.precursorErrorDa,
      candidate.precursorErrorPpm,
      candidate.matchedPeakCount,
      candidate.totalIntensityMatched,
      candidate.score,
      candidate.ambiguousProtein ? 1 : 0,
    );
    const candidateId = Number(
      (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id,
    );
    for (const occurrence of candidate.peptide.occurrences) {
      insertOccurrence.run(
        candidateId,
        occurrence.proteinId,
        occurrence.proteinAccession,
        occurrence.sequenceVersionId,
        occurrence.start,
        occurrence.end,
      );
    }
    for (const match of candidate.peakMatches) {
      insertMatch.run(
        candidateId,
        match.peakIndex,
        match.observedMz,
        match.intensity,
        match.ionSeries,
        match.ionNumber,
        match.charge,
        match.theoreticalMz,
        match.errorDa,
        match.errorPpm,
      );
    }
  });
}

export interface CandidateQuery {
  searchId: number;
  page: number;
  pageSize: number;
}

export function getSearch(db: DatabaseSync, searchId: number) {
  const search = db
    .prepare(
      `SELECT id, client_id AS clientId, peaklist_id AS peaklistId,
              parameter_set_id AS parameterSetId, created_at AS createdAt
       FROM searches WHERE id = ?`,
    )
    .get(searchId);
  if (!search) throw new ApiError("NOT_FOUND", `search ${searchId} not found`, 404);
  return search;
}

export function listCandidates(db: DatabaseSync, query: CandidateQuery) {
  getSearch(db, query.searchId);
  const total = (
    db
      .prepare("SELECT COUNT(*) AS c FROM search_candidates WHERE search_id = ?")
      .get(query.searchId) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT id, rank, peptide_sequence AS peptideSequence, precursor_charge AS precursorCharge,
              precursor_mz_theoretical AS precursorMzTheoretical, precursor_error_da AS precursorErrorDa,
              precursor_error_ppm AS precursorErrorPpm, matched_peak_count AS matchedPeakCount,
              total_intensity_matched AS totalIntensityMatched, score,
              ambiguous_protein AS ambiguousProtein
       FROM search_candidates WHERE search_id = ?
       ORDER BY rank LIMIT ? OFFSET ?`,
    )
    .all(query.searchId, query.pageSize, (query.page - 1) * query.pageSize);
  return {
    items: rows.map((row) => ({
      ...row,
      ambiguousProtein: Boolean((row as { ambiguousProtein: number }).ambiguousProtein),
      occurrences: db
        .prepare(
          `SELECT protein_id AS proteinId, accession, sequence_version_id AS sequenceVersionId,
                  start, "end" FROM candidate_occurrences WHERE candidate_id = ? ORDER BY accession, start`,
        )
        .all((row as { id: number }).id),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export function explainCandidate(db: DatabaseSync, candidateId: number) {
  const candidate = db
    .prepare("SELECT * FROM search_candidates WHERE id = ?")
    .get(candidateId);
  if (!candidate) throw new ApiError("NOT_FOUND", `candidate ${candidateId} not found`, 404);
  const occurrences = db
    .prepare(
      `SELECT protein_id AS proteinId, accession, sequence_version_id AS sequenceVersionId,
              start, "end" FROM candidate_occurrences WHERE candidate_id = ? ORDER BY accession, start`,
    )
    .all(candidateId);
  const peakMatches = db
    .prepare(
      `SELECT peak_index AS peakIndex, observed_mz AS observedMz, intensity,
              ion_series AS ionSeries, ion_number AS ionNumber, ion_charge AS ionCharge,
              theoretical_mz AS theoreticalMz, error_da AS errorDa, error_ppm AS errorPpm
       FROM peak_matches WHERE candidate_id = ? ORDER BY peak_index`,
    )
    .all(candidateId);
  return { candidate, occurrences, peakMatches };
}

/** Build (or return existing) immutable JSON report snapshot for a search. */
export function freezeReport(
  db: DatabaseSync,
  searchId: number,
  clientId: string,
  clock: Clock,
): { id: number; payload: unknown; reused: boolean } {
  const existing = db
    .prepare("SELECT id, payload FROM reports WHERE search_id = ?")
    .get(searchId) as { id: number; payload: string } | undefined;
  if (existing) return { id: existing.id, payload: JSON.parse(existing.payload), reused: true };
  const search = getSearch(db, searchId) as {
    clientId: string;
    createdAt: string;
    peaklistId: number;
    parameterSetId: number;
  };
  const peaklist = getPeaklist(db, search.peaklistId);
  const paramRow = getParameterSet(db, search.parameterSetId) as unknown as ParameterSetRow;
  const candidateCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM search_candidates WHERE search_id = ?")
      .get(searchId) as { c: number }
  ).c;
  const payload = {
    reportClientId: clientId,
    search: { id: searchId, clientId: search.clientId, createdAt: search.createdAt },
    peaklist,
    parameters: { id: paramRow.id, label: paramRow.label, match: paramsFromRow(paramRow) },
    candidateCount,
    candidates: serializeAllCandidates(db, searchId),
    frozenAt: clock.now().toISOString(),
  };
  const result = db
    .prepare("INSERT INTO reports (search_id, client_id, payload, created_at) VALUES (?, ?, ?, ?)")
    .run(searchId, clientId, JSON.stringify(payload), clock.now().toISOString());
  return { id: Number(result.lastInsertRowid), payload, reused: false };
}

function serializeAllCandidates(db: DatabaseSync, searchId: number) {
  const rows = db
    .prepare("SELECT id FROM search_candidates WHERE search_id = ? ORDER BY rank")
    .all(searchId) as Array<{ id: number }>;
  return rows.map((row) => explainCandidate(db, row.id));
}
