import type { EnzymeRule, PeptideOccurrence } from "./types.ts";

/**
 * Cleavage-site positions for a sequence under an enzyme rule.
 * Each returned position j (1..length) is a peptide END (exclusive index):
 * trypsin cleaves on the C-terminal side of K/R, i.e. after residue j-1,
 * blocked when residue j is P. j === length represents the chain end, which
 * always terminates the final peptide.
 */
export function cleavageSites(sequence: string, enzyme: EnzymeRule): number[] {
  const cuts = new Set(enzyme.cutResidues);
  const blocked = new Set(enzyme.noCutBefore);
  const ends: number[] = [];
  for (let j = 1; j < sequence.length; j++) {
    if (!cuts.has(sequence[j - 1]!)) continue;
    if (blocked.has(sequence[j]!)) continue;
    ends.push(j);
  }
  ends.push(sequence.length);
  return ends;
}

export interface DigestFragment {
  sequence: string;
  /** 1-based inclusive positions within the digested protein sequence. */
  start: number;
  end: number;
  missedCleavages: number;
}

/**
 * Enumerate peptides with 0..maxMissedCleavages missed cleavages.
 * Boundaries are the cleavage sites plus implicit ends (-1 and length-1).
 */
export function digestSequence(
  sequence: string,
  enzyme: EnzymeRule,
  maxMissedCleavages: number,
): DigestFragment[] {
  if (maxMissedCleavages < 0 || !Number.isInteger(maxMissedCleavages)) {
    throw new Error("maxMissedCleavages must be a non-negative integer");
  }
  const ends = cleavageSites(sequence, enzyme);
  // Start positions of zero-missed peptides derived from consecutive ends.
  const starts = [0, ...ends.slice(0, -1)];
  const fragments: DigestFragment[] = [];
  // A peptide spanning `missed+1` segments contains `missed` internal cuts.
  for (let missed = 0; missed <= maxMissedCleavages; missed++) {
    for (let i = 0; i + missed < ends.length; i++) {
      const start0 = starts[i]!;
      const endExclusive = ends[i + missed]!;
      fragments.push({
        sequence: sequence.slice(start0, endExclusive),
        start: start0 + 1,
        end: endExclusive,
        missedCleavages: missed,
      });
    }
  }
  return fragments;
}

/** Merge same-sequence fragments across proteins, keeping every occurrence. */
export function mergeOccurrences(
  fragmentsByProtein: Array<{
    proteinId: number;
    proteinAccession: string;
    sequenceVersionId: number;
    fragments: DigestFragment[];
  }>,
): Map<string, PeptideOccurrence[]> {
  const merged = new Map<string, PeptideOccurrence[]>();
  for (const source of fragmentsByProtein) {
    for (const fragment of source.fragments) {
      const list = merged.get(fragment.sequence) ?? [];
      list.push({
        proteinId: source.proteinId,
        proteinAccession: source.proteinAccession,
        sequenceVersionId: source.sequenceVersionId,
        start: fragment.start,
        end: fragment.end,
      });
      merged.set(fragment.sequence, list);
    }
  }
  return merged;
}
