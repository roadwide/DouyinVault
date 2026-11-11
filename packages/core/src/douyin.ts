import { truncate } from "@vault/shared";
import type { MessageType, NormalizedMessage } from "./types.js";

interface ParsedShare {
  workId?: string;
  shareUrl?: string;
  title?: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？、）)]+/giu;
const WORK_ID_PATTERN = /^\d{8,32}$/;

const DEFAULT_MEDIA_HOSTS = [
  "douyin.com",
  "iesdouyin.com",
  "douyinvod.com",
  "douyinpic.com",
  "douyincdn.com",
  "douyinstatic.com",
  "zjcdn.com",
  "byteimg.com",
  "bytecdn.cn",
  "bytecdntp.com",
  "ixigua.com",
  "snssdk.com",
  "amemv.com",
  "pstatp.com",
  "bytedance.com",
];

export function isValidWorkId(value: unknown): value is string {
  return typeof value === "string" && WORK_ID_PATTERN.test(value);
}

/**
 * Extract the first Douyin share link and numeric work id from text.
 * Pure text matching is a secondary path; adapters should prefer structured cards.
 */
export function parseDouyinShareText(text: string): ParsedShare {
  if (!text) return {};
  const result: ParsedShare = {};
  for (const raw of text.match(URL_PATTERN) ?? []) {
    const cleaned = raw.replace(/[.,;:!?]+$/u, "");
    if (!isDouyinUrl(cleaned)) continue;
    result.shareUrl ??= cleaned;
    try {
      const url = new URL(cleaned);
      const modalId = url.searchParams.get("modal_id");
      if (modalId && isValidWorkId(modalId)) result.workId ??= modalId;
      const match = url.pathname.match(/\/video\/(\d+)/);
      if (match?.[1] && isValidWorkId(match[1])) result.workId ??= match[1];
    } catch {
      // Ignore malformed URL matches.
    }
    if (result.workId) break;
  }
  // Some share captions carry a bare work id next to the short URL.
  if (!result.workId) {
    const bare = text.match(/(?:作品|视频|aweme_id|item_id)[：:\s]*(\d{8,32})/u);
    if (bare?.[1] && isValidWorkId(bare[1])) result.workId = bare[1];
  }
  return result;
}

export function isDouyinUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return (
      host === "douyin.com" ||
      host.endsWith(".douyin.com") ||
      host === "iesdouyin.com" ||
      host.endsWith(".iesdouyin.com")
    );
  } catch {
    return false;
  }
}

export function isAllowedMediaHost(hostname: string, extraHosts: readonly string[] = []): boolean {
  const host = hostname.toLowerCase();
  const hosts = [...DEFAULT_MEDIA_HOSTS, ...extraHosts.map((item) => item.trim().toLowerCase())];
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function isAllowedMediaUrl(
  raw: string,
  options: { extraHosts?: readonly string[]; allowLoopback?: boolean } = {},
): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (options.allowLoopback) {
      if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return true;
    }
    return isAllowedMediaHost(url.hostname, options.extraHosts);
  } catch {
    return false;
  }
}

export function buildShareUrl(workId: string | null | undefined): string | null {
  return isValidWorkId(workId) ? `https://www.douyin.com/video/${workId}` : null;
}

export function mediaKeyForWork(workId: string, platform = "douyin"): string {
  return `${platform}:work:${workId}`;
}

export function mediaKeyForMessage(messageId: string, platform = "douyin"): string {
  return `${platform}:message:${messageId}`;
}

/**
 * Classify a normalized message. Structured card data wins over URL heuristics.
 */
export function classifyMessage(input: {
  workId?: string | null;
  mediaUrl?: string | null;
  text?: string | null;
  messageType?: number | null;
}): { type: MessageType; workId?: string; shareUrl?: string; title?: string; diagnostic?: string } {
  if (isValidWorkId(input.workId)) {
    return { type: "shared_work", workId: input.workId };
  }
  if (input.mediaUrl) {
    return { type: "chat_video" };
  }
  const parsed = parseDouyinShareText(input.text ?? "");
  if (parsed.workId) {
    return { type: "shared_work", workId: parsed.workId, shareUrl: parsed.shareUrl };
  }
  if (parsed.shareUrl) {
    return {
      type: "text_with_url",
      shareUrl: parsed.shareUrl,
      diagnostic: truncate(`Douyin share link without resolvable work id: ${parsed.shareUrl}`, 300),
    };
  }
  if (input.messageType === 8 || input.messageType === 77) {
    return { type: "unknown", diagnostic: "Work card without a usable work id (UNRESOLVED)." };
  }
  return { type: "unknown" };
}

export function isVideoMessageType(type: MessageType): boolean {
  return type === "shared_work" || type === "chat_video" || type === "text_with_url";
}

/** Work-card message source URL used by external parsers when only an id exists. */
export function shareUrlForMessage(message: NormalizedMessage): string | null {
  if (message.shareUrl && isDouyinUrl(message.shareUrl)) return message.shareUrl;
  return buildShareUrl(message.workId);
}
