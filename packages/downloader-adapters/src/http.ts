import { createWriteStream, existsSync, statSync, truncateSync } from "node:fs";
import { once } from "node:events";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { DownloadError, type DownloadProgress } from "@vault/core";
import { safeErrorMessage, withTimeout } from "@vault/shared";

const MAX_REDIRECTS = 5;
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export interface HttpDownloadOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Validate every URL including redirect targets. */
  validateUrl?: (url: string) => boolean;
  referer?: string;
  onProgress?: (progress: DownloadProgress) => void;
}

interface ResolvedResponse {
  response: Response;
  finalUrl: string;
}

async function fetchFollowingValidatedRedirects(
  url: string,
  options: HttpDownloadOptions,
  headers: Record<string, string>,
): Promise<ResolvedResponse> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (options.validateUrl && !options.validateUrl(current)) {
      throw new DownloadError("RESOURCE_UNAVAILABLE", "媒体地址不在允许的域名范围内");
    }
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers,
      signal: options.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new DownloadError("HTTP_ERROR", `重定向缺少 Location（HTTP ${response.status}）`);
      }
      const next = new URL(location, current).toString();
      if (options.validateUrl && !options.validateUrl(next)) {
        throw new DownloadError(
          "RESOURCE_UNAVAILABLE",
          `重定向目标不在允许的域名范围内（${new URL(next).hostname}）；如确认是抖音 CDN，请将其加入 MEDIA_ALLOWED_HOSTS`,
        );
      }
      current = next;
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new DownloadError("HTTP_ERROR", "重定向次数过多");
}

function parseBpsFromHeaders(_headers: Headers): number | null {
  return null;
}

/**
 * Stream an HTTP media URL to disk with Range resume and progress reporting.
 * Returns bytes written in this process (not total file size).
 */
export async function httpDownloadToFile(
  url: string,
  outputPath: string,
  options: HttpDownloadOptions = {},
): Promise<{ bytesWritten: number; totalBytes: number | null; contentType: string | null; finalUrl: string }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("下载超时")), timeoutMs);
  const abortListener = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortListener, { once: true });

  let existing = 0;
  if (existsSync(outputPath)) {
    try {
      existing = statSync(outputPath).size;
    } catch {
      existing = 0;
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    Accept: "*/*",
    ...(options.referer ? { Referer: options.referer } : {}),
    ...(options.headers ?? {}),
  };
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  try {
    const { response, finalUrl } = await fetchFollowingValidatedRedirects(url, {
      ...options,
      signal: controller.signal,
    }, headers);

    if (response.status === 416 && existing > 0) {
      // The partial file already covers the entire resource.
      return { bytesWritten: 0, totalBytes: existing, contentType: response.headers.get("content-type"), finalUrl };
    }
    if (!response.ok) {
      throw new DownloadError(
        response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR",
        `媒体服务器返回 HTTP ${response.status}（${new URL(finalUrl).hostname}）`,
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }
    const contentType = response.headers.get("content-type");
    if (contentType && /^(text\/html|application\/json|text\/plain)/i.test(contentType)) {
      throw new DownloadError("INVALID_MEDIA", `媒体服务器返回了非媒体内容（${contentType}）`);
    }
    if (!response.body) throw new DownloadError("INVALID_MEDIA", "媒体响应没有正文");

    const resumed = response.status === 206 && existing > 0;
    if (existing > 0 && !resumed) {
      truncateSync(outputPath, 0);
      existing = 0;
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength + existing : null;

    const stream = createWriteStream(outputPath, { flags: resumed ? "a" : "w" });
    let downloaded = existing;
    let bytesWritten = 0;
    let lastReport = 0;
    const startedAt = Date.now();
    const reader = Readable.fromWeb(response.body as any);
    try {
      for await (const chunk of reader) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (!stream.write(buffer)) await once(stream, "drain");
        downloaded += buffer.length;
        bytesWritten += buffer.length;
        const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
        const nowMs = Date.now();
        if (nowMs - lastReport >= 400) {
          lastReport = nowMs;
          options.onProgress?.({
            downloadedBytes: downloaded,
            totalBytes,
            speedBps: Math.round(bytesWritten / elapsed),
            fraction: totalBytes ? Math.min(1, downloaded / totalBytes) : null,
          });
        }
      }
    } finally {
      stream.end();
      await finished(stream).catch(() => undefined);
    }

    if (totalBytes != null && downloaded < totalBytes) {
      throw new DownloadError(
        "NETWORK",
        `下载不完整：${downloaded}/${totalBytes} 字节，已保留临时文件以便续传`,
      );
    }
    options.onProgress?.({
      downloadedBytes: downloaded,
      totalBytes: totalBytes ?? downloaded,
      speedBps: null,
      fraction: 1,
    });
    return { bytesWritten, totalBytes: totalBytes ?? downloaded, contentType, finalUrl };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOSPC" || code === "EDQUOT") {
      throw new DownloadError("DISK_FULL", "写入媒体文件时磁盘空间不足", { retryable: false });
    }
    if (controller.signal.aborted) {
      throw new DownloadError("TIMEOUT", `下载超时或被取消：${safeErrorMessage(error)}`, {
        retryable: !options.signal?.aborted,
      });
    }
    throw new DownloadError("NETWORK", `下载失败：${safeErrorMessage(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortListener);
  }
}

/** Fetch a small cover image with an upper size bound. */
export async function httpDownloadCover(
  url: string,
  outputPath: string,
  options: {
    timeoutMs?: number;
    validateUrl?: (url: string) => boolean;
    referer?: string;
    maxBytes?: number;
  } = {},
): Promise<boolean> {
  try {
    await withTimeout(
      httpDownloadToFile(url, outputPath, {
        timeoutMs: options.timeoutMs ?? 20_000,
        validateUrl: options.validateUrl,
        referer: options.referer,
      }),
      options.timeoutMs ?? 25_000,
    );
    const size = statSync(outputPath).size;
    if (size > (options.maxBytes ?? 8 * 1024 * 1024) || size < 128) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
