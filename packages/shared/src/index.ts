import { relative, resolve } from "node:path";

export const APP_NAME = "Douyin Vault";
export const APP_VERSION = "0.1.0";

/** Unix epoch milliseconds. */
export type Millis = number;

export function now(): Millis {
  return Date.now();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Redact URLs that can contain signed query strings. Used before logging and
 * before storing diagnostics so media signatures never leak into logs/backups.
 */
export function redactUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?[redacted]" : ""}`;
  } catch {
    return null;
  }
}

export function redactUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "[url]");
}

export function safeErrorMessage(error: unknown, max = 300): string {
  if (error instanceof Error) return truncate(redactUrlsInText(error.message), max);
  if (typeof error === "string") return truncate(redactUrlsInText(error), max);
  return "Unknown error";
}

export class TimeoutError extends Error {
  readonly code = "TIMEOUT";
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Operation timed out",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run async tasks with bounded concurrency while preserving result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Resolve a child path and guarantee it stays under root. */
export function resolveWithin(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, relativePath.replace(/^\/+/, ""));
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes the managed root");
  }
  return resolved;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
