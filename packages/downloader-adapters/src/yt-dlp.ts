import { spawn } from "node:child_process";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
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
import { asNumber, redactUrlsInText, safeErrorMessage } from "@vault/shared";

const PROGRESS_RE =
  /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)([KMG]i?B)(?:\s+at\s+([\d.]+)([KMG]i?B)\/s)?/i;

function toBytes(value: number, unit: string): number {
  const upper = unit.toUpperCase();
  if (upper.startsWith("K")) return value * 1024;
  if (upper.startsWith("M")) return value * 1024 ** 2;
  if (upper.startsWith("G")) return value * 1024 ** 3;
  return value;
}

function findOutput(basePath: string): string | null {
  if (existsSync(basePath)) {
    try {
      if (statSync(basePath).size > 0) return basePath;
    } catch {
      // Continue to sibling lookup.
    }
  }
  try {
    const dir = dirname(basePath);
    const prefix = basename(basePath);
    const candidates = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && !name.endsWith(".part") && !name.endsWith(".ytdl"))
      .map((name) => `${dir}/${name}`)
      .filter((path) => statSync(path).isFile())
      .sort((a, b) => statSync(b).size - statSync(a).size);
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * yt-dlp fallback. Runs as an isolated process with an argument array (never a
 * shell). A 403 from Douyin is treated as resource-unavailable rather than
 * retried forever; the queue still preserves the failed job for the user.
 */
export class YtDlpDownloader implements MediaDownloader {
  readonly name = "yt-dlp";

  constructor(
    private readonly options: {
      binaryPath: string;
      ffmpegPath?: string;
      preferredQuality?: "540p" | "720p" | "1080p" | "best";
      timeoutSeconds?: number;
    },
  ) {}

  supports(input: MediaInput): boolean {
    return Boolean(this.options.binaryPath && (isValidWorkId(input.workId) || input.shareUrl));
  }

  async resolve(input: MediaInput): Promise<ResolvedMedia> {
    const shareUrl = input.shareUrl && isDouyinUrl(input.shareUrl) ? input.shareUrl : null;
    const target = shareUrl ?? (isValidWorkId(input.workId) ? buildShareUrl(input.workId) : null);
    if (!target) throw new DownloadError("UNRESOLVED", "没有可交给 yt-dlp 的作品链接");
    return {
      url: target,
      kind: "video",
      container: "mp4",
      title: input.title,
      coverUrl: input.coverUrl,
      adapterState: { target },
    };
  }

  async download(
    media: ResolvedMedia,
    outputPath: string,
    onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<DownloadResult> {
    const binary = this.options.binaryPath || "yt-dlp";
    const quality = this.options.preferredQuality ?? "720p";
    const height = quality === "best" ? null : Number.parseInt(quality, 10);
    const format = height
      ? `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`
      : "bv*+ba/b";
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--no-mtime",
      "--continue",
      "--retries",
      "2",
      "--fragment-retries",
      "2",
      "--socket-timeout",
      "30",
      "-f",
      format,
      "--merge-output-format",
      "mp4",
      "-o",
      outputPath,
      media.url,
    ];
    if (this.options.ffmpegPath) args.unshift("--ffmpeg-location", this.options.ffmpegPath);

    return new Promise<DownloadResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
      let stderr = "";
      let stdoutTail = "";
      let killedByTimeout = false;
      let aborted = false;
      const timeout = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
      }, (this.options.timeoutSeconds ?? 300) * 1000);
      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const handleLine = (line: string) => {
        const match = line.match(PROGRESS_RE);
        if (!match) return;
        const percent = asNumber(match[1]);
        const totalValue = asNumber(match[2]);
        const totalUnit = match[3] ?? "B";
        const speedValue = asNumber(match[4]);
        const speedUnit = match[5] ?? "B";
        if (percent == null || totalValue == null) return;
        const totalBytes = Math.round(toBytes(totalValue, totalUnit));
        const downloadedBytes = Math.round((percent / 100) * totalBytes);
        onProgress({
          downloadedBytes,
          totalBytes,
          speedBps: speedValue == null ? null : Math.round(toBytes(speedValue, speedUnit)),
          fraction: Math.min(1, percent / 100),
        });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutTail = (stdoutTail + text).slice(-2000);
        for (const line of text.split(/\r?\n|\r/)) handleLine(line);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr = (stderr + text).slice(-8000);
        for (const line of text.split(/\r?\n|\r/)) handleLine(line);
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new DownloadError("CONFIG", "yt-dlp 未安装或路径不可执行"));
        } else {
          reject(new DownloadError("INTERNAL", `无法启动 yt-dlp：${safeErrorMessage(error)}`));
        }
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          reject(new DownloadError("CANCELED", "下载已取消"));
          return;
        }
        if (killedByTimeout) {
          reject(new DownloadError("TIMEOUT", "yt-dlp 下载超时"));
          return;
        }
        if (code === 0) {
          const finalPath = findOutput(outputPath);
          if (!finalPath) {
            reject(new DownloadError("INVALID_MEDIA", "yt-dlp 成功退出但没有生成媒体文件"));
            return;
          }
          if (finalPath !== outputPath) {
            try {
              renameSync(finalPath, outputPath);
            } catch {
              // If rename fails, return the path yt-dlp actually wrote.
              resolve({
                filePath: finalPath,
                bytesWritten: statSync(finalPath).size,
                contentType: "video/mp4",
              });
              return;
            }
          }
          resolve({
            filePath: outputPath,
            bytesWritten: statSync(outputPath).size,
            contentType: "video/mp4",
          });
          return;
        }
        const combined = redactUrlsInText(`${stderr}\n${stdoutTail}`);
        if (/Fresh cookies|cookies .*needed|login required|Sign in to confirm/i.test(combined)) {
          reject(
            new DownloadError(
              "RESOURCE_UNAVAILABLE",
              "yt-dlp 需要抖音登录 Cookie 才能解析该作品；请确认抖音账号已连接且作品允许下载，或配置下载 API",
              { retryable: false },
            ),
          );
        } else if (/HTTP Error 403|Forbidden|403/i.test(combined)) {
          reject(
            new DownloadError("RESOURCE_UNAVAILABLE", "yt-dlp 下载被拒绝（HTTP 403），作品可能已失效或受限", {
              retryable: false,
            }),
          );
        } else if (/Private|not available|deleted|已删除|私密|不可用/i.test(combined)) {
          reject(new DownloadError("RESOURCE_UNAVAILABLE", "作品不可访问或已被删除", { retryable: false }));
        } else if (/timed? out|Connection reset|Temporary failure/i.test(combined)) {
          reject(new DownloadError("NETWORK", "yt-dlp 网络错误", { retryable: true }));
        } else {
          reject(
            new DownloadError("HTTP_ERROR", `yt-dlp 失败（退出码 ${code ?? "?"}）：${combined.trim().slice(-500)}`, {
              retryable: true,
            }),
          );
        }
      });
    });
  }
}
