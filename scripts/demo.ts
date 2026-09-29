/**
 * Repeatable local end-to-end demonstration.
 * Uses a fresh data/demo.sqlite so repeated runs start identically;
 * searches and imports are idempotent on fixed client ids.
 */
import { rmSync } from "node:fs";
import { openDatabase, seedReferenceData, defaultClock } from "../src/db/database.ts";
import { upsertProteinSequence } from "../src/services/proteins.ts";
import { importPeaklist } from "../src/services/peaklists.ts";
import { createParameterSet } from "../src/services/parameters.ts";
import { executeSearch, freezeReport, listCandidates, explainCandidate } from "../src/services/searches.ts";
import {
  ACG_PEAKLIST,
  ACG_Z2_PEAKLIST,
  FICTIONAL_PROTEINS,
  NO_MATCH_PEAKLIST,
  SEARCH_PARAMS,
} from "../fixtures/index.ts";

const dbPath = "data/demo.sqlite";
rmSync(dbPath, { force: true });
const db = openDatabase(dbPath);
const defaults = seedReferenceData(db);

console.log("== 1. import fictional proteins (with aliases/versions) ==");
for (const protein of FICTIONAL_PROTEINS) {
  const result = upsertProteinSequence(db, { ...protein, aliases: [...protein.aliases] }, defaultClock);
  console.log(`  ${protein.accession} -> proteinId=${result.proteinId} version=${result.sequenceVersionId}`);
}

console.log("== 2. create immutable search parameters (ppm only) ==");
const parameterSetId = createParameterSet(db, { ...SEARCH_PARAMS }, defaults, defaultClock);
console.log(`  parameterSetId=${parameterSetId}`);

for (const peaklistFixture of [ACG_PEAKLIST, ACG_Z2_PEAKLIST, NO_MATCH_PEAKLIST]) {
  console.log(`== 3. search ${peaklistFixture.label} ==`);
  const importResult = importPeaklist(db, { ...peaklistFixture, peaks: peaklistFixture.peaks.map((p) => ({ ...p })) }, defaultClock);
  const searchResult = executeSearch(
    db,
    { clientId: `search-${peaklistFixture.clientId}`, peaklistId: importResult.id, parameterSetId },
    defaultClock,
  );
  const candidates = listCandidates(db, { searchId: searchResult.searchId, page: 1, pageSize: 5 });
  console.log(`  candidates: ${candidates.total}`);
  for (const candidate of candidates.items.slice(0, 3)) {
    const row = candidate as Record<string, unknown>;
    console.log(
      `   #${row.rank} ${row.peptideSequence} score=${row.score} matchedPeaks=${row.matchedPeakCount} ambiguous=${row.ambiguousProtein}`,
    );
  }
  if (candidates.items[0]) {
    const detail = explainCandidate(db, Number((candidates.items[0] as Record<string, unknown>).id));
    for (const match of detail.peakMatches as Array<Record<string, unknown>>) {
      console.log(
        `     peak#${match.peakIndex} ${match.observedMz} -> ${match.ionSeries}${match.ionNumber} ${match.theoreticalMz} (${(match.errorPpm as number).toFixed(3)} ppm)`,
      );
    }
    const report = freezeReport(db, searchResult.searchId, `report-${peaklistFixture.clientId}`, defaultClock);
    console.log(`  frozen report id=${report.id} (reused=${report.reused})`);
  }
}

console.log("== 4. idempotency check: rerunning all writes ==");
const first = FICTIONAL_PROTEINS[0]!;
const before = (db.prepare("SELECT COUNT(*) c FROM proteins").get() as { c: number }).c;
upsertProteinSequence(db, { ...first, aliases: [...first.aliases] }, defaultClock);
const after = (db.prepare("SELECT COUNT(*) c FROM proteins").get() as { c: number }).c;
console.log(`  proteins before=${before} after=${after} (must be equal)`);

db.close();
console.log(`\ndemo complete; database left at ${dbPath}`);
