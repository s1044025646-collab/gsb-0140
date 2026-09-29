import { digest, type EnzymeRule, type Peptide } from "../domain/digestion.js";
import { neutralMass, precursorMz, ppmError, toleranceToDa } from "../domain/mass.js";
import { theoreticalSpectrum, type Ion } from "../domain/ions.js";

export interface ProteinSource {
  proteinId: number;
  accession: string;
  sequence: string;
}

export interface SearchParameters {
  enzyme: EnzymeRule;
  massTable: Record<string, number>;
  modificationDeltas: Record<string, number>;
  maxMissedCleavages: number;
  precursorCharge: number;
  precursorTolerance: number;
  precursorToleranceUnit: "ppm" | "da";
  fragmentTolerance: number;
  fragmentToleranceUnit: "ppm" | "da";
  fragmentCharges: number[];
}

export interface ObservedPeak {
  peakId: number;
  peakIndex: number;
  mz: number;
  intensity: number;
}

export interface PeakAssignment {
  peakId: number;
  peakIndex: number;
  observedMz: number;
  ion: Ion;
  theoreticalMz: number;
  errorPpm: number;
  errorDa: number;
}

export interface CandidateMatch {
  peptide: Peptide;
  sources: { proteinId: number; accession: string; start: number; end: number }[];
  neutralMass: number;
  precursorMzTheoretical: number;
  precursorErrorPpm: number;
  charge: number;
  assignments: PeakAssignment[];
  matchedFragments: number;
  totalFragments: number;
  fragmentCoverage: number;
  score: number;
  ambiguousGroup?: number;
}

/**
 * Digest every source protein and index each distinct peptide sequence to
 * every (protein, location) it appears in. Shared peptides keep multiple
 * sources and the ambiguity is preserved.
 */
export function indexPeptides(
  proteins: ProteinSource[],
  params: SearchParameters
): Map<string, { peptide: Peptide; sources: CandidateMatch["sources"] }> {
  const index = new Map<string, { peptide: Peptide; sources: CandidateMatch["sources"] }>();
  for (const protein of proteins) {
    const peptides = digest(protein.sequence, params.enzyme, params.maxMissedCleavages);
    for (const peptide of peptides) {
      const existing = index.get(peptide.sequence);
      const source = {
        proteinId: protein.proteinId,
        accession: protein.accession,
        start: peptide.start,
        end: peptide.end,
      };
      if (existing) {
        existing.sources.push(source);
      } else {
        index.set(peptide.sequence, { peptide, sources: [source] });
      }
    }
  }
  return index;
}

/**
 * One-to-one assignment between observed peaks and theoretical ions.
 *
 * One observed peak matches at most one theoretical ion per peptide scoring
 * and vice versa. Candidate pairs within fragment tolerance are resolved by
 * a global greedy in increasing absolute error; ties break by peak index
 * then a fixed ion order (the order generated: b then y, ascending number
 * and charge). The result is deterministic.
 */
export function assignFragments(
  peaks: ObservedPeak[],
  ions: Ion[],
  tolerance: number,
  unit: "ppm" | "da"
): PeakAssignment[] {
  interface Candidate {
    peak: ObservedPeak;
    ion: Ion;
    errorDa: number;
    errorPpm: number;
    ionOrder: number;
  }
  const candidates: Candidate[] = [];

  ions.forEach((ion, ionIdx) => {
    const tolDa = toleranceToDa(tolerance, unit, ion.mz);
    for (const peak of peaks) {
      const errDa = peak.mz - ion.mz;
      const eps = Math.max(Number.EPSILON, ion.mz * 1e-12);
      if (Math.abs(errDa) <= tolDa + eps) {
        candidates.push({
          peak,
          ion,
          errorDa: errDa,
          errorPpm: ppmError(peak.mz, ion.mz),
          ionOrder: ionIdx,
        });
      }
    }
  });

  candidates.sort((a, b) => {
    if (Math.abs(a.errorDa) !== Math.abs(b.errorDa)) {
      return Math.abs(a.errorDa) - Math.abs(b.errorDa);
    }
    if (a.peak.peakIndex !== b.peak.peakIndex) return a.peak.peakIndex - b.peak.peakIndex;
    return a.ionOrder - b.ionOrder;
  });

  const usedPeaks = new Set<number>();
  const usedIons = new Set<string>();
  const assignments: PeakAssignment[] = [];
  for (const c of candidates) {
    if (usedPeaks.has(c.peak.peakId)) continue;
    const ionKey = `${c.ion.type}${c.ion.number}_z${c.ion.charge}`;
    if (usedIons.has(ionKey)) continue;
    usedPeaks.add(c.peak.peakId);
    usedIons.add(ionKey);
    assignments.push({
      peakId: c.peak.peakId,
      peakIndex: c.peak.peakIndex,
      observedMz: c.peak.mz,
      ion: c.ion,
      theoreticalMz: c.ion.mz,
      errorPpm: c.errorPpm,
      errorDa: c.errorDa,
    });
  }
  assignments.sort((a, b) => a.peakIndex - b.peakIndex);
  return assignments;
}

