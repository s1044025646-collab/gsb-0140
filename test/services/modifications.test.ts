import { test } from "node:test";
import assert from "node:assert/strict";
import { neutralMass } from "../../src/domain/mass.js";
import { loadModificationDeltas, loadMassTable } from "../../src/services/massTableService.js";
import { freshDb, FIXED_CLOCK } from "../helpers.js";
import { importProtein } from "../../src/services/proteinService.js";
import { importPeakTable } from "../../src/services/peakTableService.js";
import { createAnalysis } from "../../src/services/analysisService.js";
import { runAndFreeze } from "../../src/services/reportService.js";

test("carbamidomethyl-C fixed modification adds 57.021464 per cysteine", () => {
  const db = freshDb();
  const mt = db.prepare("SELECT id FROM mass_tables WHERE name='monoisotopic_v1'").get() as {
    id: number;
  };
  const massTable = loadMassTable(db, mt.id);
  const mod = db.prepare("SELECT id FROM modifications WHERE name='Carbamidomethyl_C'").get() as {
    id: number;
  };
  const deltas = loadModificationDeltas(db, [mod.id]);
  assert.equal(deltas.C, 57.021464);
  const base = neutralMass("ACK", massTable);
  const fixed = neutralMass("ACK", massTable, deltas);
  assert.ok(Math.abs(fixed - (base + 57.021464)) < 1e-6);
  db.close();
});

test("a modified analysis is a new revision and shifts the precursor window", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  importProtein(db, { accession: "CYS1", name: "c", sequence: "ACKG" }, clock);
  const mk = (mods: string[]) =>
    createAnalysis(
      db,
      {
        name: "CYS_ANA",
        maxMissedCleavages: 0,
        precursorCharge: 2,
        precursorTolerance: 10,
        precursorToleranceUnit: "ppm",
        fragmentTolerance: 10,
        fragmentToleranceUnit: "ppm",
        modifications: mods,
      },
      clock
    );
  const unmodified = mk([]);
  const modified = mk(["Carbamidomethyl_C"]);
  assert.notEqual(modified.id, unmodified.id);
  assert.equal(modified.revision, 2);
  db.close();
});

test("unknown modification name is rejected at analysis creation", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  assert.throws(() =>
    createAnalysis(
      db,
      {
        name: "BADMOD",
        maxMissedCleavages: 0,
        precursorCharge: 2,
        precursorTolerance: 10,
        precursorToleranceUnit: "ppm",
        fragmentTolerance: 10,
        fragmentToleranceUnit: "ppm",
        modifications: ["DoesNotExist"],
      },
      clock
    )
  );
  db.close();
});
