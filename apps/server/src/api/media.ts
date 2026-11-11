import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface ParsedRange {
  start: number;
  end: number;
  length: number;
}

/** Parse a single RFC 7233 byte range. Multi-range requests are not supported. */
export function parseRange(header: string | undefined, size: number): ParsedRange | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return "invalid";
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1, length };
  }
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0 || start >= size) return "invalid";
  const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
  if (!Number.isInteger(end) || end < start) return "invalid";
  return { start, end, length: end - start + 1 };
}

export async function sendFileWithRange(
  request: FastifyRequest,
  reply: FastifyReply,
  file: {
    absolutePath: string;
    size: number;
    mtimeMs: number;
    mime: string;
    etag: string;
  },
): Promise<void> {
  const range = parseRange(request.headers.range, file.size);
  const commonHeaders: Record<string, string | number> = {
    "Content-Type": file.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ETag: file.etag,
    "Last-Modified": new Date(file.mtimeMs).toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };
  if (request.headers["if-none-match"] === file.etag) {
    reply.code(304).headers(commonHeaders).send();
    return;
  }
  const method = request.method.toUpperCase();
  if (range === "invalid") {
    reply
      .code(416)
      .headers({ ...commonHeaders, "Content-Range": `bytes */${file.size}` })
      .send();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  const status = range ? 206 : 200;
  const headers: Record<string, string | number> = {
    ...commonHeaders,
    "Content-Length": end - start + 1,
    "Content-Disposition": `inline; filename="vault-${file.etag.replace(/\D/g, "").slice(0, 12) || "video"}.mp4"`,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
  reply.hijack();
  reply.raw.writeHead(status, headers);
  if (method === "HEAD") {
    reply.raw.end();
    return;
  }
  const stream = createReadStream(file.absolutePath, { start, end });
  request.raw.on("close", () => stream.destroy());
  try {
    await pipeline(stream, reply.raw);
  } catch {
    stream.destroy();
  }
}

export async function sendSmallFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: { absolutePath: string; size: number; mime: string; mtimeMs: number; etag: string },
): Promise<void> {
  const headers: Record<string, string | number> = {
    "Content-Type": file.mime,
    "Content-Length": file.size,
    "Cache-Control": "private, max-age=86400",
    ETag: file.etag,
    "Last-Modified": new Date(file.mtimeMs).toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };
  if (request.headers["if-none-match"] === file.etag) {
    reply.code(304).headers(headers).send();
    return;
  }
  reply.hijack();
  reply.raw.writeHead(200, headers);
  if (request.method.toUpperCase() === "HEAD") {
    reply.raw.end();
    return;
  }
  const stream = createReadStream(file.absolutePath);
  request.raw.on("close", () => stream.destroy());
  try {
    await pipeline(stream, reply.raw);
  } catch {
    stream.destroy();
  }
}
