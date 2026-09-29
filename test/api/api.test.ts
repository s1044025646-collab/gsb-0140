import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { freshDb } from "../helpers.js";
import { startServer } from "../../src/api/server.js";
import { fixedClock } from "../../src/utils/clock.js";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let server: Server;
let base: string;

before(async () => {
  db = freshDb();
  const started = await startServer(db, {
    clock: fixedClock("2026-01-01T00:00:00.000Z", "api-uuid"),
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json();
  return { status: res.status, body };
}

test("health endpoint", async () => {
  const { status, body } = await api("/api/health");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
});

test("unknown route returns 404 with error code", async () => {
  const { status, body } = await api("/api/nope");
  assert.equal(status, 404);
  assert.equal(body.error.code, "NOT_FOUND");
});

test("import protein then retrieve it", async () => {
  const r = await api("/api/proteins", {
    method: "POST",
    body: JSON.stringify({ accession: "P9", name: "nine", sequence: "AAGK", aliases: ["NINE"] }),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.accession, "P9");
  const got = await api(`/api/proteins/${r.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.aliases, ["NINE"]);
});

test("protein validation error has 400 and explicit code", async () => {
  const r = await api("/api/proteins", {
    method: "POST",
    body: JSON.stringify({ accession: "BAD", name: "x", sequence: "AAZ" }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "INVALID_SEQUENCE");
});

test("pagination metadata is returned and bounded", async () => {
  for (let i = 0; i < 3; i++) {
    await api("/api/proteins", {
      method: "POST",
      body: JSON.stringify({ accession: `PG${i}`, name: "g", sequence: "AAGK" }),
    });
  }
  const r = await api("/api/proteins?page=1&pageSize=2");
  assert.equal(r.status, 200);
  assert.equal(r.body.pageSize, 2);
  assert.equal(r.body.items.length, 2);
  assert.ok(r.body.total >= 4);
  assert.ok(r.body.totalPages >= 2);
  // oversized pageSize is capped
  const big = await api("/api/proteins?pageSize=99999");
  assert.equal(big.body.pageSize, 200);
});

test("digest endpoint returns positions and missed-cleavage counts", async () => {
  const created = await api("/api/proteins", {
    method: "POST",
    body: JSON.stringify({ accession: "PDG", name: "d", sequence: "GKAAGK" }),
  });
  const r = await api(`/api/proteins/${created.body.id}/digest?missed=1`);
  assert.equal(r.status, 200);
  const aagk = r.body.peptides.find((p: { sequence: string }) => p.sequence === "AAGK");
  assert.deepEqual({ start: aagk.start, end: aagk.end }, { start: 3, end: 6 });
  const withMissed = r.body.peptides.find((p: { sequence: string }) => p.sequence === "GKAAGK");
  assert.equal(withMissed.missedCleavages, 1);
});

test("mixed units rejected through API", async () => {
  const r = await api("/api/analyses", {
    method: "POST",
    body: JSON.stringify({
      name: "MIX",
      maxMissedCleavages: 0,
      precursorCharge: 2,
      precursorTolerance: 10,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 0.5,
      fragmentToleranceUnit: "da",
    }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "TOLERANCE_UNIT_MISMATCH");
});

test("end-to-end search then report and explanations", async () => {
  await api("/api/proteins", {
    method: "POST",
    body: JSON.stringify({ accession: "FAKE_ALPHA", name: "a", sequence: "GKAAGK" }),
  });
  const analysis = await api("/api/analyses", {
    method: "POST",
    body: JSON.stringify({
      name: "E2E",
      maxMissedCleavages: 1,
      precursorCharge: 2,
      precursorTolerance: 20,
      precursorToleranceUnit: "ppm",
      fragmentTolerance: 20,
      fragmentToleranceUnit: "ppm",
    }),
  });
  const peaks = await api("/api/peak-tables", {
    method: "POST",
    body: JSON.stringify({
      name: "E2EPEAKS",
      precursorMz: 173.607886,
      precursorCharge: 2,
      peaks: [
        { mz: 72.04439, intensity: 900 },
        { mz: 143.0815, intensity: 800 },
        { mz: 147.1128, intensity: 700 },
      ],
    }),
  });
  const search = await api("/api/search", {
    method: "POST",
    body: JSON.stringify({ analysisId: analysis.body.id, peakTableId: peaks.body.id }),
  });
  assert.equal(search.status, 201);
  // repeat submission is idempotent
  const again = await api("/api/search", {
    method: "POST",
    body: JSON.stringify({ analysisId: analysis.body.id, peakTableId: peaks.body.id }),
  });
  assert.equal(again.body.reused, true);
  assert.equal(again.body.reportId, search.body.reportId);

  const reportPeptides = await api(`/api/reports/${search.body.reportId}/peptides`);
  assert.ok(reportPeptides.body.items.length > 0);
  const matchId = reportPeptides.body.items[0].id;
  const exps = await api(`/api/reports/${search.body.reportId}/explanations?peptideMatchId=${matchId}`);
  assert.ok(exps.body.items.length > 0);
  // each peak id appears at most once for this match
  const peakIds = exps.body.items.map((e: { peak_id: number }) => e.peak_id);
  assert.equal(new Set(peakIds).size, peakIds.length);
});
