import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, seedReferenceData, type Clock } from "../src/db/database.ts";
import { upsertProteinSequence } from "../src/services/proteins.ts";
import { importPeaklist } from "../src/services/peaklists.ts";
import { createParameterSet } from "../src/services/parameters.ts";
import { executeSearch } from "../src/services/searches.ts";
import { FICTIONAL_PROTEINS, SEARCH_PARAMS } from "../fixtures/index.ts";

function fixedClock(): Clock {
  let ticks = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ticks++)) };
}

test("migrations are repeatable and reference data is seeded once", () => {
  const db = openDatabase(":memory:");
  const first = seedReferenceData(db);
  const second = openDatabase(":memory:");
  seedReferenceData(second);
  assert.equal(first.massRevisionId, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM residue_masses WHERE revision_id = ?").get(first.massRevisionId) as { c: number }).c > 18,
    true,
  );
  // re-seed must not duplicate
  seedReferenceData(db);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM enzymes").get() as { c: number }).c, 1);
  db.close();
  second.close();
});

test("identical re-import is idempotent for proteins, peaklists and searches", () => {
  const db = openDatabase(":memory:", fixedClock());
  const defaults = seedReferenceData(db, fixedClock());
  const protein = FICTIONAL_PROTEINS[0]!;
  const a = upsertProteinSequence(db, { ...protein }, fixedClock());
  const b = upsertProteinSequence(db, { ...protein }, fixedClock());
  assert.equal(a.sequenceVersionId, b.sequenceVersionId);

  const peaks = {
    clientId: "idem-1",
    label: "idem",
    precursorMz: 250.0856031503,
    peaks: [{ mz: 72.0443902, intensity: 1 }],
  };
  const p1 = importPeaklist(db, peaks, fixedClock());
  const p2 = importPeaklist(db, peaks, fixedClock());
  assert.equal(p1.id, p2.id);
  assert.equal(p2.reused, true);

  const parameterSetId = createParameterSet(db, { ...SEARCH_PARAMS }, defaults, fixedClock());
  const s1 = executeSearch(db, { clientId: "s-1", peaklistId: p1.id, parameterSetId }, fixedClock());
  const s2 = executeSearch(db, { clientId: "s-1", peaklistId: p1.id, parameterSetId }, fixedClock());
  assert.equal(s1.searchId, s2.searchId);
  assert.equal(s2.reused, true);
  db.close();
});

test("failed sequence version insert rolls back and leaves no partial rows", () => {
  const db = openDatabase(":memory:", fixedClock());
  seedReferenceData(db);
  upsertProteinSequence(db, { accession: "X1", name: "x", sequence: "MACK" }, fixedClock());
  const before = (db.prepare("SELECT COUNT(*) c FROM sequence_versions").get() as { c: number }).c;
  assert.throws(() =>
    upsertProteinSequence(db, { accession: "X1", name: "x", sequence: "ZZZ123" }, fixedClock()),
  );
  const after = (db.prepare("SELECT COUNT(*) c FROM sequence_versions").get() as { c: number }).c;
  assert.equal(before, after);
  db.close();
});

test("data survives closing and reopening the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "peptidematch-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "persist.sqlite");
  {
    const db = openDatabase(dbPath, fixedClock());
    const defaults = seedReferenceData(db, fixedClock());
    for (const protein of FICTIONAL_PROTEINS) {
      upsertProteinSequence(db, { ...protein }, fixedClock());
    }
    const importResult = importPeaklist(
      db,
      {
        clientId: "persist-peaks",
        label: "persist",
        precursorMz: 250.0856031503,
        peaks: [{ mz: 72.0443902, intensity: 10 }],
      },
      fixedClock(),
    );
    const parameterSetId = createParameterSet(db, { ...SEARCH_PARAMS }, defaults, fixedClock());
    executeSearch(
      db,
      { clientId: "persist-search", peaklistId: importResult.id, parameterSetId },
      fixedClock(),
    );
    db.close();
  }
  {
    const reopened = openDatabase(dbPath, fixedClock());
    assert.equal((reopened.prepare("SELECT COUNT(*) c FROM proteins").get() as { c: number }).c, 3);
    assert.equal((reopened.prepare("SELECT COUNT(*) c FROM searches").get() as { c: number }).c, 1);
    assert.equal(
      (reopened.prepare("SELECT COUNT(*) c FROM search_candidates").get() as { c: number }).c >= 1,
      true,
    );
    reopened.close();
  }
});

test("parameter revision change creates a new immutable parameter set", () => {
  const db = openDatabase(":memory:", fixedClock());
  const defaults = seedReferenceData(db, fixedClock());
  const id1 = createParameterSet(db, { ...SEARCH_PARAMS }, defaults, fixedClock());
  const id2 = createParameterSet(
    db,
    { ...SEARCH_PARAMS, label: "default-fixture-search-2", fragmentTolerance: 5 },
    defaults,
    fixedClock(),
  );
  assert.notEqual(id1, id2);
  assert.equal((db.prepare("SELECT fragment_tolerance t FROM parameter_sets WHERE id=?").get(id1) as { t: number }).t, 10);
  db.close();
});
