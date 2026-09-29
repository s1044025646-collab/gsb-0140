export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOLERANCE_UNIT_MISMATCH"
  | "INVALID_SEQUENCE"
  | "INVALID_CHARGE"
  | "INVALID_TOLERANCE"
  | "INVALID_MASS_TABLE"
  | "ANALYSIS_PARAMS_CHANGED"
  | "INVALID_PEAK_TABLE"
  | "REPORT_FROZEN"
  | "TRANSACTION_FAILED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function httpStatusForCode(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "TOLERANCE_UNIT_MISMATCH":
    case "INVALID_SEQUENCE":
    case "INVALID_CHARGE":
    case "INVALID_TOLERANCE":
    case "INVALID_MASS_TABLE":
    case "INVALID_PEAK_TABLE":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "ANALYSIS_PARAMS_CHANGED":
    case "REPORT_FROZEN":
      return 409;
    default:
      return 500;
  }
}
