# Proteomics Backend — Local Protein Digestion & Peptide MS Candidate Matching

A self-contained, **local-only** Windows-runnable backend for:

- managing protein aliases and **versioned** sequences,
- **trypsin digestion** with the K/R followed-by-P exception and bounded
  missed cleavages, retaining peptide start/end positions in every source
  protein,
- computing **monoisotopic neutral masses**, charged precursors and **b/y
  fragment ion m/z** with explicit water/proton stoichiometry,
- matching observed peak tables against theoretical spectra with
  **ppm or Da** tolerances (never mixed within one analysis), strict
  **one-peak-to-one-ion** assignment, and **ambiguity-preserving** ranking for
  shared/isomeric peptides,
- freezing **immutable reports**, with parameter/mass-table **revisions**
  producing new analyses so historical results remain reproducible.

There is **no web UI**, no connection to any real biological database, and no
control of laboratory equipment. All protein sequences and spectra are
fictional.

## Technology

- Node.js (tested on Node 25) and TypeScript
- SQLite via the built-in `node:sqlite` module (no native compilation needed)
- built-in `node:http` for the API and `node:test` for tests

No external services are contacted.

## Requirements

- Node.js >= 22 (built-in `node:sqlite`); developed on Node 25
- npm

## Install

```powershell
npm install
```

This installs only TypeScript/tsx dev tooling; there are no runtime
dependencies.

## Project layout

```
src/domain/    mass constants, digestion, mass/ion math
src/db/        SQLite schema, repeatable migrations, reference seed data
src/services/  protein, peak-table, analysis, search engine, frozen reports
src/api/       HTTP API (loopback only), validation, pagination
src/cli/       command-line interface
scripts/       start/stop/migrate/demo/fixtures/clean helpers
fixtures/      generated fictional proteins, peak tables and expected values
test/          automated unit, integration, CLI, API and E2E tests
data/          SQLite database (created on first run)
temp/          project-local temporary files
```

## Mass model (stoichiometry)

Residue masses are the **residue** masses (free amino acid minus water), so a
residue mass is never treated as a complete molecule:

- neutral peptide mass: `M = sum(residue masses) + H2O`, with
  `H2O = 18.010564684 Da`
- precursor: `m/z = (M + z * H+) / z`, with `H+ = 1.00727646688 Da`
- b ions: `b_i = (sum(residues 1..i) + z*H+) / z` (no water; acylium ion)
- y ions: `y_i = (sum(residues last i) + H2O + z*H+) / z`

The hand-verified example for `AAGK` (see `fixtures/expected-aagk.json`):
neutral mass `345.201219029`, precursor z=2 `173.607885981`, b1 `72.044390272`,
y1 `147.112804166`.

## Matching rules

- Precursor and fragment tolerance each carry an explicit unit (`ppm` or `da`).
  One analysis requires the **same unit for both** (mixing is rejected with
  `TOLERANCE_UNIT_MISMATCH`).
- During scoring, each observed peak explains **at most one** theoretical ion
  and each theoretical ion is used at most once. Candidate peak/ion pairs are
  resolved greedily by increasing absolute mass error with deterministic
  tie-breaks.
- Peptides shared between proteins keep **all** source locations; ties and
  multi-source peptides carry an `ambiguous_group` and are never collapsed to a
  single protein.
- Only **fixed** modifications (e.g. carbamidomethyl-C) are supported. Unknown
  modifications or sequences are never guessed.

## Automated tests

```powershell
npm test
```

The suite (47 tests) covers:

- terminal K/R, KP/RP exceptions, consecutive cut sites, missed cleavages,
  source positions,
- hand-calculated short-peptide neutral masses, precursor charges and b/y
  series,
- ppm/Da unit conversion and inclusive tolerance boundaries
  (exactly ±10 ppm matches, +10.0001 ppm does not),
- shared peptides, peak non-reuse, deterministic stable ranking, multiple
  precursor charges, and no-match spectra,
- validation/failure paths and explicit error codes,
- idempotent imports/submissions, analysis revisioning, transaction rollback,
- a full CLI workflow, and persistence/reproduction after a simulated restart.

Time and UUIDs are injected via a fixed clock in tests for determinism.

Regenerate the deterministic fixtures with:

```powershell
npm run fixtures
```

## End-to-end demonstration

```powershell
npm run demo
```

