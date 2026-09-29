import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { AppError, httpStatusForCode } from "../utils/errors.js";
import { realClock, type Clock } from "../utils/clock.js";
import { parsePageParams, paginate } from "../utils/pagination.js";
import { importProtein, getProtein } from "../services/proteinService.js";
import { importPeakTable, getPeakTable } from "../services/peakTableService.js";
import { createAnalysis } from "../services/analysisService.js";
import { runAndFreeze, getReport, exportReport } from "../services/reportService.js";
import { digest, TRYPSIN } from "../domain/digestion.js";
import { theoreticalSpectrum } from "../domain/ions.js";
import { neutralMass, precursorMz } from "../domain/mass.js";
import { loadMassTable } from "../services/massTableService.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body is not valid JSON");
  }
}

export function createApp(db: DatabaseSync, clock: Clock = realClock) {
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    try {
      // ---- health ----
      if (method === "GET" && path === "/api/health") {
        return send(res, 200, { status: "ok", time: clock.now() });
      }

      // ---- proteins ----
      if (method === "POST" && path === "/api/proteins") {
        const body = await readJson(req);
        const result = importProtein(db, body, clock);
        return send(res, result.updated ? 201 : 200, result);
      }
      if (method === "GET" && path === "/api/proteins") {
        const { page, pageSize } = parsePageParams(url.searchParams);
        const total = (db.prepare("SELECT COUNT(*) c FROM proteins").get() as { c: number }).c;
        const rows = db
          .prepare(
            "SELECT id, accession, version, name, sequence_length, created_at FROM proteins ORDER BY id LIMIT ? OFFSET ?"
          )
          .all(pageSize, (page - 1) * pageSize);
        return send(res, 200, paginate(rows, total, { page, pageSize }));
      }
      const proteinMatch = path.match(/^\/api\/proteins\/(\d+)$/);
      if (method === "GET" && proteinMatch) {
        return send(res, 200, getProtein(db, Number(proteinMatch[1])));
      }
      const digestMatch = path.match(/^\/api\/proteins\/(\d+)\/digest$/);
      if (method === "GET" && digestMatch) {
        const protein = getProtein(db, Number(digestMatch[1]));
        const missed = Math.max(
          0,
          parseInt(url.searchParams.get("missed") ?? "0", 10) || 0
        );
        const enzymeName = url.searchParams.get("enzyme") ?? TRYPSIN.name;
        const enzyme =
          enzymeName === TRYPSIN.name
            ? TRYPSIN
            : (() => {
                const row = db.prepare("SELECT * FROM enzymes WHERE name=?").get(enzymeName) as
                  | { cleave_after: string; exception_residue: string }
                  | undefined;
                if (!row) throw new AppError("NOT_FOUND", `Enzyme '${enzymeName}' not found`);
                return {
                  name: enzymeName,
                  cleaveAfter: JSON.parse(row.cleave_after),
                  exceptionResidue: row.exception_residue,
                };
              })();
        const peptides = digest(protein.sequence, enzyme, missed);
        return send(res, 200, { protein: protein.accession, enzyme: enzyme.name, maxMissedCleavages: missed, peptides });
      }

      // ---- theoretical spectrum ----
      const specMatch = path.match(/^\/api\/proteins\/(\d+)\/spectrum$/);
      if (method === "GET" && specMatch) {
        const protein = getProtein(db, Number(specMatch[1]));
        const charge = Math.max(1, parseInt(url.searchParams.get("charge") ?? "1", 10) || 1);
        const missed = Math.max(0, parseInt(url.searchParams.get("missed") ?? "0", 10) || 0);
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const peptides = digest(protein.sequence, TRYPSIN, missed).filter(
          (p) =>
            (!startParam || p.start === Number(startParam)) &&
            (!endParam || p.end === Number(endParam))
        );
        const massTable = loadMassTable(
          db,
          Number(
            (db.prepare("SELECT id FROM mass_tables WHERE name='monoisotopic_v1'").get() as { id: number }).id
          )
        );
        const spectra = peptides.map((p) => {
          const m = neutralMass(p.sequence, massTable);
          return {
            peptide: p.sequence,
            start: p.start,
            end: p.end,
            neutralMass: m,
            precursorMz: precursorMz(m, charge),
            ions: theoreticalSpectrum(p.sequence, charge, massTable),
          };
        });
        return send(res, 200, { charge, spectra });
      }

      // ---- reference data ----
      if (method === "GET" && path === "/api/mass-tables") {
        return send(res, 200, db.prepare("SELECT * FROM mass_tables").all());
      }
      if (method === "GET" && path === "/api/modifications") {
        return send(res, 200, db.prepare("SELECT * FROM modifications").all());
      }
      if (method === "GET" && path === "/api/enzymes") {
        return send(res, 200, db.prepare("SELECT * FROM enzymes").all());
      }

      // ---- analyses ----
      if (method === "POST" && path === "/api/analyses") {
        const body = await readJson(req);
        return send(res, 201, createAnalysis(db, body, clock));
      }
      if (method === "GET" && path === "/api/analyses") {
        const { page, pageSize } = parsePageParams(url.searchParams);
        const total = (db.prepare("SELECT COUNT(*) c FROM analyses").get() as { c: number }).c;
        const rows = db
          .prepare("SELECT * FROM analyses ORDER BY id DESC LIMIT ? OFFSET ?")
          .all(pageSize, (page - 1) * pageSize);
        return send(res, 200, paginate(rows, total, { page, pageSize }));
      }

      // ---- peak tables ----
      if (method === "POST" && path === "/api/peak-tables") {
        const body = await readJson(req);
        const result = importPeakTable(db, body, clock);
        return send(res, result.reused ? 200 : 201, result);
      }
      if (method === "GET" && path === "/api/peak-tables") {
        const { page, pageSize } = parsePageParams(url.searchParams);
        const total = (db.prepare("SELECT COUNT(*) c FROM peak_tables").get() as { c: number }).c;
        const rows = db
          .prepare("SELECT id, name, description, precursor_mz, precursor_charge, created_at FROM peak_tables ORDER BY id LIMIT ? OFFSET ?")
          .all(pageSize, (page - 1) * pageSize);
        return send(res, 200, paginate(rows, total, { page, pageSize }));
      }
      const peakMatch = path.match(/^\/api\/peak-tables\/(\d+)$/);
      if (method === "GET" && peakMatch) {
        return send(res, 200, getPeakTable(db, Number(peakMatch[1])));
      }

      // ---- search / reports ----
      if (method === "POST" && path === "/api/search") {
        const body = await readJson(req);
        if (!Number.isInteger(body.analysisId))
          throw new AppError("VALIDATION_ERROR", "Field 'analysisId' is required (integer)");
        if (!Number.isInteger(body.peakTableId))
          throw new AppError("VALIDATION_ERROR", "Field 'peakTableId' is required (integer)");
        const result = runAndFreeze(db, body.analysisId, body.peakTableId, clock);
        return send(res, result.reused ? 200 : 201, result);
      }
      const reportMatch = path.match(/^\/api\/reports\/(\d+)$/);
      if (method === "GET" && reportMatch && !url.searchParams.get("format")) {
        return send(res, 200, getReport(db, Number(reportMatch[1])));
      }
      const reportPeptides = path.match(/^\/api\/reports\/(\d+)\/peptides$/);
      if (method === "GET" && reportPeptides) {
        const id = Number(reportPeptides[1]);
        getReport(db, id);
        const { page, pageSize } = parsePageParams(url.searchParams);
        const total = (
          db.prepare("SELECT COUNT(*) c FROM peptide_matches WHERE report_id=?").get(id) as {
            c: number;
          }
        ).c;
        const rows = db
          .prepare(
            "SELECT * FROM peptide_matches WHERE report_id=? ORDER BY rank, id LIMIT ? OFFSET ?"
          )
          .all(id, pageSize, (page - 1) * pageSize);
        return send(res, 200, paginate(rows, total, { page, pageSize }));
      }
      const reportPeaks = path.match(/^\/api\/reports\/(\d+)\/explanations$/);
      if (method === "GET" && reportPeaks) {
        const id = Number(reportPeaks[1]);
        getReport(db, id);
        const matchId = url.searchParams.get("peptideMatchId");
        const sql = matchId
          ? "SELECT * FROM peak_explanations WHERE peptide_match_id=? ORDER BY id"
          : `SELECT pe.* FROM peak_explanations pe
             JOIN peptide_matches pm ON pm.id=pe.peptide_match_id
             WHERE pm.report_id=? ORDER BY pm.rank, pe.id`;
        const rows = matchId
          ? db.prepare(sql).all(Number(matchId))
          : db.prepare(sql).all(id);
        return send(res, 200, { items: rows });
      }
      if (method === "GET" && reportMatch && url.searchParams.get("format") === "json") {
        return send(res, 200, exportReport(db, Number(reportMatch[1])));
      }

      return send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${method} ${path}` } });
    } catch (err) {
      if (err instanceof AppError) {
        return send(res, httpStatusForCode(err.code), {
          error: { code: err.code, message: err.message, details: err.details },
        });
      }
      return send(res, 500, {
        error: { code: "INTERNAL_ERROR", message: (err as Error).message },
      });
    }
  }
  return handler;
}

export function startServer(
  db: DatabaseSync,
  opts: { port?: number; hostname?: string; clock?: Clock } = {}
): Promise<{ server: Server; port: number }> {
  const handler = createApp(db, opts.clock ?? realClock);
  const server = createServer(handler);
  return new Promise((resolve) => {
    // Bind only to loopback; port 0 lets the OS assign a free port.
    server.listen(opts.port ?? 0, opts.hostname ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
      resolve({ server, port });
    });
  });
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  const { initDatabase } = await import("../db/database.js");
  const dbPath = process.env.PROTEOMICS_DB ?? "data/proteomics.db";
  const db = initDatabase(dbPath);
  const { port } = await startServer(db);
  console.log(`Proteomics API listening on http://127.0.0.1:${port}`);
}
