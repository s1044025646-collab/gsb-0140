import { PROTON_MASS, WATER_MONOISOTOPIC } from "./constants.js";
import { residueMass } from "./mass.js";

export interface Ion {
  type: "b" | "y";
  /** 1-based ion ordinal: b1..b_{n-1}, y1..y_{n-1} */
  number: number;
  charge: number;
  mz: number;
  /** sequence of the fragment (b = prefix, y = suffix) */
  sequence: string;
}

/**
 * Compute the b-ion series for a peptide.
 *
 * b_i contains residues 1..i (N-terminal prefix).
 *
 *   b_i^z+  m/z = (sum(residues 1..i) + z * H+) / z
 *
 * Note: b ions do NOT include the elements of water; the acylium ion
 * already accounts for the N-terminal H.
 */
export function bIonSeries(
  sequence: string,
  charge: number,
  massTable: Record<string, number>,
  modificationDeltas: Record<string, number> = {}
): Ion[] {
  const ions: Ion[] = [];
  let prefixMass = 0;
  for (let i = 0; i < sequence.length - 1; i++) {
    prefixMass += residueMass(sequence[i], massTable, modificationDeltas);
    const number = i + 1;
    const mz = (prefixMass + charge * PROTON_MASS) / charge;
    ions.push({
      type: "b",
      number,
      charge,
      mz,
      sequence: sequence.slice(0, number),
    });
  }
  return ions;
}

/**
 * Compute the y-ion series for a peptide.
 *
 * y_i contains residues (n-i+1)..n (C-terminal suffix).
 *
 *   y_i^z+  m/z = (sum(residues last i) + H2O + z * H+) / z
 *
 * The elements of water are retained because the C-terminal COOH is intact.
 */
export function yIonSeries(
  sequence: string,
  charge: number,
  massTable: Record<string, number>,
  modificationDeltas: Record<string, number> = {}
): Ion[] {
  const ions: Ion[] = [];
  let suffixMass = 0;
  for (let i = 0; i < sequence.length - 1; i++) {
    const idx = sequence.length - 1 - i;
    suffixMass += residueMass(sequence[idx], massTable, modificationDeltas);
    const number = i + 1;
    const mz = (suffixMass + WATER_MONOISOTOPIC + charge * PROTON_MASS) / charge;
    ions.push({
      type: "y",
      number,
      charge,
      mz,
      sequence: sequence.slice(sequence.length - number),
    });
  }
  return ions;
}

/**
 * Generate the complete theoretical fragment ion spectrum (b + y) for a
 * peptide at a given charge.
 */
export function theoreticalSpectrum(
  sequence: string,
  charge: number,
  massTable: Record<string, number>,
  modificationDeltas: Record<string, number> = {}
): Ion[] {
  return [
    ...bIonSeries(sequence, charge, massTable, modificationDeltas),
    ...yIonSeries(sequence, charge, massTable, modificationDeltas),
  ];
}
