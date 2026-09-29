/**
 * Physical constants used throughout mass calculations.
 *
 * A peptide is a complete molecule: its neutral monoisotopic mass is the sum
 * of residue masses (each amino acid minus H2O) plus one water molecule for
 * the N/C termini. Ion m/z adds z protons and divides by z.
 */

/** Monoisotopic mass of a water molecule H2O (Da): 2*1.00782503223 + 15.99491461957. */
export const WATER_MONOISOTOPIC = 18.0105646837;

/** Monoisotopic mass of a proton 1H+ (Da). */
export const PROTON_MASS = 1.007276466621;

/**
 * Default amino-acid residue (residue-only) monoisotopic masses in Da.
 * Source values are standard textbook monoisotopic residue masses
 * (e.g. Lehninger / expasy-style); no external database is contacted.
 */
export const DEFAULT_RESIDUE_MASSES: Record<string, number> = {
  G: 57.02146372,
  A: 71.03711378,
  S: 87.03202840,
  P: 97.05276385,
  V: 99.06841391,
  T: 101.04767847,
  C: 103.00918450,
  // Carbamidomethylated C (fixed mod target in fixtures) uses unmodified C here.
  L: 113.08406398,
  I: 113.08406398,
  N: 114.04292744,
  D: 115.02694302,
  Q: 128.05857751,
  K: 128.09496301,
  E: 129.04259309,
  M: 131.04048465,
  H: 137.05891187,
  F: 147.06841391,
  R: 156.10111102,
  Y: 163.06332853,
  W: 186.07931295,
};

export const TOLERANCE = 1e-12;
