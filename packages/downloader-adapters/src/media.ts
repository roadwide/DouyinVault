import { createReadStream, openSync, readSync, closeSync, statSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { VaultError, type MediaProbe } from "@vault/core";
import { safeErrorMessage } from "@vault/shared";

function readMagic(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(256);
    const bytes = readSync(fd, buffer, 0, 256, 0);
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

export type MediaSignature = "mp4" | "webm" | "mpegts" | "unknown";

export function detectMediaSignature(path: string): MediaSignature {
  const magic = readMagic(path);
  if (magic.length >= 12 && magic.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  if (magic.length >= 4 && magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3) {
    return "webm";
  }
  if (magic.length >= 1 && magic[0] === 0x47 && magic[188] === 0x47) return "mpegts";
  return "unknown";
}

export function assertLooksLikeMedia(path: string): MediaSignature {
  if (!existsSync(path)) throw new VaultError("INVALID_MEDIA", "下载结果文件不存在");
  const size = statSync(path).size;
  if (size < 1024) throw new VaultError("INVALID_MEDIA", `下载结果过小（${size} 字节）`);
  const magic = readMagic(path);
  const head = magic.toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("{")) {
    throw new VaultError("INVALID_MEDIA", "下载结果是网页或 JSON，不是媒体文件");
  }
  if (head.startsWith("#extm3u")) {
    throw new VaultError("INVALID_MEDIA", "下载结果是 HLS 播放列表，Direct 下载器不支持分片合并");
  }
  if (magic.subarray(0, 3).toString("ascii") === "ID3" || (magic[0] === 0xff && (magic[1]! & 0xe0) === 0xe0)) {
    throw new VaultError("INVALID_MEDIA", "下载结果是音频文件，该作品可能不是视频");
  }
  if (magic[0] === 0xff && magic[1] === 0xd8) {
    throw new VaultError("INVALID_MEDIA", "下载结果是 JPEG 图片，不是视频");
  }
  if (
    magic.length >= 8 &&
    magic.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    throw new VaultError("INVALID_MEDIA", "下载结果是 PNG 图片，不是视频");
  }
  const signature = detectMediaSignature(path);
  if (signature === "unknown") {
    throw new VaultError("INVALID_MEDIA", `无法识别下载结果的媒体格式（${size} 字节）`);
  }
  return signature;
}

export async function computeSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export function probeMedia(
  path: string,
  options: { ffprobePath?: string; timeoutMs?: number } = {},
): Promise<MediaProbe> {
  const binary = options.ffprobePath || "ffprobe";
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new VaultError("TIMEOUT", "ffprobe 检查超时"));
    }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new VaultError("CONFIG", "ffprobe 未安装或路径不可执行"));
      } else {
        reject(new VaultError("FFPROBE_FAILED", safeErrorMessage(error)));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new VaultError("FFPROBE_FAILED", `ffprobe 退出码 ${code}：${stderr.trim().slice(-300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string; format_name?: string };
          streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
        };
        const streams = parsed.streams ?? [];
        const video = streams.find((stream) => stream.codec_type === "video");
        const durationRaw = parsed.format?.duration ?? video?.duration;
        const duration = durationRaw ? Number(durationRaw) : null;
        resolve({
          durationSeconds: Number.isFinite(duration) ? duration : null,
          width: video?.width ?? null,
          height: video?.height ?? null,
          hasVideo: Boolean(video),
          format: parsed.format?.format_name ?? null,
        });
      } catch (error) {
        reject(new VaultError("FFPROBE_FAILED", `无法解析 ffprobe 输出：${safeErrorMessage(error)}`));
      }
    });
  });
}

export function generateCover(
  videoPath: string,
  coverPath: string,
  options: { ffmpegPath?: string; atSeconds?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const binary = options.ffmpegPath || "ffmpeg";
  mkdirSync(dirname(coverPath), { recursive: true, mode: 0o700 });
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(options.atSeconds ?? 1),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(720,iw)':-2",
        "-q:v",
        "3",
        "-y",
        coverPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, options.timeoutMs ?? 30_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && existsSync(coverPath) && statSync(coverPath).size > 0) {
        resolve(true);
      } else {
        void stderr;
        resolve(false);
      }
    });
  });
}
