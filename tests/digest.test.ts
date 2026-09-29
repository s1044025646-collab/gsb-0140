import assert from "node:assert/strict";
import { test } from "node:test";
import { cleavageSites, digestSequence, mergeOccurrences } from "../src/core/digest.ts";
import type { EnzymeRule } from "../src/core/types.ts";

const trypsin: EnzymeRule = {
  id: 1,
  name: "trypsin",
  cutResidues: ["K", "R"],
  noCutBefore: ["P"],
};

test("cuts after terminal K/R and skips chain-end pseudo sites", () => {
  // ends: after K4 -> 4, after K13 -> 13, chain end -> 14 (R5 blocked by P)
  assert.deepEqual(cleavageSites("MACKRPEPTIDEKR", trypsin), [4, 13, 14]);
});

test("KP/RP exception blocks cleavage", () => {
  // no internal cuts; only the implicit chain end remains
  assert.deepEqual(cleavageSites("AKPB", trypsin), [4]);
  assert.deepEqual(cleavageSites("ARPB", trypsin), [4]);
  // blocked site means the sequence is one undivided peptide
  assert.deepEqual(digestSequence("AKPB", trypsin, 0).map((f) => f.sequence), ["AKPB"]);
  assert.deepEqual(digestSequence("ARPB", trypsin, 0).map((f) => f.sequence), ["ARPB"]);
  // each K terminates a peptide; the lone final B is the C-terminal peptide.
  assert.deepEqual(cleavageSites("AKKB", trypsin), [2, 3, 4]);
});

test("consecutive cleavage sites yield single-residue peptides", () => {
  // "AKRB": ends after K, after R, and the chain end
  const fragments = digestSequence("AKRB", trypsin, 0).map((f) => f.sequence);
  assert.deepEqual(fragments, ["AK", "R", "B"]);
});

test("0-missed digestion keeps 1-based source positions", () => {
  const fragments = digestSequence("MACKRPEPTIDEKR", trypsin, 0);
  assert.deepEqual(
    fragments.map((f) => [f.sequence, f.start, f.end]),
    [
      ["MACK", 1, 4],
      ["RPEPTIDEK", 5, 13],
      ["R", 14, 14],
    ],
  );
});

test("missed cleavages are bounded and enumerated with correct span", () => {
  const zero = digestSequence("AKRB", trypsin, 0);
  const one = digestSequence("AKRB", trypsin, 1);
  assert.ok(zero.every((f) => f.missedCleavages === 0));
  const oneMiss = one.filter((f) => f.missedCleavages === 1).map((f) => f.sequence);
  assert.deepEqual(oneMiss, ["AKR", "RB"]);
  const two = digestSequence("AKRB", trypsin, 2)
    .filter((f) => f.missedCleavages === 2)
    .map((f) => f.sequence);
  assert.deepEqual(two, ["AKRB"]);
});

test("shared peptides merge while preserving every protein occurrence", () => {
  const merged = mergeOccurrences([
    {
      proteinId: 1,
      proteinAccession: "FIX_A",
      sequenceVersionId: 10,
      fragments: digestSequence("MACKRPEPTIDEKR", trypsin, 0),
    },
    {
      proteinId: 2,
      proteinAccession: "FIX_B",
      sequenceVersionId: 20,
      fragments: digestSequence("KRPEPTIDEKQAK", trypsin, 0),
    },
  ]);
  const shared = merged.get("RPEPTIDEK")!;
  assert.equal(shared.length, 2);
  assert.deepEqual(
    shared.map((o) => [o.proteinAccession, o.start, o.end]),
    [
      ["FIX_A", 5, 13],
      ["FIX_B", 2, 10],
    ],
  );
});
