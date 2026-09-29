// Monoisotopic masses in daltons (Da).
// Residue mass = free amino acid mass - H2O (i.e. the mass incorporated
// into a peptide backbone at each position).

export const WATER_MONOISOTOPIC = 18.010564684; // H2O
export const PROTON_MASS = 1.00727646688;       // H+ used for m/z

// Standard 20 amino acid residue monoisotopic masses.
export const DEFAULT_RESIDUE_MASSES: Record<string, number> = {
  A: 71.037113805,
  R: 156.101111029,
  N: 114.042927447,
  D: 115.026943023,
  C: 103.009184509,
  E: 129.042593135,
  Q: 128.058577511,
  G: 57.021463720,
  H: 137.058911875,
  I: 113.084063974,
  L: 113.084063974,
  K: 128.094963015,
  M: 131.040484645,
  F: 147.068413912,
  P: 97.052763848,
  S: 87.032028403,
  T: 101.047678500,
  W: 186.079312950,
  Y: 163.063328530,
  V: 99.068413912,
};

export const AMINO_ACIDS = Object.keys(DEFAULT_RESIDUE_MASSES);

// Built-in fixed modifications (delta added to every occurrence of residue).
export interface BuiltinModification {
  name: string;
  residue: string;
  deltaMass: number;
  description: string;
}

export const BUILTIN_MODIFICATIONS: BuiltinModification[] = [
  {
    name: "Carbamidomethyl_C",
    residue: "C",
    deltaMass: 57.021464,
    description: "Carbamidomethylation of cysteine (fixed)",
  },
  {
    name: "Oxidation_M",
    residue: "M",
    deltaMass: 15.994915,
    description: "Oxidation of methionine (registered as fixed-only option)",
  },
];
