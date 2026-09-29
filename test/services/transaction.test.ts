import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, FIXED_CLOCK } from "../helpers.js";
import { importPeakTable } from "../../src/services/peakTableService.js";
import { createAnalysis } from "../../src/services/analysisService.js";
import { runAndFreeze } from "../../src/services/reportService.js";

test("report persistence rolls back peptide rows when an explanation insert fails", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  importPeakTable(
    db,
    {
      name: "TX",
      precursorMz: 173.607886,
      precursorCharge: 2,
      peaks: [{ mz: 72.04439, intensity: 900 }],
    },
    clock
  );
  const analysis = createAnalysis(
    db,
    {
      name: "TX",
      maxMissedCleavages: 0,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 20,
      fragmentToleranceUnit: "ppm",
    },
    clock
  );

  // Force a failure mid-transaction by dropping the explanations table.
  db.exec("DROP TABLE peak_explanations;");
  assert.throws(() => runAndFreeze(db, analysis.id, 1, clock));

  // The report header and peptide rows must have been rolled back too.
  const reports = (db.prepare("SELECT COUNT(*) c FROM reports").get() as { c: number }).c;
  assert.equal(reports, 0, "report header should roll back");
  const matches = (db.prepare("SELECT COUNT(*) c FROM peptide_matches").get() as { c: number }).c;
  assert.equal(matches, 0, "peptide matches should roll back");
  db.close();
});
