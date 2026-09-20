export class SafeError extends Error {
    code;
    constructor(code, safeMessage) {
        super(safeMessage);
        this.name = "SafeError";
        this.code = code;
        this.stack = undefined;
    }
}
export function invalidInput(safeMessage = "invalid input") {
    throw new SafeError("INVALID_INPUT", safeMessage);
}
export function assertInvariant(condition, safeMessage) {
    if (!condition)
        throw new SafeError("STATE", safeMessage);
}
export function normalizeSafeError(error, code, safeMessage) {
    return error instanceof SafeError ? error : new SafeError(code, safeMessage);
}
export function isSqliteBusy(error) {
    if (!(error instanceof Error))
        return false;
    const withCode = error;
    return withCode.code === "ERR_SQLITE_ERROR" && /database is locked|database is busy/i.test(error.message)
        || withCode.code === "SQLITE_BUSY"
        || withCode.errcode === 5;
}
