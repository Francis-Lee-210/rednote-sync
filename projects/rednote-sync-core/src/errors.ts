export type SafeErrorCode =
  | "INVALID_INPUT"
  | "BUSY"
  | "STATE"
  | "CANONICAL_INTEGRITY"
  | "SECURITY_BOUNDARY"
  | "DERIVED_VIEW";

export class SafeError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: SafeErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "SafeError";
    this.code = code;
    this.stack = undefined;
  }
}

export function invalidInput(safeMessage = "invalid input"): never {
  throw new SafeError("INVALID_INPUT", safeMessage);
}

export function assertInvariant(condition: unknown, safeMessage: string): asserts condition {
  if (!condition) throw new SafeError("STATE", safeMessage);
}

export function normalizeSafeError(error: unknown, code: SafeErrorCode, safeMessage: string): SafeError {
  return error instanceof SafeError ? error : new SafeError(code, safeMessage);
}

export function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const withCode = error as Error & { code?: string; errcode?: number };
  return withCode.code === "ERR_SQLITE_ERROR" && /database is locked|database is busy/i.test(error.message)
    || withCode.code === "SQLITE_BUSY"
    || withCode.errcode === 5;
}
