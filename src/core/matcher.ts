import {
  mzErrorDa,
  mzErrorPpm,
  peptideNeutralMass,
  precursorMz,
  toleranceWindow,
  withinTolerance,
} from "./mass.ts";
import { theoreticalSpectrum } from "./spectrum.ts";
export { UnknownResidueError } from "./mass.ts";
import type {
  CandidateMatch,
  FixedModification,
  MatchParams,
  ObservedPeak,
  PeakMatch,
  Peptide,
} from "./types.ts";

/**
 * Enforce that ppm and Da tolerances are never mixed inside one search.
 */
export function validateMatchParams(params: MatchParams): void {
  if (params.precursorUnit !== params.fragmentUnit) {
    throw new MixedToleranceUnitError(
      `precursor unit "${params.precursorUnit}" and fragment unit "${params.fragmentUnit}" must be identical`,
    );
  }
  for (const [name, value] of [
    ["precursorTolerance", params.precursorTolerance],
    ["fragmentTolerance", params.fragmentTolerance],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a finite non-negative number`);
    }
  }
  if (params.charges.length === 0) {
    throw new Error("at least one precursor charge is required");
  }
  for (const charge of params.charges) {
    if (!Number.isInteger(charge) || charge < 1) {
      throw new Error("charges must be positive integers");
    }
  }
}

export class MixedToleranceUnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MixedToleranceUnitError";
  }
}

export interface PrecursorCandidate {
  peptide: Peptide;
  charge: number;
  precursorMz: number;
}

/**
 * Filter peptides whose protonated precursor (for any allowed charge) lies
 * inside the precursor tolerance window of the observed precursor m/z.
 */
export function filterByPrecursor(
  peptides: Peptide[],
  observedPrecursorMz: number,
  params: MatchParams,
  residueMassTable: Map<string, number>,
  fixedMods: FixedModification[],
): PrecursorCandidate[] {
  const out: PrecursorCandidate[] = [];
  for (const peptide of peptides) {
    const neutral = peptideNeutralMass(
      peptide.sequence,
      residueMassTable,
      fixedMods,
    );
    for (const charge of params.charges) {
      const theoretical = precursorMz(neutral, charge);
      if (
        withinTolerance(
          observedPrecursorMz,
          theoretical,
          params.precursorTolerance,
          params.precursorUnit,
        )
      ) {
        out.push({ peptide, charge, precursorMz: theoretical });
      }
    }
  }
  return out;
}

/**
 * Greedy, deterministic one-to-one assignment between observed peaks and
 * theoretical fragment ions.
 *
 * Each observed peak can match at most one theoretical ion and each
 * theoretical (series, number, charge) ion at most one peak. Candidates for
 * the same pair are considered globally and the closest error (Da) pair is
 * committed first, so the assignment is stable and unambiguous about ties:
 * equal-error pairs keep a deterministic order (peak index, then series/
 * number/charge) and only one is chosen, with the loser left unmatched.
 */
export function assignPeaks(
  peaks: ObservedPeak[],
  peptideSequence: string,
  params: MatchParams,
  residueMassTable: Map<string, number>,
  fixedMods: FixedModification[],
  fragmentCharges: number[],
): PeakMatch[] {
  const ions = theoreticalSpectrum(
    peptideSequence,
    residueMassTable,
    fixedMods,
    fragmentCharges,
  );

  interface Edge {
    peakIndex: number;
    ionIndex: number;
    observedMz: number;
    intensity: number;
    theoreticalMz: number;
    errorDa: number;
  }
  const edges: Edge[] = [];
  peaks.forEach((peak, peakIndex) => {
    ions.forEach((ion, ionIndex) => {
      if (
        withinTolerance(
          peak.mz,
          ion.mz,
          params.fragmentTolerance,
          params.fragmentUnit,
        )
      ) {
        edges.push({
          peakIndex,
          ionIndex,
          observedMz: peak.mz,
          intensity: peak.intensity,
          theoreticalMz: ion.mz,
          errorDa: Math.abs(mzErrorDa(peak.mz, ion.mz)),
        });
      }
    });
  });

  edges.sort((a, b) => {
    if (a.errorDa !== b.errorDa) return a.errorDa - b.errorDa;
    if (a.peakIndex !== b.peakIndex) return a.peakIndex - b.peakIndex;
    const ia = ions[a.ionIndex]!;
    const ib = ions[b.ionIndex]!;
    if (ia.series !== ib.series) return ia.series < ib.series ? -1 : 1;
    if (ia.number !== ib.number) return ia.number - ib.number;
    return a.ionIndex - b.ionIndex;
  });

  const usedPeaks = new Set<number>();
  const usedIons = new Set<number>();
  const matches: PeakMatch[] = [];
  for (const edge of edges) {
    if (usedPeaks.has(edge.peakIndex) || usedIons.has(edge.ionIndex)) continue;
    usedPeaks.add(edge.peakIndex);
    usedIons.add(edge.ionIndex);
    const ion = ions[edge.ionIndex]!;
    matches.push({
      peakIndex: edge.peakIndex,
      observedMz: edge.observedMz,
      intensity: edge.intensity,
      ionSeries: ion.series,
      ionNumber: ion.number,
      theoreticalMz: edge.theoreticalMz,
      charge: ion.charge,
      errorDa: mzErrorDa(edge.observedMz, edge.theoreticalMz),
      errorPpm: mzErrorPpm(edge.observedMz, edge.theoreticalMz),
    });
  }
  matches.sort((a, b) => a.peakIndex - b.peakIndex);
  return matches;
}

/**
 * Full search: precursor filter -> peak assignment -> deterministic ranking.
 * Rank key: matched peak count desc, matched intensity desc, precursor
 * |error ppm| asc, peptide sequence asc. The last key makes ordering total
 * and reproducible. Equal-score peptides are all retained (shared peptides
 * stay ambiguous).
 */
export function search(
  peptides: Peptide[],
  precursorMzObserved: number,
  peaks: ObservedPeak[],
  params: MatchParams,
  residueMassTable: Map<string, number>,
  fixedMods: FixedModification[],
  fragmentCharges = [1],
): CandidateMatch[] {
  validateMatchParams(params);
  const candidates = filterByPrecursor(
    peptides,
    precursorMzObserved,
    params,
    residueMassTable,
    fixedMods,
  );
  const results: CandidateMatch[] = [];
  for (const candidate of candidates) {
    const peakMatches = assignPeaks(
      peaks,
      candidate.peptide.sequence,
      params,
      residueMassTable,
      fixedMods,
      fragmentCharges,
    );
    const totalIntensityMatched = peakMatches.reduce(
      (sum, match) => sum + match.intensity,
      0,
    );
    results.push({
      peptide: candidate.peptide,
      matchedPrecursorCharge: candidate.charge,
      precursorMz: candidate.precursorMz,
      precursorErrorDa: mzErrorDa(precursorMzObserved, candidate.precursorMz),
      precursorErrorPpm: mzErrorPpm(precursorMzObserved, candidate.precursorMz),
      peakMatches,
      score: scoreCandidates(peakMatches.length, totalIntensityMatched),
      matchedPeakCount: peakMatches.length,
      totalIntensityMatched,
      ambiguousProtein: candidate.peptide.occurrences.length > 1,
    });
  }
  results.sort((a, b) => {
    if (b.matchedPeakCount !== a.matchedPeakCount) {
      return b.matchedPeakCount - a.matchedPeakCount;
    }
    if (b.totalIntensityMatched !== a.totalIntensityMatched) {
      return b.totalIntensityMatched - a.totalIntensityMatched;
    }
    if (Math.abs(b.precursorErrorPpm) !== Math.abs(a.precursorErrorPpm)) {
      return Math.abs(a.precursorErrorPpm) - Math.abs(b.precursorErrorPpm);
    }
    return a.peptide.sequence.localeCompare(b.peptide.sequence);
  });
  return results;
}

/** Simple, explicit score: 10 points per matched peak + matched intensity. */
export function scoreCandidates(
  matchedPeakCount: number,
  totalIntensityMatched: number,
): number {
  return matchedPeakCount * 10 + totalIntensityMatched;
}

export { toleranceWindow };
