import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initDatabase } from "../db/database.js";
import { realClock } from "../utils/clock.js";
import { importProtein, getProtein, resolveProteinId } from "../services/proteinService.js";
import { importPeakTable, getPeakTable } from "../services/peakTableService.js";
import { createAnalysis } from "../services/analysisService.js";
import { runAndFreeze, getReport, exportReport } from "../services/reportService.js";
import { digest, TRYPSIN } from "../domain/digestion.js";
import { theoreticalSpectrum } from "../domain/ions.js";
import { neutralMass, precursorMz } from "../domain/mass.js";
import { loadMassTable } from "../services/massTableService.js";

type Argv = Record<string, string | boolean>;

function parseArgs(args: string[]): { command: string; opts: Argv } {
  const command = args[0];
  const opts: Argv = {};
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { command, opts };
}

function need(opts: Argv, key: string): string {
  const v = opts[key];
  if (typeof v !== "string") throw new Error(`Missing required option --${key}`);
  return v;
}

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(none)";
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
  );
  const line = (vals: unknown[]) =>
    vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c])))]
    .join("\n");
}

function count(db: ReturnType<typeof initDatabase>, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

export async function runCli(argv: string[]): Promise<number> {
  const { command, opts } = parseArgs(argv);
  const dbPath = (opts.db as string) ?? process.env.PROTEOMICS_DB ?? "data/proteomics.db";
  const db = initDatabase(resolve(dbPath));
  const clock = realClock;

  try {
    switch (command) {
      case "import-protein": {
        let sequence = need(opts, "sequence");
        if (sequence.startsWith("@")) sequence = readFileSync(resolve(sequence.slice(1)), "utf8").replace(/\s+/g, "");
        const before = count(db, "SELECT COUNT(*) c FROM proteins");
        const result = importProtein(
          db,
          {
            accession: need(opts, "accession"),
            name: (opts.name as string) ?? need(opts, "accession"),
            sequence,
            aliases: opts.aliases ? String(opts.aliases).split(",").map((s) => s.trim()) : [],
          },
          clock
        );
        const after = count(db, "SELECT COUNT(*) c FROM proteins");
        console.log(`BEFORE: proteins=${before}  AFTER: proteins=${after}`);
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "list-proteins": {
        const rows = db
          .prepare("SELECT id, accession, version, name, sequence_length AS len FROM proteins ORDER BY id")
          .all();
        console.log(table(rows as Record<string, unknown>[]));
        return 0;
      }
      case "preview-digest": {
        const id = resolveProteinId(db, need(opts, "protein"));
        const protein = getProtein(db, id);
        const missed = parseInt((opts.missed as string) ?? "0", 10) || 0;
        const peptides = digest(protein.sequence, TRYPSIN, missed);
        console.log(
          `Protein ${protein.accession} (${protein.sequenceLength} aa), trypsin, max missed=${missed}`
        );
        console.log(
          table(
            peptides.map((p) => ({
              start: p.start,
              end: p.end,
              mc: p.missedCleavages,
              sequence: p.sequence,
            }))
          )
        );
        console.log(`peptide count: ${peptides.length}`);
        return 0;
      }
      case "theoretical-spectrum": {
        const id = resolveProteinId(db, need(opts, "protein"));
        const protein = getProtein(db, id);
        const charge = parseInt((opts.charge as string) ?? "1", 10) || 1;
        const missed = parseInt((opts.missed as string) ?? "0", 10) || 0;
        const mt = db.prepare("SELECT id FROM mass_tables WHERE name='monoisotopic_v1'").get() as { id: number };
        const massTable = loadMassTable(db, mt.id);
        const peptides = digest(protein.sequence, TRYPSIN, missed);
        for (const p of peptides) {
          const m = neutralMass(p.sequence, massTable);
          console.log(
            `\nPeptide ${p.start}-${p.end} ${p.sequence}  M=${m.toFixed(5)}  precursor(z=${charge})=${precursorMz(m, charge).toFixed(5)}`
          );
          const ions = theoreticalSpectrum(p.sequence, charge, massTable);
          console.log(
            table(
              ions.map((ion) => ({
                ion: `${ion.type}${ion.number}`,
                charge: ion.charge,
                mz: ion.mz.toFixed(5),
              }))
            )
          );
        }
        return 0;
      }
      case "import-peaks": {
        const file = need(opts, "file");
        const parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
        const before = count(db, "SELECT COUNT(*) c FROM peak_tables");
        const result = importPeakTable(
          db,
          {
            name: need(opts, "name"),
            description: parsed.description,
            precursorMz: parsed.precursorMz,
            precursorCharge: parsed.precursorCharge,
            peaks: parsed.peaks,
          },
          clock
        );
        const after = count(db, "SELECT COUNT(*) c FROM peak_tables");
        console.log(`BEFORE: peak_tables=${before}  AFTER: peak_tables=${after}`);
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "list-peak-tables": {
        const rows = db
          .prepare("SELECT id, name, precursor_mz AS precursor, precursor_charge AS charge FROM peak_tables ORDER BY id")
          .all();
        console.log(table(rows as Record<string, unknown>[]));
        return 0;
      }
      case "create-analysis": {
        const before = count(db, "SELECT COUNT(*) c FROM analyses");
        const result = createAnalysis(
          db,
          {
            name: need(opts, "name"),
            maxMissedCleavages: parseInt(need(opts, "missed"), 10),
            precursorCharge: parseInt(need(opts, "charge"), 10),
            precursorTolerance: parseFloat(need(opts, "precursor-tol")),
            precursorToleranceUnit: need(opts, "precursor-unit"),
            fragmentTolerance: parseFloat(need(opts, "fragment-tol")),
            fragmentToleranceUnit: need(opts, "fragment-unit"),
            modifications: opts.mods ? String(opts.mods).split(",").map((s) => s.trim()) : [],
          },
          clock
        );
        const after = count(db, "SELECT COUNT(*) c FROM analyses");
        console.log(`BEFORE: analyses=${before}  AFTER: analyses=${after}`);
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "list-analyses": {
        const rows = db
          .prepare("SELECT id, name, revision, precursor_charge AS z, precursor_tolerance AS ptol, fragment_tolerance AS ftol FROM analyses ORDER BY id")
          .all();
        console.log(table(rows as Record<string, unknown>[]));
        return 0;
      }
      case "search": {
        const analysisId = parseInt(need(opts, "analysis"), 10);
        const peakTableId = parseInt(need(opts, "peak-table"), 10);
        const before = count(db, "SELECT COUNT(*) c FROM reports");
        const result = runAndFreeze(db, analysisId, peakTableId, clock);
        const after = count(db, "SELECT COUNT(*) c FROM reports");
        console.log(`BEFORE: reports=${before}  AFTER: reports=${after}`);
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "explain": {
        const reportId = parseInt(need(opts, "report"), 10);
        getReport(db, reportId);
        const matches = db
          .prepare("SELECT id, rank, peptide_sequence AS peptide, protein_accession AS protein, start_position AS start, end_position AS end, matched_fragments AS matched, total_fragments AS total, score, ambiguous_group AS ambig FROM peptide_matches WHERE report_id=? ORDER BY rank, id")
          .all(reportId);
        console.log(table(matches as Record<string, unknown>[]));
        const matchId = opts.match ? parseInt(String(opts.match), 10) : (matches[0] as { id: number } | undefined)?.id;
        if (matchId) {
          const exps = db
            .prepare("SELECT peak_id AS peak, ion_type AS ion, ion_number AS n, ion_charge AS z, theoretical_mz AS theoretical, peak_mz AS observed, mass_error_ppm AS ppm FROM peak_explanations WHERE peptide_match_id=? ORDER BY id")
            .all(matchId);
          console.log("\nPeak-by-peak assignments:");
          console.log(table(exps as Record<string, unknown>[]));
        }
        return 0;
      }
      case "export-report": {
        const reportId = parseInt(need(opts, "report"), 10);
        const doc = exportReport(db, reportId);
        const out = opts.out ? resolve(String(opts.out)) : null;
        const json = JSON.stringify(doc, null, 2);
        if (out) {
          writeFileSync(out, json);
          console.log(`Report ${reportId} exported to ${out}`);
        } else {
          console.log(json);
        }
        return 0;
      }
      case "show-peak-table": {
        console.log(JSON.stringify(getPeakTable(db, parseInt(need(opts, "id"), 10)), null, 2));
        return 0;
      }
      case undefined:
      case "help": {
        console.log(
          [
            "Usage: proteomics-cli <command> [options]",
            "",
            "Commands:",
            "  import-protein --accession A --name N --sequence SEQ|@file [--aliases a,b]",
            "  list-proteins",
            "  preview-digest --protein ACCESSION_OR_ID [--missed N]",
            "  theoretical-spectrum --protein ID [--charge Z] [--missed N]",
            "  import-peaks --name N --file peaks.json",
            "  list-peak-tables",
            "  show-peak-table --id ID",
            "  create-analysis --name N --missed N --charge Z \\",
            "    --precursor-tol T --precursor-unit ppm|da \\",
            "    --fragment-tol T --fragment-unit ppm|da [--mods name,...]",
            "  list-analyses",
            "  search --analysis ID --peak-table ID",
            "  explain --report ID [--match MATCH_ID]",
            "  export-report --report ID [--out file.json]",
            "  help",
          ].join("\n")
        );
        return 0;
      }
      default:
        console.error(`Unknown command: ${command}. Try 'help'.`);
        return 1;
    }
  } catch (err) {
    console.error(`Error [${(err as { code?: string }).code ?? "ERROR"}]: ${(err as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
