import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedServer } from "../src/server.ts";
import { startServer } from "../src/server.ts";
import {
  ACG_PEAKLIST,
  FICTIONAL_PROTEINS,
  SEARCH_PARAMS,
} from "../fixtures/index.ts";

let server: StartedServer;
let dir: string;

function fixedClock() {
  let ticks = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 2, 0, 0, ticks++)) };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "peptidematch-api-"));
  server = await startServer({
    dbPath: join(dir, "api.sqlite"),
    clock: fixedClock(),
  });
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

test("end-to-end: import, search, explain, freeze report, pagination", async () => {
  const fasta = FICTIONAL_PROTEINS.map(
    (protein) => `>${protein.accession} ${protein.name}\n${protein.sequence}`,
  ).join("\n");
  const imported = await api("POST", "/proteins/import-fasta", { fasta });
  assert.equal(imported.status, 200);
  assert.equal((imported.json.imported as number), 3);

  const proteins = await api("GET", "/proteins?page=1&pageSize=2");
  assert.equal(proteins.status, 200);
  assert.equal((proteins.json.items as unknown[]).length, 2);
  assert.equal(proteins.json.total, 3);

  const peaks = await api("POST", "/peaklists", ACG_PEAKLIST);
  assert.equal(peaks.status, 200);
  const peaklistId = (peaks.json as { id: number }).id;

  const params = await api("POST", "/parameter-sets", SEARCH_PARAMS);
  assert.equal(params.status, 201);
  const parameterSetId = (params.json as { id: number }).id;

  const searchResponse = await api("POST", "/searches", {
    clientId: "api-search-1",
    peaklistId,
    parameterSetId,
  });
  assert.equal(searchResponse.status, 201);
  const searchId = (searchResponse.json as { searchId: number }).searchId;

  const candidates = await api("GET", `/searches/${searchId}/candidates?page=1&pageSize=5`);
  assert.equal(candidates.status, 200);
  const items = candidates.json.items as Array<Record<string, unknown>>;
  assert.ok(items.length > 0);
  assert.equal(items[0]!.peptideSequence, "ACG");

  const candidateId = items[0]!.id as number;
  const explanation = await api("GET", `/candidates/${candidateId}`);
  assert.equal(explanation.status, 200);
  const peakMatches = explanation.json.peakMatches as unknown[];
  assert.equal(peakMatches.length, 2);

  const report1 = await api("POST", `/searches/${searchId}/report`, { clientId: "report-1" });
  assert.equal(report1.status, 200);
  const report2 = await api("POST", `/searches/${searchId}/report`, { clientId: "report-1" });
  assert.equal(report2.json.reused, true);
  assert.equal(
    JSON.stringify(report1.json.payload),
    JSON.stringify(report2.json.payload),
  );
});

test("repeat submissions are idempotent", async () => {
  const peaks1 = await api("POST", "/peaklists", ACG_PEAKLIST);
  const peaks2 = await api("POST", "/peaklists", ACG_PEAKLIST);
  assert.equal(peaks1.json.id, peaks2.json.id);
  assert.equal(peaks2.json.reused, true);
});

test("mixed tolerance units are rejected with a dedicated error code", async () => {
  const response = await api("POST", "/parameter-sets", {
    ...SEARCH_PARAMS,
    label: "bad-units",
    fragmentUnit: "da",
  });
  assert.equal(response.status, 422);
  assert.equal((response.json.error as { code: string }).code, "MIXED_TOLERANCE_UNIT");
});

test("validation errors and unknown routes use explicit codes", async () => {
  const badPagination = await api("GET", "/proteins?page=0");
  assert.equal(badPagination.status, 400);
  assert.equal((badPagination.json.error as { code: string }).code, "VALIDATION_ERROR");
  const missing = await api("GET", "/proteins/DOES_NOT_EXIST");
  assert.equal(missing.status, 404);
  assert.equal((missing.json.error as { code: string }).code, "NOT_FOUND");
  const noRoute = await api("GET", "/nope");
  assert.equal(noRoute.status, 404);
});

test("non-JSON content type on a body request is rejected", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/peaklists`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not-json",
  });
  assert.equal(response.status, 415);
});
