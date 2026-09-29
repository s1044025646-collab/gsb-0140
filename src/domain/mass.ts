import { WATER_MONOISOTOPIC, PROTON_MASS, DEFAULT_RESIDUE_MASSES } from "./constants.js";

/**
 * Resolve the effective residue mass for a single residue, applying any
 * fixed modification delta registered for that residue.
 */
export function residueMass(
  residue: string,
  massTable: Record<string, number>,
  modificationDeltas: Record<string, number> = {}
): number {
  const base = massTable[residue];
  if (base === undefined) {
    throw new Error(`Unknown residue: ${residue}`);
  }
  const delta = modificationDeltas[residue] ?? 0;
  return base + delta;
}

/**
 * Neutral monoisotopic mass of a peptide.
 *
 * Stoichiometry: the sum of residue masses already excludes one H2O per
 * residue; the full molecule is obtained by adding back one H2O
 * (N-terminal H + C-terminal OH).
 *
 *   M_neutral = sum(residue masses) + H2O
 *
 * @param sequence  peptide sequence (one-letter residues)
 * @param massTable residue mass table (defaults to standard 20 AA)
 * @param modificationDeltas optional map residue -> fixed modification delta
 */
export function neutralMass(
  sequence: string,
  massTable: Record<string, number> = DEFAULT_RESIDUE_MASSES,
  modificationDeltas: Record<string, number> = {}
): number {
  let sum = 0;
  for (const ch of sequence) {
    sum += residueMass(ch, massTable, modificationDeltas);
  }
  return sum + WATER_MONOISOTOPIC;
}

/**
 * Precursor m/z for [M + zH]^z+.
 *
 *   m/z = (M_neutral + z * H+) / z
 *
 * @param neutralMass neutral monoisotopic mass
 * @param charge positive integer charge state
 */
export function precursorMz(neutralMass: number, charge: number): number {
  if (!Number.isInteger(charge) || charge < 1) {
    throw new Error(`Charge must be a positive integer, got ${charge}`);
  }
  return (neutralMass + charge * PROTON_MASS) / charge;
}

/**
 * Mass error in parts-per-million (ppm).
 * ppm = (observed - theoretical) / theoretical * 1e6
 */
export function ppmError(observed: number, theoretical: number): number {
  return ((observed - theoretical) / theoretical) * 1_000_000;
}

/**
 * Absolute mass error in Daltons.
 */
export function daError(observed: number, theoretical: number): number {
  return observed - theoretical;
}

/**
 * Convert a tolerance value to Daltons for a given theoretical m/z.
 * @param value tolerance value
 * @param unit "ppm" or "da"
 * @param theoreticalMhz the theoretical m/z to convert against (needed for ppm)
 */
export function toleranceToDa(
  value: number,
  unit: "ppm" | "da",
  theoreticalMhz: number
): number {
  if (unit === "ppm") {
    return (value * theoreticalMhz) / 1_000_000;
  }
  return value;
}

/**
 * Check whether an observed m/z is within tolerance of a theoretical m/z.
 */
export function withinTolerance(
  observed: number,
  theoretical: number,
  toleranceValue: number,
  toleranceUnit: "ppm" | "da"
): boolean {
  const tolDa = toleranceToDa(toleranceValue, toleranceUnit, theoretical);
  // Scaled epsilon absorbs IEEE rounding at an exactly-on-the-boundary value.
  const eps = Math.max(Number.EPSILON, theoretical * 1e-12);
  return Math.abs(observed - theoretical) <= tolDa + eps;
}