/**
 * Run the full candidate search. Returns matches ranked deterministically.
 *
 * Ranking: matched fragment count desc, fragment coverage desc, then
 * |precursor ppm| asc, then peptide sequence asc. Identical scores retain
 * their ambiguity and are never collapsed to a single protein.
 */
export function searchCandidates(
  proteins: ProteinSource[],
  peaks: ObservedPeak[],
  observedPrecursorMz: number,
  params: SearchParameters
): CandidateMatch[] {
  const index = indexPeptides(proteins, params);
  const matches: CandidateMatch[] = [];

  for (const [, entry] of index) {
    const { peptide, sources } = entry;
    let neutral: number;
    try {
      neutral = neutralMass(peptide.sequence, params.massTable, params.modificationDeltas);
    } catch {
      continue;
    }
    const precursorTheoretical = precursorMz(neutral, params.precursorCharge);
    const precTolDa = toleranceToDa(
      params.precursorTolerance,
      params.precursorToleranceUnit,
      precursorTheoretical
    );
    const precEps = Math.max(Number.EPSILON, precursorTheoretical * 1e-12);
    if (Math.abs(observedPrecursorMz - precursorTheoretical) > precTolDa + precEps) {
      continue;
    }

    const ions: Ion[] = [];
    for (const z of params.fragmentCharges) {
      ions.push(
        ...theoreticalSpectrum(peptide.sequence, z, params.massTable, params.modificationDeltas)
      );
    }
    const assignments = assignFragments(
      peaks,
      ions,
      params.fragmentTolerance,
      params.fragmentToleranceUnit
    );
    const totalFragments = ions.length;
    const matchedFragments = assignments.length;
    const fragmentCoverage = totalFragments > 0 ? matchedFragments / totalFragments : 0;
    const score = matchedFragments + fragmentCoverage;

    matches.push({
      peptide,
      sources,
      neutralMass: neutral,
      precursorMzTheoretical: precursorTheoretical,
      precursorErrorPpm: ppmError(observedPrecursorMz, precursorTheoretical),
      charge: params.precursorCharge,
      assignments,
      matchedFragments,
      totalFragments,
      fragmentCoverage,
      score,
    });
  }

  matches.sort((a, b) => {
    if (b.matchedFragments !== a.matchedFragments)
      return b.matchedFragments - a.matchedFragments;
    if (b.fragmentCoverage !== a.fragmentCoverage)
      return b.fragmentCoverage - a.fragmentCoverage;
    const aErr = Math.abs(ppmError(observedPrecursorMz, a.precursorMzTheoretical));
    const bErr = Math.abs(ppmError(observedPrecursorMz, b.precursorMzTheoretical));
    if (aErr !== bErr) return aErr - bErr;
    return a.peptide.sequence.localeCompare(b.peptide.sequence);
  });
  annotateAmbiguity(matches);
  return matches;
}

/**
 * Tag candidates that are not uniquely assignable: either the peptide
 * sequence appears in multiple source proteins/locations, or the candidate
 * is tied on score with an adjacent candidate in the ranking.
 */
export function annotateAmbiguity(matches: CandidateMatch[]): void {
  for (let i = 0; i < matches.length; i++) {
    const multiSource = matches[i].sources.length > 1;
    const tiedPrev =
      i > 0 &&
      matches[i - 1].matchedFragments === matches[i].matchedFragments &&
      matches[i - 1].score === matches[i].score;
    const tiedNext =
      i + 1 < matches.length &&
      matches[i + 1].matchedFragments === matches[i].matchedFragments &&
      matches[i + 1].score === matches[i].score;
    if (multiSource || tiedPrev || tiedNext) {
      let g = i;
      if (tiedPrev) {
        let j = i - 1;
        while (
          j >= 0 &&
          matches[j].matchedFragments === matches[i].matchedFragments &&
          matches[j].score === matches[i].score
        ) {
          g = j;
          j--;
        }
      }
      matches[i].ambiguousGroup = g;
    }
  }
}