This builds a throwaway database at `temp/demo.db`, imports the fictional
proteins, digests them, prints hand-verified masses and the b/y series,
imports a synthetic peak table, runs a search, freezes a report, shows the
per-peak explanation and demonstrates idempotency. Output is deterministic and
reproducible.

## Running the API server

Start (binds to `127.0.0.1` only, on an OS-assigned free port; the port is
written to `server.port`):

```powershell
npm start
$port = Get-Content server.port
Invoke-RestMethod "http://127.0.0.1:$port/api/health"
```

Stop (only the process recorded in `server.pid`):

```powershell
npm run stop
```

Run repeatable migrations independently:

```powershell
npm run migrate
```

## CLI

The CLI prints BEFORE/AFTER state for mutating operations.

```powershell
# import a fictional protein (sequence inline or via @file)
npm run cli -- import-protein --accession FAKE_ALPHA --name alpha --sequence GKAAGK --aliases ALPHA_FICTION
npm run cli -- list-proteins

# preview digestion and generate theoretical spectra
npm run cli -- preview-digest --protein FAKE_ALPHA --missed 1
npm run cli -- theoretical-spectrum --protein FAKE_ALPHA --charge 2

# import an observed peak table
npm run cli -- import-peaks --name SPEC1 --file fixtures/peaks_aagk_z2.json
npm run cli -- list-peak-tables

# create an analysis (units must agree)
npm run cli -- create-analysis --name A1 --missed 1 --charge 2 `
  --precursor-tol 10 --precursor-unit ppm `
  --fragment-tol 10 --fragment-unit ppm
npm run cli -- list-analyses

# search, explain per-peak matches, export the frozen report
npm run cli -- search --analysis 1 --peak-table 1
npm run cli -- explain --report 1
npm run cli -- export-report --report 1 --out temp/report.json
```

Use `--db <path>` or the `PROTEOMICS_DB` environment variable to point at a
different database file.

## HTTP API (summary)

All responses are JSON. List endpoints accept `?page=` and `?pageSize=`
(pageSize capped at 200) and return pagination metadata. Errors use
`{ "error": { "code", "message", "details?" } }` with an appropriate HTTP
status.

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/api/health` | liveness |
| POST | `/api/proteins` | import/version a protein (idempotent) |
| GET  | `/api/proteins` | list proteins (paginated) |
| GET  | `/api/proteins/:id` | protein detail incl. aliases |
| GET  | `/api/proteins/:id/digest?missed=&enzyme=` | preview digestion |
| GET  | `/api/proteins/:id/spectrum?charge=&missed=` | theoretical spectrum |
| GET  | `/api/mass-tables` / `/api/enzymes` / `/api/modifications` | reference data |
| POST | `/api/analyses` | create/revision a parameter set |
| GET  | `/api/analyses` | list analyses (paginated) |
| POST | `/api/peak-tables` | import observed peaks (idempotent on name) |
| GET  | `/api/peak-tables` / `/:id` | list/get peak tables |
| POST | `/api/search` | run search, freeze report (idempotent on analysis+peak table) |
| GET  | `/api/reports/:id` | frozen report header |
| GET  | `/api/reports/:id/peptides` | ranked matches (paginated) |
| GET  | `/api/reports/:id/explanations?peptideMatchId=` | per-peak assignments |
| GET  | `/api/reports/:id?format=json` | full frozen report export |

### Example search

```powershell
$port = Get-Content server.port
$base = "http://127.0.0.1:$port"
Invoke-RestMethod "$base/api/search" -Method Post -ContentType 'application/json' `
  -Body '{"analysisId":1,"peakTableId":1}'
Invoke-RestMethod "$base/api/reports/1/peptides"
```

## Error codes

`VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `TOLERANCE_UNIT_MISMATCH`,
`INVALID_SEQUENCE`, `INVALID_TOLERANCE`, `INVALID_MASS_TABLE`,
`INVALID_PEAK_TABLE`, `INVALID_CHARGE`, `REPORT_FROZEN`,
`TRANSACTION_FAILED`, `INTERNAL_ERROR`.

## Data, cleanup and process scope

- All runtime data stays in `data/` and `temp/` inside this project.
- `npm run clean` removes only project-local databases, `temp` artifacts,
  `dist/`, and the pid/port files.
- Start/stop scripts manage only the server process recorded in
  `server.pid`; they never touch unrelated processes.
- The server listens only on the loopback interface (`127.0.0.1`) and uses an
  automatically assigned port.
