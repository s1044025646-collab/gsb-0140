export interface EnzymeRule {
  name: string;
  /** residues after which cleavage occurs, e.g. ["K","R"] for trypsin */
  cleaveAfter: string[];
  /**
   * If the residue immediately following a cleavage residue equals this
   * residue, cleavage is suppressed (e.g. "P" -> KP/RP exception).
   * Use "" when there is no exception.
   */
  exceptionResidue: string;
}

export const TRYPSIN: EnzymeRule = {
  name: "trypsin",
  cleaveAfter: ["K", "R"],
  exceptionResidue: "P",
};

export interface Peptide {
  sequence: string;
  /** 1-based inclusive positions within the source protein */
  start: number;
  end: number;
  /** number of cleavage sites inside the peptide that were missed */
  missedCleavages: number;
}

/**
 * Determine whether the enzyme cleaves between residue index i and i+1
 * (0-based). Returns true when position i is a cleavage residue and the
 * next position is not the exception residue.
 */
export function isCleavageSite(
  sequence: string,
  i: number,
  enzyme: EnzymeRule
): boolean {
  if (i < 0 || i >= sequence.length - 1) return false;
  const res = sequence[i];
  if (!enzyme.cleaveAfter.includes(res)) return false;
  if (enzyme.exceptionResidue && sequence[i + 1] === enzyme.exceptionResidue) {
    return false;
  }
  return true;
}

/**
 * Return the 0-based residue indices after which cleavage occurs.
 */
export function cleavageSites(sequence: string, enzyme: EnzymeRule): number[] {
  const sites: number[] = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    if (isCleavageSite(sequence, i, enzyme)) sites.push(i);
  }
  return sites;
}

/**
 * Enumerate all peptides produced by digesting a protein with the given
 * enzyme, allowing up to `maxMissedCleavages` missed cleavage sites.
 *
 * Each peptide carries its 1-based inclusive start/end positions within
 * the source sequence.
 */
export function digest(
  sequence: string,
  enzyme: EnzymeRule = TRYPSIN,
  maxMissedCleavages: number = 0
): Peptide[] {
  if (maxMissedCleavages < 0 || !Number.isInteger(maxMissedCleavages)) {
    throw new Error("maxMissedCleavages must be a non-negative integer");
  }
  const seq = sequence.toUpperCase();
  const sites = cleavageSites(seq, enzyme);

  // boundaries: start offsets are 0 and (site+1); end offsets are site and n
  const starts = [0, ...sites.map((s) => s + 1)];
  const ends = [...sites, seq.length - 1];

  const peptides: Peptide[] = [];
  for (let si = 0; si < starts.length; si++) {
    for (let ei = si; ei < ends.length; ei++) {
      const start = starts[si];
      const end = ends[ei];
      if (end < start) continue;
      // missed cleavages = cleavage sites strictly inside [start, end)
      const missed = sites.filter((c) => c >= start && c < end).length;
      if (missed > maxMissedCleavages) continue;
      peptides.push({
        sequence: seq.slice(start, end + 1),
        start: start + 1,
        end: end + 1,
        missedCleavages: missed,
      });
    }
  }
  return peptides;
}

/**
 * Validate that a sequence contains only standard amino acid letters.
 */
export function validateSequence(sequence: string): string[] {
  const allowed = new Set([
    "A","R","N","D","C","Q","E","G","H","I","L","K","M","F","P","S","T","W","Y","V",
  ]);
  const errors: string[] = [];
  const upper = sequence.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    if (!allowed.has(upper[i])) {
      errors.push(`Invalid residue '${upper[i]}' at position ${i + 1}`);
    }
  }
  return errors;
}
