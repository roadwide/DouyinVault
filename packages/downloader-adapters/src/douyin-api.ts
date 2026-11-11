import {
  buildShareUrl,
  DownloadError,
  isDouyinUrl,
  isValidWorkId,
  type DownloadProgress,
  type DownloadResult,
  type MediaDownloader,
  type MediaInput,
  type ResolvedMedia,
} from "@vault/core";
import { asNumber, asString, isRecord, safeErrorMessage, sleep } from "@vault/shared";
import { httpDownloadToFile } from "./http.js";

type Json = Record<string, unknown>;

interface ExtractResult {
  url: string;
  title?: string;
  coverUrl?: string;
  durationSeconds?: number;
  authorName?: string;
}

const MEDIA_KEY_HINTS = ["video", "play", "download", "media", "file", "bit_rate", "bitrate"];
const EXCLUDED_KEY_HINTS = [
  "cover",
  "avatar",
  "poster",
  "image",
  "music",
  "audio",
  "thumb",
  "author",
  "profile",
  "share",
];

function hasMediaContext(path: readonly string[]): boolean {
  return path.some((segment) => {
    const key = segment.toLowerCase();
    return MEDIA_KEY_HINTS.some(
      (hint) =>
        key === hint ||
        key.startsWith(`${hint}_`) ||
        key.endsWith(`_${hint}`) ||
        key.includes(`_${hint}_`),
    );
  });
}

function isExcludedPath(path: readonly string[]): boolean {
  return path.some((segment) => {
    const key = segment.toLowerCase();
    return EXCLUDED_KEY_HINTS.some((hint) => key.includes(hint));
  });
}

function looksLikeVideoUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) &&
    (/\.(mp4|webm|mov)(\?|$)/i.test(url) ||
      /mime_type=video/i.test(url) ||
      /\/video\/tos\//i.test(url) ||
      /\/aweme\/v1\/play\//i.test(url))
  );
}

