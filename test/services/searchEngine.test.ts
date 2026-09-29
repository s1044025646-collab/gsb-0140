import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchCandidates,
  assignFragments,
  indexPeptides,
  type SearchParameters,
  type ObservedPeak,
  type ProteinSource,
} from "../../src/services/searchEngine.js";
import { TRYPSIN } from "../../src/domain/digestion.js";
import { DEFAULT_RESIDUE_MASSES } from "../../src/domain/constants.js";
import { neutralMass, precursorMz } from "../../src/domain/mass.js";
import { theoreticalSpectrum } from "../../src/domain/ions.js";

const proteins: ProteinSource[] = [
  { proteinId: 1, accession: "FAKE_ALPHA", sequence: "GKAAGK" },
  { proteinId: 2, accession: "FAKE_BETA", sequence: "LKAAGKR" },
];

function params(overrides: Partial<SearchParameters> = {}): SearchParameters {
  return {
    enzyme: TRYPSIN,
    massTable: DEFAULT_RESIDUE_MASSES,
    modificationDeltas: {},
    maxMissedCleavages: 1,
    precursorCharge: 2,
    precursorTolerance: 20,
    precursorToleranceUnit: "ppm",
    fragmentTolerance: 20,
    fragmentToleranceUnit: "ppm",
    fragmentCharges: [1],
    ...overrides,
  };
}

function spectrumPeaks(peptide: string): ObservedPeak[] {
  return theoreticalSpectrum(peptide, 1, DEFAULT_RESIDUE_MASSES).map((ion, i) => ({
    peakId: i + 1,
    peakIndex: i,
    mz: ion.mz,
    intensity: 100,
  }));
}

test("shared peptide AAGK is indexed to both proteins with source positions", () => {
  const index = indexPeptides(proteins, params());
  const entry = index.get("AAGK")!;
  assert.equal(entry.sources.length, 2);
  assert.deepEqual(
    entry.sources.map((s) => `${s.accession}:${s.start}-${s.end}`).sort(),
    ["FAKE_ALPHA:3-6", "FAKE_BETA:3-6"]
  );
});

test("search returns AAGK candidates and preserves ambiguous multi-protein sources", () => {
  const peptide = "AAGK";
  const m = neutralMass(peptide);
  const peaks = spectrumPeaks(peptide);
  const results = searchCandidates(proteins, peaks, precursorMz(m, 2), params());
  const aagk = results.filter((r) => r.peptide.sequence === "AAGK");
  assert.ok(aagk.length >= 1);
  assert.equal(aagk[0].sources.length, 2);
  // ambiguity must not collapse to one accession
  const accessions = new Set(aagk[0].sources.map((s) => s.accession));
  assert.equal(accessions.size, 2);
});

test("one observed peak is consumed at most once across co-eluting ions", () => {
  const peptide = "AAGK";
  const ions = theoreticalSpectrum(peptide, 1, DEFAULT_RESIDUE_MASSES);
  // Create two near-identical theoretical ions: duplicate the b1 ion at
  // charges that resolve to nearly the same mz is unrealistic, so instead
  // present a single observed peak matching two ions within tolerance by
  // widening tolerance.
  const b1 = ions.find((i) => i.type === "b" && i.number === 1)!;
  const y1 = ions.find((i) => i.type === "y" && i.number === 1)!;
  // craft a single peak sitting between b1 and y1 within a huge window
  const mid = (b1.mz + y1.mz) / 2;
  const peaks: ObservedPeak[] = [{ peakId: 1, peakIndex: 0, mz: mid, intensity: 1 }];
  const assignments = assignFragments(peaks, ions, 500_000, "ppm"); // huge tol
  assert.equal(assignments.length, 1, "single peak may only explain one ion");
});

