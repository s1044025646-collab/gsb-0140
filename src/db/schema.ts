/**
 * Idempotent SQL migrations. Every statement uses IF NOT EXISTS / INSERT OR
 * IGNORE so re-running migrations on an existing database is a no-op.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE IF NOT EXISTS proteins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accession TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS protein_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protein_id INTEGER NOT NULL REFERENCES proteins(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(protein_id, alias)
);
CREATE TABLE IF NOT EXISTS sequence_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protein_id INTEGER NOT NULL REFERENCES proteins(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  sequence TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(protein_id, version)
);
CREATE TABLE IF NOT EXISTS mass_table_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS residue_masses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES mass_table_revisions(id) ON DELETE CASCADE,
  residue TEXT NOT NULL,
  residue_mass REAL NOT NULL,
  UNIQUE(revision_id, residue)
);
CREATE TABLE IF NOT EXISTS enzymes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  cut_residues TEXT NOT NULL,
  no_cut_before TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fixed_modifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  residue TEXT NOT NULL,
  mass_shift REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS peaklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  precursor_mz REAL NOT NULL,
  charge_hint INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS peaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peaklist_id INTEGER NOT NULL REFERENCES peaklists(id) ON DELETE CASCADE,
  peak_index INTEGER NOT NULL,
  mz REAL NOT NULL,
  intensity REAL NOT NULL,
  UNIQUE(peaklist_id, peak_index)
);
CREATE TABLE IF NOT EXISTS parameter_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  precursor_tolerance REAL NOT NULL,
  precursor_unit TEXT NOT NULL CHECK (precursor_unit IN ('ppm','da')),
  fragment_tolerance REAL NOT NULL,
  fragment_unit TEXT NOT NULL CHECK (fragment_unit IN ('ppm','da')),
  charges TEXT NOT NULL,
  fixed_modification_ids TEXT NOT NULL DEFAULT '[]',
  fragment_charges TEXT NOT NULL DEFAULT '[1]',
  enzyme_id INTEGER NOT NULL REFERENCES enzymes(id),
  max_missed_cleavages INTEGER NOT NULL,
  mass_revision_id INTEGER NOT NULL REFERENCES mass_table_revisions(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  peaklist_id INTEGER NOT NULL REFERENCES peaklists(id),
  parameter_set_id INTEGER NOT NULL REFERENCES parameter_sets(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  peptide_sequence TEXT NOT NULL,
  precursor_charge INTEGER NOT NULL,
  precursor_mz_theoretical REAL NOT NULL,
  precursor_error_da REAL NOT NULL,
  precursor_error_ppm REAL NOT NULL,
  matched_peak_count INTEGER NOT NULL,
  total_intensity_matched REAL NOT NULL,
  score REAL NOT NULL,
  ambiguous_protein INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES search_candidates(id) ON DELETE CASCADE,
  protein_id INTEGER NOT NULL REFERENCES proteins(id),
  accession TEXT NOT NULL,
  sequence_version_id INTEGER NOT NULL REFERENCES sequence_versions(id),
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peak_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES search_candidates(id) ON DELETE CASCADE,
  peak_index INTEGER NOT NULL,
  observed_mz REAL NOT NULL,
  intensity REAL NOT NULL,
  ion_series TEXT NOT NULL CHECK (ion_series IN ('b','y')),
  ion_number INTEGER NOT NULL,
  ion_charge INTEGER NOT NULL,
  theoretical_mz REAL NOT NULL,
  error_da REAL NOT NULL,
  error_ppm REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER NOT NULL UNIQUE REFERENCES searches(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_protein ON protein_aliases(protein_id);
CREATE INDEX IF NOT EXISTS idx_seqver_protein ON sequence_versions(protein_id);
CREATE INDEX IF NOT EXISTS idx_peaks_peaklist ON peaks(peaklist_id);
CREATE INDEX IF NOT EXISTS idx_candidates_search ON search_candidates(search_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_candidate ON candidate_occurrences(candidate_id);
CREATE INDEX IF NOT EXISTS idx_peakmatches_candidate ON peak_matches(candidate_id);
`,
  },
];