function walkForMedia(value: unknown, path: string[] = [], found: ExtractResult[] = []): ExtractResult[] {
  if (found.length >= 30) return found;
  if (typeof value === "string") {
    if (!/^https?:\/\//i.test(value) || isExcludedPath(path)) return found;
    if (looksLikeVideoUrl(value) || hasMediaContext(path)) {
      if (!/\.(jpe?g|png|webp|gif|svg)(\?|$)/i.test(value)) found.push({ url: value });
    }
    return found;
  }
  if (Array.isArray(value)) {
    const listPath = path;
    if (isExcludedPath(listPath)) return found;
    for (const item of value) {
      if (typeof item === "string") {
        if (!/^https?:\/\//i.test(item)) continue;
        if (looksLikeVideoUrl(item) || hasMediaContext(listPath)) {
          if (!/\.(jpe?g|png|webp|gif|svg)(\?|$)/i.test(item)) found.push({ url: item });
        }
      } else {
        walkForMedia(item, listPath, found);
      }
    }
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    walkForMedia(child, [...path, key], found);
  }
  return found;
}

function scoreMedia(entry: ExtractResult): number {
  const url = entry.url.toLowerCase();
  let score = 0;
  if (url.includes("douyinvod") || url.includes("byte") || url.includes("douyin")) score += 4;
  if (url.includes(".mp4")) score += 3;
  if (url.includes("download")) score += 2;
  if (url.includes("play")) score += 2;
  if (url.includes("m3u8")) score -= 2;
  if (url.includes("watermark")) score -= 1;
  return score;
}

/**
 * Extract the best downloadable video URL from the varied v4/v5 API payloads.
 * Deliberately avoids cover/avatar/poster URLs and prefers MP4 over HLS.
 */
export function extractMediaFromApiPayload(payload: unknown): ExtractResult | null {
  if (!isRecord(payload) && !Array.isArray(payload)) return null;
  const candidates = walkForMedia(payload);
  const unique = new Map<string, ExtractResult>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  }
  const list = [...unique.values()].sort((a, b) => scoreMedia(b) - scoreMedia(a));
  const best = list.find((item) => scoreMedia(item) > 0);
  if (!best) return null;

  const root = (isRecord(payload) && isRecord(payload["data"]) ? payload["data"] : payload) as Json;
  const content = isRecord(root["content"]) ? (root["content"] as Json) : root;
  const video = isRecord(content["video"]) ? (content["video"] as Json) : null;
  const author = isRecord(content["author"]) ? (content["author"] as Json) : null;
  return {
    url: best.url,
    title: asString(content["desc"]) ?? asString(content["title"]) ?? best.title,
    coverUrl: coverUrlFrom(content),
    durationSeconds: normalizeDuration(content["duration"] ?? video?.["duration"]),
    authorName: asString(author?.["nickname"]) ?? undefined,
  };
}

function normalizeDuration(value: unknown): number | undefined {
  const raw = asNumber(value);
  if (raw == null || raw <= 0) return undefined;
  // Douyin APIs report some durations in milliseconds and others in seconds.
  return raw >= 1000 ? raw / 1000 : raw;
}

function coverUrlFrom(value: Json): string | undefined {
  const direct = asString(value["cover_url"]) ?? asString(value["cover"]);
  if (direct) return direct;
  const cover = value["cover"];
  if (isRecord(cover)) {
    const list = cover["url_list"];
    if (Array.isArray(list)) return asString(list[0]) ?? undefined;
  }
  const thumb = value["content_thumb"];
  if (isRecord(thumb)) {
    const list = thumb["url_list"];
    if (Array.isArray(list)) return asString(list[0]) ?? undefined;
  }
  return undefined;
}

function extractMetadata(payload: unknown, result: ExtractResult): ExtractResult {
  if (!isRecord(payload)) return result;
  const data = isRecord(payload["data"]) ? (payload["data"] as Json) : payload;
  const content = isRecord(data["content"]) ? (data["content"] as Json) : data;
  const author = isRecord(content["author"]) ? (content["author"] as Json) : null;
  return {
    ...result,
    title: result.title ?? asString(content["desc"]) ?? asString(content["title"]) ?? undefined,
    coverUrl: result.coverUrl ?? coverUrlFrom(content),
    durationSeconds: result.durationSeconds ?? normalizeDuration(content["duration"]),
    authorName: result.authorName ?? asString(author?.["nickname"]) ?? undefined,
  };
}

/**
 * Calls a separately hosted Douyin_TikTok_Download_API instance to resolve a
 * work, then downloads the bytes itself so the vault owns the final file.
 *
 * Supports v5 (`POST /api/v1/parse` + task polling) and v4
 * (`GET /api/hybrid/video_data?url=`). Neither is on by default.
 */
export class DouyinApiDownloader implements MediaDownloader {
  readonly name = "douyin-api";

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey?: string;
      mode?: "auto" | "v5" | "v4";
      timeoutSeconds?: number;
      extraHosts?: readonly string[];
      allowLoopback?: boolean;
    },
  ) {}

  private get base(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  supports(input: MediaInput): boolean {
    return Boolean(this.options.baseUrl && (isValidWorkId(input.workId) || input.shareUrl));
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
      headers["X-API-Key"] = this.options.apiKey;
    }
    return headers;
  }

  private async readJson(response: Response): Promise<Json> {
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (!contentType.includes("json") && !text.trim().startsWith("{")) {
      throw new DownloadError("HTTP_ERROR", `解析服务返回非 JSON 响应（HTTP ${response.status}）`);
    }
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new DownloadError("HTTP_ERROR", "解析服务返回了无法解析的 JSON");
    }
  }

  private async resolveV5(target: string): Promise<ExtractResult> {
    const response = await fetch(`${this.base}/api/v1/parse`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
      signal: AbortSignal.timeout((this.options.timeoutSeconds ?? 120) * 1000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new DownloadError("AUTH_REQUIRED", "下载 API 拒绝了凭据，请检查 DTK_API_KEY");
    }
    if (response.status === 429) {
      throw new DownloadError("RATE_LIMITED", "下载 API 触发限流");
    }
    if (!response.ok && response.status !== 202) {
      throw new DownloadError("HTTP_ERROR", `下载 API 返回 HTTP ${response.status}`);
    }
    const submit = await this.readJson(response);
    const envelopeOk = submit["success"] !== false;
    if (!envelopeOk) {
      const err = isRecord(submit["error"]) ? submit["error"] : null;
      throw new DownloadError("HTTP_ERROR", `下载 API 解析失败：${asString(err?.["code"]) ?? "UNKNOWN"}`);
    }
    const data = isRecord(submit["data"]) ? (submit["data"] as Json) : submit;
    const taskId = asString(data["task_id"]);
    if (!taskId) {
      const extracted = extractMediaFromApiPayload(submit);
      if (!extracted) {
        throw new DownloadError("RESOURCE_UNAVAILABLE", "下载 API 响应中没有可用的视频地址");
      }
      return extractMetadata(submit, extracted);
    }
    const deadline = Date.now() + (this.options.timeoutSeconds ?? 120) * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const poll = await fetch(`${this.base}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (poll.status === 404) {
        throw new DownloadError("HTTP_ERROR", "下载 API 任务不存在或已过期");
      }
      if (!poll.ok) continue;
      const envelope = await this.readJson(poll);
      const pollData = isRecord(envelope["data"]) ? (envelope["data"] as Json) : envelope;
      const state = asString(pollData["state"]);
      if (state === "failed") {
        throw new DownloadError("RESOURCE_UNAVAILABLE", "下载 API 解析任务失败");
      }
      if (state === "done") {
        const extracted = extractMediaFromApiPayload(pollData);
        if (!extracted) {
          throw new DownloadError("RESOURCE_UNAVAILABLE", "下载 API 解析完成但没有视频地址");
        }
        return extractMetadata(pollData, extracted);
      }
    }
    throw new DownloadError("TIMEOUT", "等待下载 API 解析任务超时");
  }

  private async resolveV4(target: string): Promise<ExtractResult> {
    const url = new URL(`${this.base}/api/hybrid/video_data`);
    url.searchParams.set("url", target);
    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout((this.options.timeoutSeconds ?? 120) * 1000),
    });
    if (!response.ok) {
      throw new DownloadError(
        "HTTP_ERROR",
        `下载 API 返回 HTTP ${response.status}`,
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }
    const payload = await this.readJson(response);
    const extracted = extractMediaFromApiPayload(payload);
    if (!extracted) {
      throw new DownloadError("RESOURCE_UNAVAILABLE", "下载 API 响应中没有可用的视频地址");
    }
    return extractMetadata(payload, extracted);
  }

  async resolve(input: MediaInput): Promise<ResolvedMedia> {
    const shareUrl = input.shareUrl && isDouyinUrl(input.shareUrl) ? input.shareUrl : null;
    const target = shareUrl ?? (isValidWorkId(input.workId) ? buildShareUrl(input.workId) : null);
    if (!target) throw new DownloadError("UNRESOLVED", "没有作品链接可供解析");
    const mode = this.options.mode ?? "auto";
    let resolved: ExtractResult | null = null;
    let v5Error: unknown = null;
    if (mode === "auto" || mode === "v5") {
      try {
        resolved = await this.resolveV5(target);
      } catch (error) {
        v5Error = error;
        if (mode === "v5") throw error;
      }
    }
    if (!resolved) {
      try {
        resolved = await this.resolveV4(target);
      } catch (error) {
        const primary = v5Error ? `v5: ${safeErrorMessage(v5Error)}；` : "";
        throw new DownloadError("RESOURCE_UNAVAILABLE", `${primary}v4: ${safeErrorMessage(error)}`, {
          retryable: false,
        });
      }
    }
    return {
      url: resolved.url,
      kind: "video",
      container: "mp4",
      title: resolved.title ?? input.title,
      coverUrl: resolved.coverUrl ?? input.coverUrl,
      durationSeconds: resolved.durationSeconds ?? null,
    };
  }

  async download(
    media: ResolvedMedia,
    outputPath: string,
    onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<DownloadResult> {
    const result = await httpDownloadToFile(media.url, outputPath, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        Referer: "https://www.douyin.com/",
      },
      timeoutMs: (this.options.timeoutSeconds ?? 120) * 1000,
      signal,
      validateUrl: (url) => {
        try {
          const host = new URL(url).hostname;
          if (this.options.allowLoopback && ["127.0.0.1", "localhost"].includes(host)) return true;
          // Resolved media URLs come from the trusted local API; still block
          // obvious private/link-local targets to avoid SSRF pivots.
          if (/^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(host)) return false;
          return true;
        } catch {
          return false;
        }
      },
      onProgress,
    });
    return {
      filePath: outputPath,
      bytesWritten: result.bytesWritten,
      contentType: result.contentType,
    };
  }
}
