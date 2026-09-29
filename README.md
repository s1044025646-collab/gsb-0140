# peptidematch

Windows-local protein digestion and peptide MS/MS candidate-matching backend.

It is deliberately scoped:

- API only (JSON over HTTP) plus a CLI. There is **no web UI**.
- Fictional proteins and synthetic peak tables only (`fixtures/`).
  It **never connects to a real biological database** and never controls
  laboratory equipment.
- Everything (SQLite database, reports, temp files) stays inside this project.
- The HTTP server binds **loopback only** (`127.0.0.1`) and, by default,
  listens on an **OS-assigned ephemeral port** (port `0`).

## Requirements

- Node.js **>= 22.18** (developed and verified on Node 25.5 on Windows).
  The project uses Node's built-in `node:sqlite`, so there are **no native
  modules** and no external runtime dependencies. Only TypeScript type
  packages are installed under `devDependencies`.

## Install

```powershell
npm install
```

## Test

```powershell
npm test          # node:test suite (31 tests)
npm run typecheck # strict tsc --noEmit
```

Tests cover: terminal K/R, the KP/RP exception, consecutive cleavage sites,
missed-cleavage enumeration, shared peptides with per-protein positions,
multiple precursor charges, no-match searches, ppm/Da tolerance boundaries
(inclusive edges, no unit mixing), hand-computed ACG masses and b/y ions,
one-to-one peak consumption, stable ranking, idempotent repeat submissions,
transaction rollback, persistence across restart, and a full HTTP
end-to-end flow with explicit error codes and pagination.

## Repeatable end-to-end demonstration

```powershell
npm run demo
```

The demo always recreates `data/demo.sqlite`, imports the three fictional
proteins, runs z=1, z=2 and no-match searches, prints per-peak explanations
and freezes JSON reports. Fixed `clientId` values make every write
idempotent.

## CLI

All commands accept an optional global `--db=<path>` (default
`data/peptidematch.sqlite`). Mutating commands print project state before and
after the operation.

```powershell
# 1. import fictional sequences (FASTA)
npm run cli -- import --fasta=fixtures/proteins.fasta

# 2. preview tryptic digestion (missed cleavages, positions, masses)
npm run cli -- digest --sequence=MACKRPEPTIDEKR --missed=1

# 3. theoretical b/y spectrum for a peptide
npm run cli -- spectrum --sequence=ACG

# 4. import an observed peak table (idempotent on --client-id)
npm run cli -- import-peaks --peaks=fixtures/peaks-acg-z1.json --client-id=demo-peaks

# 5. create parameters (file) and run a search
npm run cli -- search --peaklist-id=1 --params-file=fixtures/search-params-ppm.json --client-id=demo-search

# 6. explain one candidate peak-by-peak
npm run cli -- explain --candidate-id=1

# 7. export a frozen report snapshot
npm run cli -- report --search-id=1 --out=data/report.json

npm run cli -- help
```

## API server

Start (loopback, ephemeral port; the chosen port is printed to stdout):

```powershell
npm start
# or, still loopback, with a fixed port:
$env:PORT="8090"; npm start
```

Stop: press Ctrl+C in that terminal, or use the helper scripts which only
manage processes started by this project:

```powershell
scripts/start.ps1   # writes .peptidematch.pid and data/server.out
scripts/stop.ps1    # stops exactly the pid recorded by start.ps1
```

### Endpoints

All request bodies are `application/json`. List endpoints accept
`?page=<n>&pageSize=<n>` (pageSize 1..200).

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/health` | liveness and injected/current time |
| POST | `/proteins` | upsert protein + immutable sequence version + aliases |
| POST | `/proteins/import-fasta` | bulk FASTA import |
| GET  | `/proteins` | paged protein list |
| GET  | `/proteins/{accession}` | aliases and sequence versions |
| POST | `/digest/preview` | tryptic preview with positions/masses |
| POST | `/spectra/theoretical` | theoretical b/y ions |
| POST | `/peaklists` | import observed peaks (idempotent by `clientId`) |
| GET  | `/peaklists` / `/peaklists/{id}` | list / fetch peaks |
| POST | `/parameter-sets` | immutable parameter set (new revision on change) |
| GET  | `/parameter-sets` / `/parameter-sets/{id}` | list / fetch |
| POST | `/searches` | run + freeze a search (idempotent by `clientId`) |
| GET  | `/searches/{id}/candidates` | paged ranked candidates with occurrences |
| GET  | `/candidates/{id}` | per-peak ion explanation |
| POST | `/searches/{id}/report` | frozen JSON report snapshot |

Errors use a stable envelope and code, e.g.

```json
{ "error": { "code": "MIXED_TOLERANCE_UNIT", "message": "..." } }
```

Codes: `VALIDATION_ERROR`, `NOT_FOUND` (404), `CONFLICT`,
`UNSUPPORTED_MEDIA_TYPE` (415), `MIXED_TOLERANCE_UNIT` (422),
`UNKNOWN_RESIDUE` (422), `BAD_REQUEST`, `INTERNAL_ERROR` (500).

## Chemistry and matching model

- Residue table values are **residue-only** monoisotopic masses
  (amino acid minus water). A peptide's neutral mass is
  `sum(residues) + H2O`; residue masses are never treated as molecular
  masses.
- Precursor m/z for charge z is `(M + z·H+) / z`.
- b-ion m/z is `sum(prefix residues) + H+`; y-ion m/z is
  `sum(suffix residues) + H2O + H+` (multi-charge fragments add
  `(z-1)·H+` and divide by z).
- Trypsin cuts on the C-terminal side of K/R, blocked when the next residue
  is P; missed cleavages 0..N are enumerated and each peptide keeps every
  source-protein `(accession, version, start, end)` occurrence.
- Precursor and fragment tolerances are independently numeric but the two
  **units must match within one search** (both `ppm` or both `da`).
- Peak/ion assignment is one-to-one and greedy on smallest absolute error,
  with deterministic tie-breaking, so an observed peak can never be counted
  twice. Shared peptides retain all protein occurrences; results are never
  forced onto a single protein.
- Parameter sets and mass-table revisions are immutable rows, so historical
  searches and frozen reports remain reproducible.

## Layout

- `src/core/` — mass, digestion, spectrum, matching (pure logic)
- `src/db/` — idempotent SQLite migrations and seeding
- `src/services/` — validation and transactional domain operations
- `src/api/`, `src/server.ts` — JSON HTTP API (loopback)
- `src/cli.ts` — command line interface
- `fixtures/` — fictional proteins, synthetic peaks, parameter JSON
- `tests/` — node:test suites
- `scripts/` — repeatable demo and process helpers
