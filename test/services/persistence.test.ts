import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, FIXED_CLOCK } from "../helpers.js";
import { importProtein } from "../../src/services/proteinService.js";
import { importPeakTable } from "../../src/services/peakTableService.js";
import { createAnalysis } from "../../src/services/analysisService.js";
import { runAndFreeze, exportReport } from "../../src/services/reportService.js";
import { AppError } from "../../src/utils/errors.js";

function peaksFixture(overrides: Record<string, unknown> = {}) {
  return {
    name: "SPEC1",
    precursorMz: 173.607886,
    precursorCharge: 2,
    peaks: [
      { mz: 72.04439, intensity: 900 },
      { mz: 143.0815, intensity: 800 },
      { mz: 147.1128, intensity: 700 },
    ],
    ...overrides,
  };
}

test("protein import is idempotent and versions changed sequences", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  const first = importProtein(db, { accession: "P1", name: "n", sequence: "AAGK" }, clock);
  assert.equal(first.version, 1);
  const again = importProtein(db, { accession: "P1", name: "n", sequence: "AAGK" }, clock);
  assert.equal(again.id, first.id);
  assert.equal(again.version, 1);
  const changed = importProtein(db, { accession: "P1", name: "n", sequence: "AAGKR" }, clock);
  assert.notEqual(changed.id, first.id);
  assert.equal(changed.version, 2);
  db.close();
});

test("aliases resolve to the protein and are merged across versions", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  importProtein(db, { accession: "P1", name: "n", sequence: "AAGK", aliases: ["OLD"] }, clock);
  importProtein(db, { accession: "P1", name: "n", sequence: "AAGKR", aliases: ["NEW"] }, clock);
  const rows = db.prepare("SELECT * FROM protein_aliases ORDER BY alias").all() as {
    alias: string;
    protein_id: number;
  }[];
  assert.deepEqual(rows.map((r) => r.alias), ["NEW", "OLD"]);
  db.close();
});

test("peak table import rejects invalid peaks and rolls back", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  assert.throws(
    () =>
      importPeakTable(
        db,
        { name: "BAD", precursorMz: 100, peaks: [{ mz: -5, intensity: 1 }] },
        clock
      ),
    AppError
  );
  const count = (db.prepare("SELECT COUNT(*) c FROM peak_tables").get() as { c: number }).c;
  assert.equal(count, 0, "header must be rolled back when a peak is invalid");
  db.close();
});

test("peak table import is idempotent on name", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  const a = importPeakTable(db, peaksFixture(), clock);
  const b = importPeakTable(db, peaksFixture(), clock);
  assert.equal(a.id, b.id);
  assert.equal(b.reused, true);
  db.close();
});

test("mixed ppm/da tolerance units in one analysis are rejected", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  assert.throws(
    () =>
      createAnalysis(
        db,
        {
          name: "MIXED",
          maxMissedCleavages: 0,
          precursorCharge: 2,
          precursorTolerance: 10,
          precursorToleranceUnit: "ppm",
          fragmentTolerance: 0.5,
          fragmentToleranceUnit: "da",
        },
        clock
      ),
    (err: unknown) => err instanceof AppError && err.code === "TOLERANCE_UNIT_MISMATCH"
  );
  db.close();
});

test("analysis changes create a new revision; identical params are reused", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  const base = {
    name: "A1",
    maxMissedCleavages: 0,
    precursorCharge: 2,
    precursorTolerance: 10,
    precursorToleranceUnit: "ppm" as const,
    fragmentTolerance: 10,
    fragmentToleranceUnit: "ppm" as const,
  };
  const first = createAnalysis(db, base, clock);
  const again = createAnalysis(db, base, clock);
  assert.equal(again.id, first.id);
  assert.equal(again.reused, true);
  const revised = createAnalysis(db, { ...base, fragmentTolerance: 25 }, clock);
  assert.notEqual(revised.id, first.id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.supersedesId, first.id);
  db.close();
});

test("search submission is idempotent and report is frozen/exportable", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  importProtein(db, { accession: "FAKE_ALPHA", name: "a", sequence: "GKAAGK" }, clock);
  importProtein(db, { accession: "FAKE_BETA", name: "b", sequence: "LKAAGKR" }, clock);
  const analysis = createAnalysis(
    db,
    {
      name: "A1",
      maxMissedCleavages: 1,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 20,
      fragmentToleranceUnit: "ppm",
    },
    clock
  );
  const peaks = importPeakTable(db, peaksFixture(), clock);
  const r1 = runAndFreeze(db, analysis.id, peaks.id, clock);
  const r2 = runAndFreeze(db, analysis.id, peaks.id, clock);
  assert.equal(r2.reused, true);
  assert.equal(r2.reportId, r1.reportId);
  const doc = exportReport(db, r1.reportId);
  assert.ok(Array.isArray(doc.matches));
  assert.ok((doc.matches as unknown[]).length > 0);
  db.close();
});

test("historic report stays reproducible after parameters change", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  importProtein(db, { accession: "FAKE_ALPHA", name: "a", sequence: "GKAAGK" }, clock);
  const a1 = createAnalysis(
    db,
    {
      name: "A1",
      maxMissedCleavages: 0,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 20,
      fragmentToleranceUnit: "ppm",
    },
    clock
  );
  const peaks = importPeakTable(db, peaksFixture(), clock);
  const report = runAndFreeze(db, a1.id, peaks.id, clock);
  const before = JSON.stringify(exportReport(db, report.reportId));
  // create a new revision; old report rows must be untouched
  createAnalysis(
    db,
    {
      name: "A1",
      maxMissedCleavages: 1,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 20,
      fragmentToleranceUnit: "ppm",
    },
    clock
  );
  const after = JSON.stringify(exportReport(db, report.reportId));
  assert.equal(after, before);
  db.close();
});

test("invalid protein sequence is rejected", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  assert.throws(
    () => importProtein(db, { accession: "X", name: "x", sequence: "AAZ1" }, clock),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_SEQUENCE"
  );
  db.close();
});
