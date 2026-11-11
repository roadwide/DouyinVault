export type ErrorCode =
  | "UNRESOLVED"
  | "NOT_SUPPORTED"
  | "RESOURCE_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "NETWORK"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "INVALID_MEDIA"
  | "FFPROBE_FAILED"
  | "DISK_FULL"
  | "DB_ERROR"
  | "CONFIG"
  | "CANCELED"
  | "INTERNAL";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "NETWORK",
  "TIMEOUT",
  "RATE_LIMITED",
  "HTTP_ERROR",
  "DB_ERROR",
  "INTERNAL",
]);

const USER_ACTION: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "AUTH_REQUIRED",
  "DISK_FULL",
]);

export class VaultError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly requiresUserAction: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "VaultError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.requiresUserAction = USER_ACTION.has(code);
    this.details = options.details;
  }
}

export class DownloadError extends VaultError {
  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(code, message, options);
    this.name = "DownloadError";
  }
}

export function toVaultError(error: unknown, fallback: ErrorCode = "INTERNAL"): VaultError {
  if (error instanceof VaultError) return error;
  if (error instanceof Error) {
    if (error.name === "AbortError") return new VaultError("CANCELED", "已取消");
    return new VaultError(fallback, error.message, { cause: error });
  }
  return new VaultError(fallback, "未知错误");
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
