import { PROTON_MASS, WATER_MONOISOTOPIC } from "./constants.ts";
import { fragmentIonMz } from "./mass.ts";
import type { FixedModification, TheoreticalIon } from "./types.ts";

/**
 * Theoretical singly charged b and y series for a peptide.
 * Only 1..n-1 fragments exist; each series gets n-1 ions.
 */
export function theoreticalSpectrum(
  sequence: string,
  residueMassTable: Map<string, number>,
  fixedMods: FixedModification[] = [],
  fragmentCharges: number[] = [1],
): TheoreticalIon[] {
  const ions: TheoreticalIon[] = [];
  const n = sequence.length;
  for (const series of ["b", "y"] as const) {
    for (let number = 1; number <= n - 1; number++) {
      for (const charge of fragmentCharges) {
        const mz = fragmentIonMz(
          sequence,
          series,
          number,
          charge,
          residueMassTable,
          fixedMods,
        );
        const prefixNeutral =
          (series === "b" ? 0 : WATER_MONOISOTOPIC) +
          residueSum(sequence, series, number, residueMassTable, fixedMods);
        ions.push({
          series,
          number,
          charge,
          neutralMass: prefixNeutral + PROTON_MASS,
          mz,
        });
      }
    }
  }
  return ions;
}

function residueSum(
  sequence: string,
  series: "b" | "y",
  number: number,
  table: Map<string, number>,
  fixedMods: FixedModification[],
): number {
  const n = sequence.length;
  const part = series === "b"
    ? sequence.slice(0, number)
    : sequence.slice(n - number);
  const shifts = new Map<string, number>();
  for (const mod of fixedMods) {
    shifts.set(mod.residue, (shifts.get(mod.residue) ?? 0) + mod.massShift);
  }
  let sum = 0;
  for (const aa of part) {
    sum += table.get(aa)!;
    const shift = shifts.get(aa);
    if (shift !== undefined) sum += shift;
  }
  return sum;
}
