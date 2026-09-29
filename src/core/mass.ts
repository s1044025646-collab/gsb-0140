import { PROTON_MASS, TOLERANCE, WATER_MONOISOTOPIC } from "./constants.ts";
import type { FixedModification, ToleranceUnit } from "./types.ts";

/**
 * Neutral monoisotopic mass of a peptide molecule:
 *   sum(residue masses) + H2O + fixed-modification shifts.
 * Residue masses alone are never treated as a molecular mass.
 */
export function peptideNeutralMass(
  sequence: string,
  residueMassTable: Map<string, number>,
  fixedMods: FixedModification[] = [],
): number {
  let sum = WATER_MONOISOTOPIC;
  const shiftsByResidue = new Map<string, number>();
  for (const mod of fixedMods) {
    shiftsByResidue.set(
      mod.residue,
      (shiftsByResidue.get(mod.residue) ?? 0) + mod.massShift,
    );
  }
  for (const aa of sequence) {
    const residueMass = residueMassTable.get(aa);
    if (residueMass === undefined) {
      throw new UnknownResidueError(aa);
    }
    sum += residueMass;
    const shift = shiftsByResidue.get(aa);
    if (shift !== undefined) sum += shift;
  }
  return sum;
}

export class UnknownResidueError extends Error {
  readonly residue: string;
  constructor(residue: string) {
    super(`Unknown residue in active mass table: ${residue}`);
    this.name = "UnknownResidueError";
    this.residue = residue;
  }
}

/** m/z of a protonated precursor with charge z: (M + z * H+) / z. */
export function precursorMz(neutralMass: number, charge: number): number {
  if (!Number.isInteger(charge) || charge < 1) {
    throw new Error("charge must be a positive integer");
  }
  return (neutralMass + charge * PROTON_MASS) / charge;
}

/** Inverse: neutral mass implied by an observed m/z and charge. */
export function neutralMassFromMz(mz: number, charge: number): number {
  return mz * charge - charge * PROTON_MASS;
}

/**
 * b-ion neutral mass for the prefix of length k: sum of k residue masses + H.
 * b-ion m/z (singly charged fragment): sum + H+.
 * y-ion neutral mass for the suffix of length k: sum of k residues + H2O + H.
 * y-ion m/z (singly charged fragment): sum + H2O + H+.
 */
export function fragmentIonMz(
  sequence: string,
  series: "b" | "y",
  number: number,
  charge: number,
  residueMassTable: Map<string, number>,
  fixedMods: FixedModification[] = [],
): number {
  const n = sequence.length;
  if (number < 1 || number > n - 1) {
    throw new Error(`fragment number ${number} out of range for length ${n}`);
  }
  const part = series === "b"
    ? sequence.slice(0, number)
    : sequence.slice(n - number);
  let residueSum = 0;
  const shiftsByResidue = new Map<string, number>();
  for (const mod of fixedMods) {
    shiftsByResidue.set(
      mod.residue,
      (shiftsByResidue.get(mod.residue) ?? 0) + mod.massShift,
    );
  }
  for (const aa of part) {
    const residueMass = residueMassTable.get(aa);
    if (residueMass === undefined) throw new UnknownResidueError(aa);
    residueSum += residueMass;
    const shift = shiftsByResidue.get(aa);
    if (shift !== undefined) residueSum += shift;
  }
  const neutral = series === "b"
    ? residueSum + PROTON_MASS
    : residueSum + WATER_MONOISOTOPIC + PROTON_MASS;
  return charge === 1 ? neutral : (neutral + (charge - 1) * PROTON_MASS) / charge;
}

/**
 * Absolute m/z window for a tolerance expressed in ppm or Da.
 * ppm window is relative to the theoretical m/z.
 */
export function toleranceWindow(
  theoreticalMz: number,
  value: number,
  unit: ToleranceUnit,
): number {
  if (value < 0 || !Number.isFinite(value)) {
    throw new Error("tolerance must be a non-negative finite number");
  }
  return unit === "ppm" ? (theoreticalMz * value) / 1_000_000 : value;
}
export function mzErrorDa(observed: number, theoretical: number): number {
  return observed - theoretical;
}
export function mzErrorPpm(observed: number, theoretical: number): number {
  return ((observed - theoretical) / theoretical) * 1_000_000;
}
export function withinTolerance(
  observed: number,
  theoretical: number,
  value: number,
  unit: ToleranceUnit,
): boolean {
  return Math.abs(observed - theoretical) <= toleranceWindow(theoretical, value, unit) + TOLERANCE;
}
