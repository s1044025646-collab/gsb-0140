import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESIDUE_MASSES, PROTON_MASS, WATER_MONOISOTOPIC } from "../src/core/constants.ts";
import {
  fragmentIonMz,
  mzErrorPpm,
  neutralMassFromMz,
  peptideNeutralMass,
  precursorMz,
  toleranceWindow,
  withinTolerance,
} from "../src/core/mass.ts";
import { validateMatchParams } from "../src/core/matcher.ts";
import { EXPECTED_ACG } from "../fixtures/index.ts";

const table = new Map(Object.entries(DEFAULT_RESIDUE_MASSES));
const EPS = 1e-7;

test("neutral peptide mass = sum of residue masses + exactly one water", () => {
  const manual =
    DEFAULT_RESIDUE_MASSES.A! +
    DEFAULT_RESIDUE_MASSES.C! +
    DEFAULT_RESIDUE_MASSES.G! +
    WATER_MONOISOTOPIC;
  assert.ok(Math.abs(peptideNeutralMass("ACG", table) - manual) < EPS);
  assert.ok(Math.abs(peptideNeutralMass("ACG", table) - EXPECTED_ACG.neutralMass) < EPS);
});

test("residue masses alone are never the molecular mass", () => {
  const residuesOnly =
    DEFAULT_RESIDUE_MASSES.A! + DEFAULT_RESIDUE_MASSES.C! + DEFAULT_RESIDUE_MASSES.G!;
  assert.ok(Math.abs(peptideNeutralMass("ACG", table) - residuesOnly - WATER_MONOISOTOPIC) < EPS);
});

test("precursor m/z adds z protons and divides by z", () => {
  const neutral = EXPECTED_ACG.neutralMass;
  assert.ok(Math.abs(precursorMz(neutral, 1) - (neutral + PROTON_MASS)) < EPS);
  assert.ok(Math.abs(precursorMz(neutral, 1) - EXPECTED_ACG.precursorMzCharge1) < EPS);
  assert.ok(Math.abs(precursorMz(neutral, 2) - EXPECTED_ACG.precursorMzCharge2) < EPS);
  assert.ok(Math.abs(neutralMassFromMz(precursorMz(neutral, 2), 2) - neutral) < 1e-9);
});

test("hand-computed b/y ions for ACG", () => {
  assert.ok(Math.abs(fragmentIonMz("ACG", "b", 1, 1, table) - EXPECTED_ACG.b1) < EPS);
  assert.ok(Math.abs(fragmentIonMz("ACG", "b", 2, 1, table) - EXPECTED_ACG.b2) < EPS);
  assert.ok(Math.abs(fragmentIonMz("ACG", "y", 1, 1, table) - EXPECTED_ACG.y1) < EPS);
  assert.ok(Math.abs(fragmentIonMz("ACG", "y", 2, 1, table) - EXPECTED_ACG.y2) < EPS);
});

test("b-ion carries one terminal H; y-ion carries water + H", () => {
  const b1 = DEFAULT_RESIDUE_MASSES.A! + PROTON_MASS;
  const y1 = DEFAULT_RESIDUE_MASSES.G! + WATER_MONOISOTOPIC + PROTON_MASS;
  assert.ok(Math.abs(fragmentIonMz("ACG", "b", 1, 1, table) - b1) < EPS);
  assert.ok(Math.abs(fragmentIonMz("ACG", "y", 1, 1, table) - y1) < EPS);
});

test("ppm window scales with m/z; da window is constant", () => {
  assert.ok(Math.abs(toleranceWindow(250, 10, "ppm") - 0.0025) < 1e-12);
  assert.equal(toleranceWindow(250, 0.001, "da"), 0.001);
  assert.ok(Math.abs(mzErrorPpm(250.0025, 250) - 10) < 1e-9);
});

test("tolerance boundary is inclusive", () => {
  // exactly on the +10 ppm boundary at m/z 250 -> +0.0025
  assert.equal(withinTolerance(250.0025, 250, 10, "ppm"), true);
  assert.equal(withinTolerance(250.0025 + 1e-9, 250, 10, "ppm"), false);
  assert.equal(withinTolerance(100.001, 100, 0.001, "da"), true);
  assert.equal(withinTolerance(100.0011, 100, 0.001, "da"), false);
});

test("ppm and Da tolerances cannot be mixed in one parameter set", () => {
  assert.throws(
    () =>
      validateMatchParams({
        precursorTolerance: 10,
        precursorUnit: "ppm",
        fragmentTolerance: 0.5,
        fragmentUnit: "da",
        charges: [1],
        fixedModificationIds: [],
      }),
    /must be identical/,
  );
});

test("fixed modifications shift every occurrence of the target residue", () => {
  const carbamido = [{ id: 99, name: "cam", residue: "C", massShift: 57.021464 }];
  const shifted = peptideNeutralMass("ACG", table, carbamido);
  assert.ok(Math.abs(shifted - (peptideNeutralMass("ACG", table) + 57.021464)) < EPS);
});
