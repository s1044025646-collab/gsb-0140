// Reproducible end-to-end demonstration against a dedicated project-local
// database (temp/demo.db). Fictional data only; binds nothing externally.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { initDatabase } from "../src/db/database.js";
import { fixedClock } from "../src/utils/clock.js";
import { importProtein } from "../src/services/proteinService.js";
import { importPeakTable } from "../src/services/peakTableService.js";
import { createAnalysis } from "../src/services/analysisService.js";
import { runAndFreeze, exportReport } from "../src/services/reportService.js";
import { digest, TRYPSIN } from "../src/domain/digestion.js";
import { neutralMass, precursorMz } from "../src/domain/mass.js";
import { theoreticalSpectrum } from "../src/domain/ions.js";
import { DEFAULT_RESIDUE_MASSES } from "../src/domain/constants.js";

const dbPath = resolve("temp/demo.db");
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const clock = fixedClock("2026-01-01T00:00:00.000Z", "demo-report-uuid");
const db = initDatabase(dbPath, clock);

const line = (s: string) => console.log(`\n=== ${s} ===`);

line("1. Import fictional proteins (with aliases)");
for (const p of [
  { accession: "FAKE_ALPHA", name: "alpha", sequence: "GKAAGK", aliases: ["ALPHA_FICTION"] },
  { accession: "FAKE_BETA", name: "beta", sequence: "LKAAGKR", aliases: ["BETA_FICTION"] },
  { accession: "FAKE_GAMMA", name: "gamma", sequence: "AKRKPK" },
  { accession: "FAKE_DELTA", name: "delta", sequence: "ARPGAKR" },
]) {
  const r = importProtein(db, p, clock);
  console.log(`  ${r.accession} v${r.version} id=${r.id} length=${r.sequenceLength}`);
}

line("2. Trypsin digestion (max 1 missed cleavage) of FAKE_ALPHA");
const alpha = "GKAAGK";
for (const pep of digest(alpha, TRYPSIN, 1)) {
  console.log(`  ${pep.start}-${pep.end} mc=${pep.missedCleavages}  ${pep.sequence}`);
}

line("3. Hand-verifiable masses for AAGK");
const seq = "AAGK";
const m = neutralMass(seq, DEFAULT_RESIDUE_MASSES);
console.log(`  neutral mass = ${m.toFixed(5)} Da`);
console.log(`  precursor z=1 = ${precursorMz(m, 1).toFixed(5)} m/z`);
console.log(`  precursor z=2 = ${precursorMz(m, 2).toFixed(5)} m/z`);
console.log("  b/y ions (z=1):");
for (const ion of theoreticalSpectrum(seq, 1, DEFAULT_RESIDUE_MASSES)) {
  console.log(`    ${ion.type}${ion.number} = ${ion.mz.toFixed(5)}`);
}

line("4. Import observed peak table (synthetic AAGK z=2)");
const ions = theoreticalSpectrum(seq, 1, DEFAULT_RESIDUE_MASSES);
const peaks = ions.map((ion, i) => ({ mz: ion.mz, intensity: 1000 - i * 50 }));
peaks.push({ mz: 500.0, intensity: 50 }); // noise
const peakTable = importPeakTable(
  db,
  {
    name: "DEMO_AAGK_Z2",
    description: "synthetic AAGK spectrum",
    precursorMz: precursorMz(m, 2),
    precursorCharge: 2,
    peaks,
  },
  clock
);
console.log(`  peak table id=${peakTable.id} peaks=${peakTable.peakCount}`);

line("5. Create analysis (trypsin, 10 ppm precursor+fragment, 1 missed, z=2)");
const analysis = createAnalysis(
  db,
  {
    name: "DEMO_ANALYSIS",
    maxMissedCleavages: 1,
    precursorCharge: 2,
    precursorTolerance: 10,
    precursorToleranceUnit: "ppm",
    fragmentTolerance: 10,
    fragmentToleranceUnit: "ppm",
  },
  clock
);
console.log(`  analysis id=${analysis.id} revision=${analysis.revision}`);

line("6. Search candidates and freeze report");
const result = runAndFreeze(db, analysis.id, peakTable.id, clock);
console.log(`  report id=${result.reportId} candidates=${result.candidateCount}`);
const doc = exportReport(db, result.reportId);
const ranked = doc.matches as {
  rank: number;
  peptide_sequence: string;
  protein_accession: string;
  matched_fragments: number;
  total_fragments: number;
  ambiguous_group: number | null;
}[];
for (const row of ranked.slice(0, 6)) {
  console.log(
    `  rank=${row.rank} ${row.peptide_sequence} via ${row.protein_accession} ` +
      `frags=${row.matched_fragments}/${row.total_fragments} ambig=${row.ambiguous_group ?? "-"}`
  );
}

line("7. Peak-by-peak explanation for top peptide");
const topMatchId = (ranked[0] as unknown as { id: number }).id;
const exps = (
  doc.peakExplanations as {
    peptide_match_id: number;
    ion_type: string;
    ion_number: number;
    theoretical_mz: number;
    peak_mz: number;
    mass_error_ppm: number;
  }[]
).filter((e) => e.peptide_match_id === topMatchId);
for (const e of exps) {
  console.log(
    `  ${e.ion_type}${e.ion_number}  theo=${e.theoretical_mz.toFixed(4)}  ` +
      `obs=${e.peak_mz.toFixed(4)}  err=${e.mass_error_ppm.toFixed(3)} ppm`
  );
}

line("8. Idempotency check");
const again = runAndFreeze(db, analysis.id, peakTable.id, clock);
console.log(`  repeat search reused=${again.reused} reportId=${again.reportId}`);

db.close();
console.log(`\nDemo database at ${dbPath}`);
console.log("Re-run any time with: npm run demo");
