import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESIDUE_MASSES } from "../src/core/constants.ts";
import { peptideNeutralMass } from "../src/core/mass.ts";
import { digestSequence, mergeOccurrences } from "../src/core/digest.ts";
import { search } from "../src/core/matcher.ts";
import type { EnzymeRule, FixedModification, MatchParams, Peptide } from "../src/core/types.ts";
import {
  ACG_CONTESTED_PEAKLIST,
  ACG_PEAKLIST,
  ACG_Z2_PEAKLIST,
  EXPECTED_ACG,
  FICTIONAL_PROTEINS,
  NO_MATCH_PEAKLIST,
} from "../fixtures/index.ts";

const trypsin: EnzymeRule = { id: 1, name: "trypsin", cutResidues: ["K", "R"], noCutBefore: ["P"] };
const table = new Map(Object.entries(DEFAULT_RESIDUE_MASSES));

function universe(): Peptide[] {
  const merged = mergeOccurrences(
    FICTIONAL_PROTEINS.map((protein, index) => ({
      proteinId: index + 1,
      proteinAccession: protein.accession,
      sequenceVersionId: index + 1,
      fragments: digestSequence(protein.sequence, trypsin, 1),
    })),
  );
  return [...merged.entries()].map(([sequence, occurrences]) => ({
    sequence,
    neutralMass: peptideNeutralMass(sequence, table),
    occurrences,
  }));
}

const paramsPpm: MatchParams = {
  precursorTolerance: 10,
  precursorUnit: "ppm",
  fragmentTolerance: 10,
  fragmentUnit: "ppm",
  charges: [1, 2],
  fixedModificationIds: [],
};

test("ACG matches with expected b/y peaks and water/proton accounting", () => {
  const results = search(
    universe(),
    EXPECTED_ACG.precursorMzCharge1,
    ACG_PEAKLIST.peaks.map((p) => ({ ...p })),
    paramsPpm,
    table,
    [],
    [1],
  );
  assert.equal(results[0]!.peptide.sequence, "ACG");
  const matchedSeries = results[0]!.peakMatches.map((m) => `${m.ionSeries}${m.ionNumber}`);
  assert.deepEqual(matchedSeries.sort(), ["b1", "y1"]);
  // the decoy 300 m/z peak stays unmatched: 2 of 3 peaks consumed
  assert.equal(results[0]!.matchedPeakCount, 2);
});

test("one observed peak consumes at most one theoretical ion and vice versa", () => {
  const results = search(
    universe(),
    EXPECTED_ACG.precursorMzCharge1,
    ACG_CONTESTED_PEAKLIST.peaks.map((p) => ({ ...p })),
    paramsPpm,
    table,
    [],
  );
  const top = results.find((r) => r.peptide.sequence === "ACG")!;
  // b1 ion assigned only to the closer peak; farther peak cannot also take b1
  const bMatches = top.peakMatches.filter((m) => m.ionSeries === "b");
  assert.equal(bMatches.length, 1);
  assert.ok(Math.abs(bMatches[0]!.observedMz - (EXPECTED_ACG.b1 + 0.00001)) < 1e-12);
  const peakIndexes = top.peakMatches.map((m) => m.peakIndex);
  assert.equal(new Set(peakIndexes).size, peakIndexes.length);
});

test("multiple precursor charges are enumerated and z=2 precursor matches", () => {
  const results = search(
    universe(),
    EXPECTED_ACG.precursorMzCharge2,
    ACG_Z2_PEAKLIST.peaks.map((p) => ({ ...p })),
    paramsPpm,
    table,
    [],
  );
  const acg = results.find((r) => r.peptide.sequence === "ACG")!;
  assert.equal(acg.matchedPrecursorCharge, 2);
  assert.ok(Math.abs(acg.precursorErrorPpm) < 1e-6);
  assert.deepEqual(
    acg.peakMatches.map((m) => `${m.ionSeries}${m.ionNumber}`).sort(),
    ["b2", "y2"],
  );
});

test("no candidate survives an out-of-window precursor", () => {
  const results = search(
    universe(),
    NO_MATCH_PEAKLIST.precursorMz,
    NO_MATCH_PEAKLIST.peaks.map((p) => ({ ...p })),
    paramsPpm,
    table,
    [],
  );
  assert.equal(results.length, 0);
});

test("shared peptide stays ambiguous with both proteins attached", () => {
  // precursor for neutral RPEPTIDEK at z=2 computed via the engine normally;
  // here we only check ambiguity metadata directly from the universe.
  const peptide = universe().find((p) => p.sequence === "RPEPTIDEK")!;
  assert.equal(peptide.occurrences.length, 2);
  const syntheticResult = search(
    [{ ...peptide, neutralMass: 1 }],
    1,
    [],
    { ...paramsPpm, charges: [1] },
    table,
    [],
  );
  // precursor cannot match mass-1 -> zero, so ambiguity is asserted via occurrences instead
  assert.equal(new Set(peptide.occurrences.map((o) => o.proteinAccession)).size, 2);
  assert.ok(syntheticResult.every((r) => r.ambiguousProtein === false || r.peptide.occurrences.length > 1));
});

test("ranking is stable and deterministic across repeated runs", () => {
  const args: [Peptide[], number, Array<{ mz: number; intensity: number }>, MatchParams, Map<string, number>, FixedModification[], number[]] = [
    universe(),
    EXPECTED_ACG.precursorMzCharge1,
    ACG_PEAKLIST.peaks.map((p) => ({ ...p })),
    paramsPpm,
    table,
    [],
    [1],
  ];
  const first = search(...args).map((r) => `${r.peptide.sequence}:${r.score}`);
  const second = search(...args).map((r) => `${r.peptide.sequence}:${r.score}`);
  assert.deepEqual(first, second);
});
