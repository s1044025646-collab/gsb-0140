import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../src/db/database.js";
import { fixedClock } from "../../src/utils/clock.js";
import { importProtein } from "../../src/services/proteinService.js";
import { importPeakTable } from "../../src/services/peakTableService.js";
import { createAnalysis } from "../../src/services/analysisService.js";
import { runAndFreeze, exportReport } from "../../src/services/reportService.js";
import { runMigrations, seedReferenceData } from "../../src/db/database.js";

function setup(dbPath: string) {
  const db = initDatabase(dbPath, fixedClock("2026-01-01T00:00:00.000Z"));
  const clock = fixedClock("2026-01-01T00:00:00.000Z", "e2e-uuid");
  importProtein(db, { accession: "FAKE_ALPHA", name: "a", sequence: "GKAAGK", aliases: ["A1"] }, clock);
  importProtein(db, { accession: "FAKE_BETA", name: "b", sequence: "LKAAGKR" }, clock);
  const analysis = createAnalysis(
    db,
    {
      name: "RUN",
      maxMissedCleavages: 1,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 20,
      fragmentToleranceUnit: "ppm",
    },
    clock
  );
  const peaks = importPeakTable(
    db,
    {
      name: "RUNPEAKS",
      precursorMz: 173.607886,
      precursorCharge: 2,
      peaks: [
        { mz: 72.04439, intensity: 900 },
        { mz: 143.0815, intensity: 800 },
        { mz: 147.1128, intensity: 700 },
      ],
    },
    clock
  );
  const report = runAndFreeze(db, analysis.id, peaks.id, clock);
  db.close();
  return report.reportId;
}

test("data persists across a simulated restart and migrations are repeatable", () => {
  const dir = mkdtempSync(join(tmpdir(), "proteomics-e2e-"));
  const dbPath = join(dir, "e2e.db");
  try {
    const reportId = setup(dbPath);
    assert.ok(existsSync(dbPath));

    // restart: reopen and run migrations again (must be a safe no-op)
    const reopened = initDatabase(dbPath, fixedClock("2027-01-01T00:00:00.000Z"));
    runMigrations(reopened, fixedClock("2027-01-01T00:00:00.000Z"));
    seedReferenceData(reopened, fixedClock("2027-01-01T00:00:00.000Z"));

    const proteins = reopened.prepare("SELECT COUNT(*) c FROM proteins").get() as { c: number };
    assert.equal(proteins.c, 2);
    const alias = reopened
      .prepare("SELECT alias FROM protein_aliases WHERE alias='A1'")
      .get() as { alias: string } | undefined;
    assert.ok(alias);

    // frozen report is identical after restart
    const doc = exportReport(reopened, reportId);
    assert.ok((doc.matches as unknown[]).length > 0);
    const top = doc.matches[0] as { peptide_sequence: string; protein_accession: string };
    assert.equal(top.peptide_sequence, "AAGK");

    // shared peptide has rows for both source proteins at the same rank
    const aagkRows = (doc.matches as { peptide_sequence: string }[]).filter(
      (m) => m.peptide_sequence === "AAGK"
    );
    const accessions = new Set(aagkRows.map((r) => (r as { protein_accession: string }).protein_accession));
    assert.equal(accessions.size, 2);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
