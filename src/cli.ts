import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, seedReferenceData, defaultClock } from "./db/database.ts";
import { normalizeSequence, parseFasta, upsertProteinSequence } from "./services/proteins.ts";
import { importPeaklist } from "./services/peaklists.ts";
import { createParameterSet, getParameterSet } from "./services/parameters.ts";
import { executeSearch, freezeReport, listCandidates, explainCandidate, getSearch } from "./services/searches.ts";
import { loadEnzyme, loadFixedMods, previewDigest, generateTheoreticalSpectrum } from "./services/engine.ts";

interface CliContext {
  dbPath: string;
}

function parseArgs(argv: string[]): { command: string; options: Map<string, string>; positionals: string[] } {
  const options = new Map<string, string>();
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) options.set(arg.slice(2, eq), arg.slice(eq + 1));
      else options.set(arg.slice(2), "true");
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] ?? "help", options, positionals: positionals.slice(1) };
}

function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}
function status(db: import("node:sqlite").DatabaseSync): void {
  const counts = {
    proteins: (db.prepare("SELECT COUNT(*) c FROM proteins").get() as { c: number }).c,
    peaklists: (db.prepare("SELECT COUNT(*) c FROM peaklists").get() as { c: number }).c,
    searches: (db.prepare("SELECT COUNT(*) c FROM searches").get() as { c: number }).c,
  };
  console.log(`[state] proteins=${counts.proteins} peaklists=${counts.peaklists} searches=${counts.searches}`);
}

