export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proteins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accession TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  sequence TEXT NOT NULL,
  sequence_length INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(accession, version)
);

CREATE TABLE IF NOT EXISTS protein_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protein_id INTEGER NOT NULL,
  alias TEXT NOT NULL UNIQUE,
  FOREIGN KEY (protein_id) REFERENCES proteins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mass_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS residue_masses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mass_table_id INTEGER NOT NULL,
  residue TEXT NOT NULL,
  mass REAL NOT NULL,
  FOREIGN KEY (mass_table_id) REFERENCES mass_tables(id) ON DELETE CASCADE,
  UNIQUE(mass_table_id, residue)
);

CREATE TABLE IF NOT EXISTS modifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  residue TEXT NOT NULL,
  delta_mass REAL NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS enzymes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  cleave_after TEXT NOT NULL,
  exception_residue TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enzyme_id INTEGER NOT NULL,
  mass_table_id INTEGER NOT NULL,
  max_missed_cleavages INTEGER NOT NULL,
  precursor_charge INTEGER NOT NULL,
  precursor_tolerance REAL NOT NULL,
  precursor_tolerance_unit TEXT NOT NULL CHECK(precursor_tolerance_unit IN ('ppm','da')),
  fragment_tolerance REAL NOT NULL,
  fragment_tolerance_unit TEXT NOT NULL CHECK(fragment_tolerance_unit IN ('ppm','da')),
  modification_ids TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (enzyme_id) REFERENCES enzymes(id),
  FOREIGN KEY (mass_table_id) REFERENCES mass_tables(id),
  FOREIGN KEY (supersedes_id) REFERENCES analyses(id),
  UNIQUE(name, revision)
);

CREATE TABLE IF NOT EXISTS peak_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  precursor_mz REAL,
  precursor_charge INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peak_table_id INTEGER NOT NULL,
  peak_index INTEGER NOT NULL,
  mz REAL NOT NULL,
  intensity REAL NOT NULL DEFAULT 0,
  charge INTEGER,
  FOREIGN KEY (peak_table_id) REFERENCES peak_tables(id) ON DELETE CASCADE,
  UNIQUE(peak_table_id, peak_index)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_uuid TEXT NOT NULL UNIQUE,
  analysis_id INTEGER NOT NULL,
  peak_table_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  frozen_at TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  FOREIGN KEY (analysis_id) REFERENCES analyses(id),
  FOREIGN KEY (peak_table_id) REFERENCES peak_tables(id)
);

CREATE TABLE IF NOT EXISTS peptide_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  peptide_sequence TEXT NOT NULL,
  protein_id INTEGER NOT NULL,
  protein_accession TEXT NOT NULL,
  start_position INTEGER NOT NULL,
  end_position INTEGER NOT NULL,
  missed_cleavages INTEGER NOT NULL,
  neutral_mass REAL NOT NULL,
  precursor_mz_theoretical REAL NOT NULL,
  charge INTEGER NOT NULL,
  mass_error_ppm REAL NOT NULL,
  matched_fragments INTEGER NOT NULL,
  total_fragments INTEGER NOT NULL,
  fragment_coverage REAL NOT NULL,
  score REAL NOT NULL,
  rank INTEGER NOT NULL,
  ambiguous_group INTEGER,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS peak_explanations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peptide_match_id INTEGER NOT NULL,
  peak_id INTEGER NOT NULL,
  peak_mz REAL NOT NULL,
  ion_type TEXT NOT NULL CHECK(ion_type IN ('b','y')),
  ion_number INTEGER NOT NULL,
  ion_charge INTEGER NOT NULL,
  theoretical_mz REAL NOT NULL,
  mass_error_ppm REAL NOT NULL,
  mass_error_da REAL NOT NULL,
  FOREIGN KEY (peptide_match_id) REFERENCES peptide_matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proteins_accession ON proteins(accession);
CREATE INDEX IF NOT EXISTS idx_aliases_protein ON protein_aliases(protein_id);
CREATE INDEX IF NOT EXISTS idx_peaks_table ON peaks(peak_table_id);
CREATE INDEX IF NOT EXISTS idx_matches_report ON peptide_matches(report_id);
CREATE INDEX IF NOT EXISTS idx_explanations_match ON peak_explanations(peptide_match_id);
`,
  },
];
