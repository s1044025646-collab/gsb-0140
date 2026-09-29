/** Shared domain types. All masses are monoisotopic and expressed in daltons (Da). */

export type ToleranceUnit = "ppm" | "da";

export interface ResidueMass {
  /** Single-letter amino acid code, upper case. */
  residue: string;
  /** Residue (residue-only, i.e. amino acid minus H2O) monoisotopic mass in Da. */
  residueMass: number;
}

export interface DigestRequest {
  sequence: string;
  /** Enzyme cleavage regex encoded as rule object. */
  enzyme: EnzymeRule;
  maxMissedCleavages: number;
}

export interface EnzymeRule {
  id: number;
  name: string;
  /**
   * Cleavage C-terminal to any residue in `cutResidues`, blocked when the
   * following residue is in `noCutBefore`. Trypsin: cut K/R, no-cut-before P.
   */
  cutResidues: string[];
  noCutBefore: string[];
}

export interface PeptideOccurrence {
  proteinId: number;
  proteinAccession: string;
  sequenceVersionId: number;
  /** 1-based inclusive position of the peptide within the protein sequence. */
  start: number;
  end: number;
}

export interface Peptide {
  sequence: string;
  /** Neutral monoisotopic peptide mass including H2O termini (Da). */
  neutralMass: number;
  occurrences: PeptideOccurrence[];
}

export interface FixedModification {
  id: number;
  name: string;
  residue: string;
  /** Mass shift added once per occurrence of the target residue (Da). */
  massShift: number;
}

export interface TheoreticalIon {
  series: "b" | "y";
  /** Fragment number, 1..n-1. */
  number: number;
  /** Ion charge state. */
  charge: number;
  /** Neutral mass of the fragment (b: sum residues + H; y: sum residues + H2O + H). */
  neutralMass: number;
  /** m/z for the ion with no extra protons beyond its single charging proton. */
  mz: number;
}

export interface ObservedPeak {
  mz: number;
  intensity: number;
}

export interface MatchParams {
  precursorTolerance: number;
  precursorUnit: ToleranceUnit;
  fragmentTolerance: number;
  fragmentUnit: ToleranceUnit;
  charges: number[];
  fixedModificationIds: number[];
}

export interface PeakMatch {
  peakIndex: number;
  observedMz: number;
  intensity: number;
  ionSeries: "b" | "y";
  ionNumber: number;
  theoreticalMz: number;
  charge: number;
  errorDa: number;
  errorPpm: number;
}

export interface CandidateMatch {
  peptide: Peptide;
  matchedPrecursorCharge: number;
  precursorMz: number;
  precursorErrorDa: number;
  precursorErrorPpm: number;
  peakMatches: PeakMatch[];
  score: number;
  matchedPeakCount: number;
  totalIntensityMatched: number;
  /**
   * Peptide sequence shared by more than one source protein is ambiguous:
   * every candidate keeps the full occurrence list; the report never collapses
   * that to a single protein.
   */
  ambiguousProtein: boolean;
}
