import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let workdir: string;
let dbPath: string;
const cli = ["--import", "tsx", "src/cli/index.ts"];

function run(...args: string[]): string {
  return execFileSync(process.execPath, [...cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PROTEOMICS_DB: dbPath },
    encoding: "utf8",
  });
}

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "proteomics-cli-"));
  dbPath = join(workdir, "cli.db");
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test("CLI full workflow: import, digest, peaks, analysis, search, explain, export", () => {
  // import protein
  let out = run(
    "import-protein",
    "--accession", "FAKE_ALPHA",
    "--name", "alpha",
    "--sequence", "GKAAGK",
    "--aliases", "ALPHA1"
  );
  assert.match(out, /BEFORE: proteins=0/);
  assert.match(out, /AFTER: proteins=1/);
  assert.match(out, /"version": 1/);

  // idempotent re-import
  out = run("import-protein", "--accession", "FAKE_ALPHA", "--name", "alpha", "--sequence", "GKAAGK");
  assert.match(out, /AFTER: proteins=1/);

  // preview digest
  out = run("preview-digest", "--protein", "FAKE_ALPHA", "--missed", "1");
  assert.match(out, /AAGK/);
  assert.match(out, /GKAAGK/);

  // theoretical spectrum
  out = run("theoretical-spectrum", "--protein", "1", "--charge", "2");
  assert.match(out, /b1/);
  assert.match(out, /y1/);

  // import peaks from a temp file
  const peaksFile = join(workdir, "peaks.json");
  const peaks = {
    precursorMz: 173.607886,
    precursorCharge: 2,
    peaks: [
      { mz: 72.04439, intensity: 900 },
      { mz: 143.0815, intensity: 800 },
      { mz: 147.1128, intensity: 700 },
    ],
  };
  writeFileSync(peaksFile, JSON.stringify(peaks));
  out = run("import-peaks", "--name", "CLI_SPEC", "--file", peaksFile);
  assert.match(out, /AFTER: peak_tables=1/);

  // create analysis
  out = run(
    "create-analysis",
    "--name", "CLI_ANA",
    "--missed", "1",
    "--charge", "2",
    "--precursor-tol", "20",
    "--precursor-unit", "ppm",
    "--fragment-tol", "20",
    "--fragment-unit", "ppm"
  );
  assert.match(out, /AFTER: analyses=1/);

  // search
  out = run("search", "--analysis", "1", "--peak-table", "1");
  assert.match(out, /AFTER: reports=1/);
  assert.match(out, /"reused": false/);
  // idempotent re-search
  out = run("search", "--analysis", "1", "--peak-table", "1");
  assert.match(out, /"reused": true/);

  // explain
  out = run("explain", "--report", "1");
  assert.match(out, /AAGK/);
  assert.match(out, /Peak-by-peak assignments/);
  assert.match(out, /\bb\b/);

  // export
  const exportFile = join(workdir, "report.json");
  out = run("export-report", "--report", "1", "--out", exportFile);
  assert.ok(existsSync(exportFile));
  const doc = JSON.parse(readFileSync(exportFile, "utf8"));
  assert.ok(doc.matches.length > 0);
  assert.ok(doc.peakExplanations.length > 0);
});

test("CLI rejects invalid sequence with error code and exits non-zero", () => {
  try {
    run("import-protein", "--accession", "BAD", "--name", "b", "--sequence", "AAZ");
    assert.fail("should have thrown");
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.notEqual(e.status, 0);
    assert.match(e.stderr ?? "", /INVALID_SEQUENCE/);
  }
});

test("CLI rejects mixed tolerance units", () => {
  try {
    run(
      "create-analysis",
      "--name", "MIX",
      "--missed", "0",
      "--charge", "2",
      "--precursor-tol", "10",
      "--precursor-unit", "ppm",
      "--fragment-tol", "0.5",
      "--fragment-unit", "da"
    );
    assert.fail("should have thrown");
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.notEqual(e.status, 0);
    assert.match(e.stderr ?? "", /TOLERANCE_UNIT_MISMATCH/);
  }
});
