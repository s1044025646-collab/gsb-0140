import { test } from "node:test";
import assert from "node:assert/strict";
import { neutralMass, precursorMz, ppmError, daError, withinTolerance, toleranceToDa } from "../../src/domain/mass.js";
import { bIonSeries, yIonSeries, theoreticalSpectrum } from "../../src/domain/ions.js";
import { DEFAULT_RESIDUE_MASSES, WATER_MONOISOTOPIC, PROTON_MASS } from "../../src/domain/constants.js";

const EPS = 1e-6;

test("neutral mass adds exactly one water, not residue-as-molecule", () => {
  // GG: 2*57.021463720 + 18.010564684 = 132.053492124
  const expected = 2 * DEFAULT_RESIDUE_MASSES.G + WATER_MONOISOTOPIC;
  assert.ok(Math.abs(neutralMass("GG") - expected) < 1e-9);
  assert.ok(Math.abs(neutralMass("GG") - 132.053492124) < 1e-6);
});

test("precursor m/z stoichiometry [M+zH]/z", () => {
  const m = neutralMass("GG");
  // z=1: M + proton
  assert.ok(Math.abs(precursorMz(m, 1) - (m + PROTON_MASS)) < 1e-9);
  // z=2: (M + 2H+)/2
  assert.ok(Math.abs(precursorMz(m, 2) - (m + 2 * PROTON_MASS) / 2) < 1e-9);
});

test("b ions exclude water; y ions include water + proton (singly charged)", () => {
  // GG: b1 = G + H+ ; y1 = G + H2O + H+
  const b = bIonSeries("GG", 1, DEFAULT_RESIDUE_MASSES);
  const y = yIonSeries("GG", 1, DEFAULT_RESIDUE_MASSES);
  assert.ok(Math.abs(b[0].mz - (DEFAULT_RESIDUE_MASSES.G + PROTON_MASS)) < 1e-6);
  assert.ok(
    Math.abs(y[0].mz - (DEFAULT_RESIDUE_MASSES.G + WATER_MONOISOTOPIC + PROTON_MASS)) < 1e-6
  );
});

test("AAGK hand-computed neutral mass and precursor charges", () => {
  // A=71.037113805 G=57.021463720 K=128.094963015
  const residues =
    2 * DEFAULT_RESIDUE_MASSES.A + DEFAULT_RESIDUE_MASSES.G + DEFAULT_RESIDUE_MASSES.K;
  const expected = residues + WATER_MONOISOTOPIC;
  assert.ok(Math.abs(neutralMass("AAGK") - expected) < 1e-6);
  assert.ok(Math.abs(neutralMass("AAGK") - 345.201219029) < 1e-6);
  assert.ok(Math.abs(precursorMz(neutralMass("AAGK"), 2) - 173.607885981) < 1e-6);
});

test("AAGK b/y ion series match hand values", () => {
  const ions = theoreticalSpectrum("AAGK", 1, DEFAULT_RESIDUE_MASSES);
  const mz = (label: string) => ions.find((i) => `${i.type}${i.number}` === label)!.mz;
  const A = DEFAULT_RESIDUE_MASSES.A;
  const G = DEFAULT_RESIDUE_MASSES.G;
  const K = DEFAULT_RESIDUE_MASSES.K;
  // b
  assert.ok(Math.abs(mz("b1") - (A + PROTON_MASS)) < 1e-6);
  assert.ok(Math.abs(mz("b2") - (2 * A + PROTON_MASS)) < 1e-6);
  assert.ok(Math.abs(mz("b3") - (2 * A + G + PROTON_MASS)) < 1e-6);
  // y
  assert.ok(Math.abs(mz("y1") - (K + WATER_MONOISOTOPIC + PROTON_MASS)) < 1e-6);
  assert.ok(Math.abs(mz("y2") - (G + K + WATER_MONOISOTOPIC + PROTON_MASS)) < 1e-6);
  assert.ok(Math.abs(mz("y3") - (A + G + K + WATER_MONOISOTOPIC + PROTON_MASS)) < 1e-6);
  // full-length b4/y4 are not fragment ions
  assert.equal(ions.find((i) => i.number === 4), undefined);
});

test("ppm and da error conversions", () => {
  assert.ok(Math.abs(ppmError(100.0001, 100) - 1) < 1e-9);
  assert.ok(Math.abs(daError(100.001, 100) - 0.001) < 1e-12);
  // 10 ppm at m/z 200 = 0.002 Da
  assert.ok(Math.abs(toleranceToDa(10, "ppm", 200) - 0.002) < 1e-12);
  assert.equal(toleranceToDa(0.01, "da", 999), 0.01);
});

test("tolerance boundary is inclusive and ppm is relative", () => {
  const inside = 200 * (1 + 10 / 1_000_000); // exactly +10 ppm
  assert.equal(withinTolerance(inside, 200, 10, "ppm"), true);
  assert.equal(withinTolerance(200 * 1.000011, 200, 10, "ppm"), false); // 11 ppm, outside
  assert.equal(withinTolerance(100 + 0.01, 100, 0.01, "da"), true); // exact da boundary
  assert.equal(withinTolerance(100 + 0.011, 100, 0.01, "da"), false);
});

test("invalid residue is rejected rather than silently massed", () => {
  assert.throws(() => neutralMass("AZ"));
  assert.throws(() => precursorMz(100, 0));
});