test("each ion is used at most once even when peaks overlap", () => {
  const peptide = "AAGK";
  const ions = theoreticalSpectrum(peptide, 1, DEFAULT_RESIDUE_MASSES);
  const b1 = ions.find((i) => i.type === "b" && i.number === 1)!;
  // two peaks both within tolerance of b1 -> b1 assigned to only one
  const peaks: ObservedPeak[] = [
    { peakId: 1, peakIndex: 0, mz: b1.mz, intensity: 1 },
    { peakId: 2, peakIndex: 1, mz: b1.mz + 0.0000005, intensity: 1 },
  ];
  const assignments = assignFragments(peaks, ions, 50, "ppm");
  const b1Assignments = assignments.filter((a) => a.ion.type === "b" && a.ion.number === 1);
  assert.equal(b1Assignments.length, 1);
});

test("greedy assignment prefers the closest ion for a peak", () => {
  const peptide = "AAGK";
  const ions = theoreticalSpectrum(peptide, 1, DEFAULT_RESIDUE_MASSES);
  const b1 = ions.find((i) => i.type === "b" && i.number === 1)!;
  const b2 = ions.find((i) => i.type === "b" && i.number === 2)!;
  // pick a peak much closer to b1 than b2 (both inside a 1000ppm window)
  const peak = { peakId: 1, peakIndex: 0, mz: b1.mz + 0.001, intensity: 1 };
  const assignments = assignFragments([peak], ions, 1000, "ppm");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].ion.type, "b");
  assert.equal(assignments[0].ion.number, 1);
  assert.ok(Math.abs(b2.mz) > 0); // sanity reference
});

test("ranking is stable and deterministic across repeated runs", () => {
  const peptide = "AAGK";
  const peaks = spectrumPeaks(peptide);
  const m = neutralMass(peptide);
  const run1 = searchCandidates(proteins, peaks, precursorMz(m, 2), params()).map(
    (r) => `${r.peptide.sequence}:${r.score}`
  );
  const run2 = searchCandidates(proteins, peaks, precursorMz(m, 2), params()).map(
    (r) => `${r.peptide.sequence}:${r.score}`
  );
  assert.deepEqual(run1, run2);
  // best candidate has the most matched fragments
  assert.ok(run1[0].startsWith("AAGK"));
});

test("no candidates when precursor is far outside tolerance (no-match)", () => {
  const peaks = spectrumPeaks("AAGK");
  const results = searchCandidates(proteins, peaks, 999.999, params());
  assert.equal(results.length, 0);
});

test("multiple precursor charges produce different precursor m/z windows", () => {
  const m = neutralMass("AAGK");
  const peaks = spectrumPeaks("AAGK");
  const z1 = searchCandidates(proteins, peaks, precursorMz(m, 1), params({ precursorCharge: 1 }));
  const z2 = searchCandidates(proteins, peaks, precursorMz(m, 2), params({ precursorCharge: 2 }));
  assert.ok(z1.some((r) => r.peptide.sequence === "AAGK"));
  assert.ok(z2.some((r) => r.peptide.sequence === "AAGK"));
  // a z1 precursor m/z must not match a z2 query at tight tolerance
  const cross = searchCandidates(proteins, peaks, precursorMz(m, 1), params({
    precursorCharge: 2,
    precursorTolerance: 10,
    precursorToleranceUnit: "ppm",
  }));
  assert.equal(cross.length, 0);
});

test("fragment tolerance in ppm and da are unit-consistent at equivalent windows", () => {
  const peptide = "AAGK";
  const ions = theoreticalSpectrum(peptide, 1, DEFAULT_RESIDUE_MASSES);
  const b1 = ions.find((i) => i.type === "b" && i.number === 1)!;
  const shifted: ObservedPeak[] = [
    { peakId: 1, peakIndex: 0, mz: b1.mz * (1 + 5 / 1e6), intensity: 1 },
  ];
  const ppmHits = assignFragments(shifted, ions, 5, "ppm").length;
  const daWindow = (5 * b1.mz) / 1e6;
  const daHits = assignFragments(shifted, ions, daWindow, "da").length;
  assert.equal(ppmHits, 1);
  assert.equal(daHits, 1);
});

test("fixed modification shifts neutral mass and ions", () => {
  const carbC: Record<string, number> = { C: 57.021464 };
  const base = neutralMass("ACK");
  const modded = neutralMass("ACK", DEFAULT_RESIDUE_MASSES, carbC);
  assert.ok(Math.abs(modded - (base + 57.021464)) < 1e-6);
});