async function main(): Promise<number> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const dbPath = options.get("db") ?? process.env.PEPTIDEMATCH_DB ?? "data/peptidematch.sqlite";
  const db = openDatabase(dbPath);
  const defaults = seedReferenceData(db);
  const ctx: CliContext = { dbPath };

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      case "import": {
        const file = requireOption(options, "fasta", "import --fasta=<path>");
        const text = readFileSync(file, "utf8");
        const parsed = parseFasta(text);
        header(`before import (${parsed.length} records in ${file})`);
        status(db);
        const results = parsed.map((protein) =>
          upsertProteinSequence(db, { ...protein, clientId: options.get("client-id") }, defaultClock),
        );
        header("after import");
        status(db);
        results.forEach((result, index) => {
          console.log(`- ${parsed[index]!.accession}: proteinId=${result.proteinId} versionId=${result.sequenceVersionId}${result.created ? " (new)" : " (current)"}`);
        });
        return 0;
      }
      case "digest": {
        const sequence = normalizeSequence(options.get("sequence") ?? readSequenceOption(options));
        const enzyme = loadEnzyme(db, Number(options.get("enzyme-id") ?? defaults.trypsinId));
        const maxMissed = Number(options.get("missed") ?? "0");
        const modIds = parseNumberList(options.get("mods"));
        const fixedMods = loadFixedMods(db, modIds);
        header(`digest preview enzyme=${enzyme.name} maxMissed=${maxMissed} mods=[${fixedMods.map((m) => m.name).join(",")}]`);
        const fragments = previewDigest(db, sequence, enzyme, maxMissed, defaults.massRevisionId, fixedMods);
        fragments.forEach((fragment) => {
          console.log(
            `${fragment.start}-${fragment.end} mc=${fragment.missedCleavages} mass=${fragment.neutralMass.toFixed(5)} m/z(z=2)=${fragment.precursorMzCharge2.toFixed(5)} ${fragment.sequence}`,
          );
        });
        return 0;
      }
      case "spectrum": {
        const sequence = normalizeSequence(options.get("sequence") ?? readSequenceOption(options));
        const modIds = parseNumberList(options.get("mods"));
        const parsedCharges = parseNumberList(options.get("fragment-charges"));
        const fragmentCharges = parsedCharges.length > 0 ? parsedCharges : [1];
        const ions = generateTheoreticalSpectrum(
          db,
          sequence,
          defaults.massRevisionId,
          loadFixedMods(db, modIds ?? []),
          fragmentCharges,
        );
        header(`theoretical spectrum for ${sequence}`);
        ions.forEach((ion) =>
          console.log(`${ion.series}${ion.number} z=${ion.charge} m/z=${ion.mz.toFixed(5)}`),
        );
        return 0;
      }
      case "import-peaks": {
        const file = requireOption(options, "peaks", "import-peaks --peaks=<path> --client-id=<id>");
        const clientId = requireOption(options, "client-id", "import-peaks --client-id=<id>");
        const payload = JSON.parse(readFileSync(file, "utf8")) as {
          label: string;
          precursorMz: number;
          chargeHint?: number;
          peaks: Array<{ mz: number; intensity: number }>;
        };
        header("before peak import");
        status(db);
        const result = importPeaklist(db, { ...payload, clientId }, defaultClock);
        header(`after peak import -> peaklistId=${result.id}${result.reused ? " (reused, idempotent)" : ""}`);
        status(db);
        return 0;
      }
      case "search": {
        const peaklistId = Number(requireOption(options, "peaklist-id", "search --peaklist-id=<n>"));
        const paramFile = options.get("params-file");
        let parameterSetId = Number(options.get("parameter-set-id") ?? "NaN");
        if (!Number.isFinite(parameterSetId)) {
          if (!paramFile) throw new Error("provide --parameter-set-id=<n> or --params-file=<path>");
          const raw = JSON.parse(readFileSync(paramFile, "utf8"));
          parameterSetId = createParameterSet(db, raw, defaults, defaultClock);
          console.log(`[params] created parameter set ${parameterSetId}: ${(getParameterSet(db, parameterSetId) as { label: string }).label}`);
        }
        const clientId = requireOption(options, "client-id", "search --client-id=<id>");
        header("before search");
        status(db);
        const result = executeSearch(db, { clientId, peaklistId, parameterSetId }, defaultClock);
        header(`search ${result.searchId}${result.reused ? " (reused, idempotent)" : ""}`);
        const candidates = listCandidates(db, { searchId: result.searchId, page: 1, pageSize: 10 });
        console.log(`candidate count: ${candidates.total}`);
        (candidates.items as Array<Record<string, unknown>>).slice(0, 10).forEach((candidate) => {
          console.log(
            `#${candidate.rank} ${candidate.peptideSequence} score=${candidate.score} matched=${candidate.matchedPeakCount} ambiguous=${candidate.ambiguousProtein}`,
          );
        });
        return 0;
      }
      case "explain": {
        const candidateId = Number(requireOption(options, "candidate-id", "explain --candidate-id=<n>"));
        const detail = explainCandidate(db, candidateId);
        header(`candidate ${candidateId}: ${(detail.candidate as { peptide_sequence: string }).peptide_sequence}`);
        (detail.occurrences as unknown[]).forEach((occurrence) => console.log("occurrence:", JSON.stringify(occurrence)));
        (detail.peakMatches as unknown[]).forEach((match) => console.log("peak match:", JSON.stringify(match)));
        return 0;
      }
      case "report": {
        const searchId = Number(requireOption(options, "search-id", "report --search-id=<n>"));
        getSearch(db, searchId);
        const clientId = options.get("client-id") ?? `report-${searchId}`;
        const report = freezeReport(db, searchId, clientId, defaultClock);
        const out = options.get("out") ?? `data/report-search-${searchId}.json`;
        writeFileSync(resolve(out), JSON.stringify(report.payload, null, 2));
        console.log(`[report] ${report.reused ? "reused frozen" : "froze new"} report id=${report.id} -> ${out}`);
        return 0;
      }
      default:
        console.error(`unknown command: ${command}`);
        printHelp();
        return 2;
    }
  } finally {
    db.close();
    void ctx;
  }
}

function requireOption(options: Map<string, string>, key: string, usage: string): string {
  const value = options.get(key);
  if (value === undefined) throw new Error(`missing --${key}. usage: ${usage}`);
  return value;
}

function parseNumberList(value: string | undefined): number[] {
  if (!value) return [];
  return value.split(",").map((part) => Number(part.trim())).filter((n) => Number.isFinite(n));
}

function readSequenceOption(options: Map<string, string>): string {
  const file = options.get("sequence-file");
  if (file) return readFileSync(file, "utf8");
  throw new Error("provide --sequence=<SEQ> or --sequence-file=<path>");
}

function printHelp(): void {
  console.log(`peptidematch CLI (local-only, no network)

usage:
  npm run cli -- <command> [options]

commands:
  import        --fasta=<path>
  digest        --sequence=<SEQ> | --sequence-file=<path> [--missed=<n>] [--mods=1]
  spectrum      --sequence=<SEQ> [--mods=1] [--fragment-charges=1,2]
  import-peaks  --peaks=<json> --client-id=<id>
  search        --peaklist-id=<n> (--parameter-set-id=<n> | --params-file=<json>) --client-id=<id>
  explain       --candidate-id=<n>
  report        --search-id=<n> [--out=<path>] [--client-id=<id>]

global:
  --db=<path>  (default data/peptidematch.sqlite)`);
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: Error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
