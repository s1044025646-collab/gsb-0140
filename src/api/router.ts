import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../db/database.ts";
import { ApiError, errorBody, type ErrorCode } from "./errors.ts";
import { MixedToleranceUnitError, UnknownResidueError } from "../core/matcher.ts";
import { getProteinDetail, listProteins, normalizeSequence, parseFasta, upsertProteinSequence } from "../services/proteins.ts";
import { importPeaklist, getPeaklist, listPeaklists } from "../services/peaklists.ts";
import {
  createParameterSet,
  getParameterSet,
  listParameterSets,
} from "../services/parameters.ts";
import {
  executeSearch,
  explainCandidate,
  freezeReport,
  getSearch,
  listCandidates,
} from "../services/searches.ts";
import { generateTheoreticalSpectrum, loadEnzyme, loadFixedMods, previewDigest } from "../services/engine.ts";

interface Context {
  db: DatabaseSync;
  clock: Clock;
  defaults: { massRevisionId: number; trypsinId: number; carbamidomethylId: number };
}

interface RouteResult {
  status: number;
  body: unknown;
}

const MAX_PAGE_SIZE = 200;

function pagination(url: URL): { page: number; pageSize: number } {
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "50");
  if (!Number.isInteger(page) || page < 1) {
    throw new ApiError("VALIDATION_ERROR", "page must be a positive integer");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ApiError("VALIDATION_ERROR", `pageSize must be 1..${MAX_PAGE_SIZE}`);
  }
  return { page, pageSize };
}

export async function route(
  method: string,
  pathname: string,
  url: URL,
  rawBody: string,
  ctx: Context,
): Promise<RouteResult> {
  const body = rawBody ? parseJsonBody(rawBody) : {};
  const { db, clock, defaults } = ctx;

  if (method === "GET" && pathname === "/health") {
    return { status: 200, body: { status: "ok", time: clock.now().toISOString() } };
  }

  if (method === "POST" && pathname === "/proteins/import-fasta") {
    const proteins = parseFasta(String(body.fasta ?? ""));
    if (proteins.length === 0) throw new ApiError("VALIDATION_ERROR", "no FASTA records found");
    const results = proteins.map((protein) => upsertProteinSequence(db, protein, clock));
    return { status: 200, body: { imported: results.length, results } };
  }
  if (method === "POST" && pathname === "/proteins") {
    const result = upsertProteinSequence(db, body as never, clock);
    return { status: 200, body: result };
  }
  if (method === "GET" && pathname === "/proteins") {
    return { status: 200, body: listProteins(db, ...Object.values(pagination(url)) as [number, number]) };
  }
  let match = /^\/proteins\/([^/]+)$/.exec(pathname);
  if (method === "GET" && match) {
    return { status: 200, body: getProteinDetail(db, decodeURIComponent(match[1]!)) };
  }

  if (method === "POST" && pathname === "/digest/preview") {
    const sequenceInput = String(body.sequence ?? "");
    const clean = normalizeSequence(sequenceInput);
    const enzyme = loadEnzyme(db, Number(body.enzymeId ?? defaults.trypsinId));
    const maxMissed = Number(body.maxMissedCleavages ?? 0);
    const fixedMods = loadFixedMods(db, (body.fixedModificationIds ?? []) as number[]);
    const fragments = previewDigest(db, clean, enzyme, maxMissed, defaults.massRevisionId, fixedMods);
    return { status: 200, body: { enzyme: enzyme.name, maxMissedCleavages: maxMissed, fragments } };
  }

  if (method === "POST" && pathname === "/spectra/theoretical") {
    const clean = normalizeSequence(String(body.sequence ?? ""));
    const fixedMods = loadFixedMods(db, (body.fixedModificationIds ?? []) as number[]);
    const fragmentCharges = (body.fragmentCharges ?? [1]) as number[];
    const ions = generateTheoreticalSpectrum(db, clean, defaults.massRevisionId, fixedMods, fragmentCharges);
    return { status: 200, body: { sequence: clean, ions } };
  }

  if (method === "POST" && pathname === "/peaklists") {
    return { status: 200, body: importPeaklist(db, body, clock) };
  }
  if (method === "GET" && pathname === "/peaklists") {
    return { status: 200, body: listPeaklists(db, ...Object.values(pagination(url)) as [number, number]) };
  }
  match = /^\/peaklists\/(\d+)$/.exec(pathname);
  if (method === "GET" && match) {
    return { status: 200, body: getPeaklist(db, Number(match[1])) };
  }

  if (method === "POST" && pathname === "/parameter-sets") {
    const id = createParameterSet(db, body, defaults, clock);
    return { status: 201, body: { id, parameterSet: getParameterSet(db, id) } };
  }
  if (method === "GET" && pathname === "/parameter-sets") {
    return { status: 200, body: listParameterSets(db, ...Object.values(pagination(url)) as [number, number]) };
  }
  match = /^\/parameter-sets\/(\d+)$/.exec(pathname);
  if (method === "GET" && match) {
    return { status: 200, body: getParameterSet(db, Number(match[1])) };
  }

  if (method === "POST" && pathname === "/searches") {
    const result = executeSearch(db, body, clock);
    return { status: 201, body: result };
  }
  match = /^\/searches\/(\d+)$/.exec(pathname);
  if (method === "GET" && match) {
    return { status: 200, body: getSearch(db, Number(match[1])) };
  }
  match = /^\/searches\/(\d+)\/candidates$/.exec(pathname);
  if (method === "GET" && match) {
    return {
      status: 200,
      body: listCandidates(db, {
        searchId: Number(match[1]),
        ...pagination(url),
      }),
    };
  }
  match = /^\/candidates\/(\d+)$/.exec(pathname);
  if (method === "GET" && match) {
    return { status: 200, body: explainCandidate(db, Number(match[1])) };
  }
  match = /^\/searches\/(\d+)\/report$/.exec(pathname);
  if (method === "POST" && match) {
    const report = freezeReport(
      db,
      Number(match[1]),
      String(body.clientId ?? `report-${match[1]}`),
      clock,
    );
    return { status: 200, body: report };
  }

  throw new ApiError("NOT_FOUND", `no route for ${method} ${pathname}`, 404);
}

function parseJsonBody(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ApiError("VALIDATION_ERROR", "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("VALIDATION_ERROR", "request body is not valid JSON");
  }
}

export function mapError(error: unknown): { status: number; body: unknown } {
  if (error instanceof ApiError) {
    return { status: error.status, body: errorBody(error.code, error.message, error.details) };
  }
  let code: ErrorCode = "INTERNAL_ERROR";
  let status = 500;
  if (error instanceof MixedToleranceUnitError) {
    code = "MIXED_TOLERANCE_UNIT";
    status = 422;
  } else if (error && typeof error === "object" && (error as { name?: string }).name === "UnknownResidueError") {
    code = "UNKNOWN_RESIDUE";
    status = 422;
  }
  return {
    status,
    body: errorBody(code, error instanceof Error ? error.message : "unexpected error"),
  };
}
