import { AppError } from "../utils/errors.js";
import { validateSequence } from "../domain/digestion.js";

export type ToleranceUnit = "ppm" | "da";

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("VALIDATION_ERROR", `Field '${field}' is required and must be a non-empty string`);
  }
  return value.trim();
}

export function requirePositiveInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new AppError("VALIDATION_ERROR", `Field '${field}' must be a positive integer`);
  }
  return n;
}

export function requireNonNegativeInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new AppError("VALIDATION_ERROR", `Field '${field}' must be a non-negative integer`);
  }
  return n;
}

export function requirePositiveNumber(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError("VALIDATION_ERROR", `Field '${field}' must be a positive number`);
  }
  return n;
}

/**
 * Tolerance units are validated independently but ppm and Da must never be
 * silently mixed for the *same* measurement. Precursor and fragment each
 * carry their own explicit unit, so a mismatch between the two is rejected
 * unless the caller explicitly opts into per-measurement units via the API.
 * Here we enforce: within one analysis both must use the same unit, to keep
 * the no-mixing rule strict and unambiguous.
 */
export function requireToleranceUnit(value: unknown, field: string): ToleranceUnit {
  if (value !== "ppm" && value !== "da") {
    throw new AppError(
      "INVALID_TOLERANCE",
      `Field '${field}' must be 'ppm' or 'da'`
    );
  }
  return value;
}

export function validateAnalysisUnits(
  precursorUnit: ToleranceUnit,
  fragmentUnit: ToleranceUnit
): void {
  if (precursorUnit !== fragmentUnit) {
    throw new AppError(
      "TOLERANCE_UNIT_MISMATCH",
      `Cannot mix tolerance units within one analysis: precursor='${precursorUnit}' fragment='${fragmentUnit}'`
    );
  }
}

export function validateProteinSequence(sequence: unknown): string {
  const seq = requireString(sequence, "sequence").toUpperCase();
  const errors = validateSequence(seq);
  if (errors.length > 0) {
    throw new AppError("INVALID_SEQUENCE", "Invalid protein sequence", errors);
  }
  return seq;
}

export function validatePeaks(peaks: unknown): { mz: number; intensity: number; charge?: number }[] {
  if (!Array.isArray(peaks) || peaks.length === 0) {
    throw new AppError("INVALID_PEAK_TABLE", "Peak list must be a non-empty array");
  }
  return peaks.map((p, i) => {
    const mz = typeof p?.mz === "number" ? p.mz : parseFloat(String(p?.mz));
    if (!Number.isFinite(mz) || mz <= 0) {
      throw new AppError("INVALID_PEAK_TABLE", `Peak at index ${i} has invalid mz`);
    }
    const intensity =
      p?.intensity === undefined
        ? 0
        : typeof p.intensity === "number"
          ? p.intensity
          : parseFloat(String(p.intensity));
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new AppError("INVALID_PEAK_TABLE", `Peak at index ${i} has invalid intensity`);
    }
    let charge: number | undefined;
    if (p?.charge !== undefined && p.charge !== null) {
      charge = requirePositiveInt(p.charge, `peaks[${i}].charge`);
    }
    return { mz, intensity, charge };
  });
}
