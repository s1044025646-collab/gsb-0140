import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, FIXED_CLOCK } from "../helpers.js";
import { importProtein } from "../../src/services/proteinService.js";
import { importPeakTable } from "../../src/services/peakTableService.js";
import { createAnalysis } from "../../src/services/analysisService.js";
import { runAndFreeze, exportReport } from "../../src/services/reportService.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(here, "..", "..", "fixtures", name), "utf8"));

test("fragment tolerance boundary: exactly +-10ppm matches, +10.0001ppm does not", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  importProtein(db, { accession: "FAKE_ALPHA", name: "a", sequence: "GKAAGK" }, clock);
  const analysis = createAnalysis(
    db,
    {
      name: "BOUND",
      maxMissedCleavages: 1,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 10,
      fragmentToleranceUnit: "ppm",
    },
    clock
  );
  const peaksJson = fixture("peaks_boundary.json");
  const peaks = importPeakTable(db, { name: "BOUNDPEAKS", ...peaksJson }, clock);
  const run = runAndFreeze(db, analysis.id, peaks.id, clock);
  const doc = exportReport(db, run.reportId);
  const aagk = (doc.matches as { peptide_sequence: string }[]).find(
    (m) => m.peptide_sequence === "AAGK"
  );
  assert.ok(aagk, "AAGK must be a precursor candidate");
  const matchId = (aagk as { id: number }).id;
  const explanations = (
    doc.peakExplanations as { peptide_match_id: number; ion_type: string; ion_number: number }[]
  ).filter((e) => e.peptide_match_id === matchId);
  // b1 (+10 ppm exactly) and b3 (-10 ppm exactly) match; b2 (+10.0001) does not
  const labels = explanations.map((e) => `${e.ion_type}${e.ion_number}`);
  assert.ok(labels.includes("b1"), `b1 should match at boundary, got ${labels}`);
  assert.ok(labels.includes("b3"), `b3 should match at boundary, got ${labels}`);
  assert.ok(!labels.includes("b2"), "b2 at +10.0001 ppm must NOT match");
  assert.ok(!labels.some((l) => l.startsWith("y")), "no y ions are observed in this fixture");
  db.close();
});

test("no-match fixture yields zero candidates", () => {
  const db = freshDb();
  const clock = FIXED_CLOCK();
  importProtein(db, { accession: "FAKE_ALPHA", name: "a", sequence: "GKAAGK" }, clock);
  const analysis = createAnalysis(
    db,
    {
      name: "NOM",
      maxMissedCleavages: 1,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 20,
      fragmentToleranceUnit: "ppm",
    },
    clock
  );
  const peaksJson = fixture("peaks_nomatch.json");
  const peaks = importPeakTable(db, { name: "NOPEAKS", ...peaksJson }, clock);
  const run = runAndFreeze(db, analysis.id, peaks.id, clock);
  const doc = exportReport(db, run.reportId);
  assert.equal((doc.matches as unknown[]).length, 0);
  db.close();
});
