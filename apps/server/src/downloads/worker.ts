import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  DownloadError,
  toVaultError,
  type DownloadProgress,
  type MediaDownloader,
  type MediaInput,
  type WorkMediaLink,
} from "@vault/core";
import { downloadJobs, videos, type schema } from "@vault/db";
import { now, resolveWithin, safeErrorMessage, truncate } from "@vault/shared";
import {
  assertLooksLikeMedia,
  computeSha256,
  detectMediaSignature,
  DirectMediaDownloader,
  DouyinApiDownloader,
  generateCover,
  httpDownloadCover,
  probeMedia,
  YtDlpDownloader,
} from "@vault/downloader-adapters";
import type { AppConfig, Paths } from "../config.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { MediaLibraryService } from "../media/library-service.js";
import type { MessageIngestService } from "../messages/ingest-service.js";
import type { MediaUrlCache } from "../messages/media-cache.js";
import type { SettingsService } from "../settings/service.js";
import type { StorageService } from "../storage/storage-service.js";

interface ActiveDownload {
  jobId: string;
  controller: AbortController;
  startedAt: number;
}

type WorkMediaResolver = (
  workId: string,
  platformGroupId: string | null,
) => Promise<WorkMediaLink | null>;

export interface WorkerState {
  running: boolean;
  pausedReasons: string[];
  activeCount: number;
  lastTickAt: number | null;
}

const LEASE_MS = 5 * 60_000;

export class DownloadWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, ActiveDownload>();
  private running = false;
  private stopping = false;
  private tickInFlight = false;
  private pausedReasons = new Set<string>();
  private lastTickAt: number | null = null;
  private rateLimitTimer: NodeJS.Timeout | null = null;
  private workMediaResolver: WorkMediaResolver | null = null;
  private readonly ownerId = `worker-${randomUUID()}`;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly sqlite: BetterSqlite3.Database,
    private readonly config: AppConfig,
    private readonly paths: Paths,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly library: MediaLibraryService,
    private readonly ingest: MessageIngestService,
    private readonly mediaCache: MediaUrlCache,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = true;
    this.recoverInterrupted();
    this.timer = setInterval(() => this.scheduleTick(), 1000);
    this.timer.unref?.();
    this.scheduleTick();
    this.logger.info("下载 Worker 已启动");
  }

  async stop(): Promise<void> {
    this.running = false;
    // A graceful shutdown must not look like a user cancellation: leave
    // in-flight jobs in their current state and let startup recovery requeue
    // them. Only a user delete/explicit cancel marks a task CANCELED.
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.rateLimitTimer) clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = null;
    for (const [, active] of this.active) active.controller.abort(new Error("服务停止"));
    const deadline = Date.now() + 5000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private handleAbort(jobId: string, tempPath: string): void {
    if (this.stopping) return;
    this.markCanceled(jobId);
    this.safeDelete(tempPath);
  }

  wake(): void {
    this.scheduleTick();
  }

  /**
   * Supply a resolver backed by the primary IM session. It lets the worker
   * obtain a fresh signed direct link for works discovered through history
   * sync, instead of requiring separate yt-dlp cookies or an external API.
   */
  setWorkMediaResolver(resolver: WorkMediaResolver | null): void {
    this.workMediaResolver = resolver;
  }

  get state(): WorkerState {
    return {
      running: this.running,
      pausedReasons: [...this.pausedReasons],
      activeCount: this.active.size,
      lastTickAt: this.lastTickAt,
    };
  }

  pause(reason: string): void {
    this.pausedReasons.add(reason);
  }

  private pauseForRateLimit(seconds = 300): void {
    this.pause("rate_limited");
    if (this.rateLimitTimer) clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = null;
      this.resume("rate_limited");
      this.logger.info("平台限流冷却结束，恢复下载队列");
      this.scheduleTick();
    }, seconds * 1000);
    this.rateLimitTimer.unref?.();
  }

  resume(reason: string): void {
    this.pausedReasons.delete(reason);
  }

  cancel(videoId: string): void {
    const active = this.active.get(videoId);
    if (active) active.controller.abort(new Error("任务已取消"));
  }

  private scheduleTick(): void {
    if (this.tickInFlight || !this.running) return;
    this.tickInFlight = true;
    void this.tick()
      .catch((error) => this.logger.error({ error: safeErrorMessage(error) }, "下载调度循环异常"))
      .finally(() => {
        this.tickInFlight = false;
      });
  }

  private async tick(): Promise<void> {
    this.lastTickAt = now();
    const settings = this.settings.get();
    if (!settings.download.enabled) {
      this.pause("downloads_disabled");
      return;
    }
    this.resume("downloads_disabled");
    this.recoverExpiredLeases();

    const storage = this.storage.get();
    const reserveBytes = settings.storage.safetyReserveGb * 1024 ** 3;
    if (storage.freeBytes > 0 && storage.freeBytes < reserveBytes) {
      this.pause("disk_space");
    } else {
      this.resume("disk_space");
    }
    const capacityBytes = settings.storage.capacityGb * 1024 ** 3;
    if (storage.totalBytes > capacityBytes) {
      this.pause("storage_capacity");
    } else {
      this.resume("storage_capacity");
    }
    if (this.pausedReasons.size > 0) return;

    const slots = settings.download.concurrency - this.active.size;
    if (slots <= 0) return;
    const timestamp = now();
    const candidates = this.sqlite
      .prepare(
        `SELECT j.id AS job_id, j.video_id
           FROM download_jobs j
           JOIN videos v ON v.id = j.video_id
          WHERE j.status IN ('PENDING','RETRY_WAIT')
            AND (j.next_retry_at IS NULL OR j.next_retry_at <= ?)
            AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= ?)
            AND v.status IN ('pending','failed')
          ORDER BY j.priority ASC, j.created_at ASC
          LIMIT ?`,
      )
      .all(timestamp, timestamp, slots) as Array<{ job_id: string; video_id: string }>;

    for (const candidate of candidates) {
      if (this.active.size >= settings.download.concurrency) break;
      const claimed = this.claim(candidate.job_id, timestamp + LEASE_MS);
      if (!claimed) continue;
      const controller = new AbortController();
      this.active.set(candidate.video_id, {
        jobId: candidate.job_id,
        controller,
        startedAt: timestamp,
      });
      void this.processJob(candidate.job_id, candidate.video_id, controller)
        .catch((error) => {
          this.logger.error(
            { jobId: candidate.job_id, error: safeErrorMessage(error) },
            "下载任务处理异常",
          );
        })
        .finally(() => {
          this.active.delete(candidate.video_id);
          this.scheduleTick();
        });
    }
  }

  private claim(jobId: string, leaseUntil: number): boolean {
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `UPDATE download_jobs
            SET status='RESOLVING', lease_owner=?, lease_expires_at=?, attempts=attempts+1,
                started_at=COALESCE(started_at, ?), updated_at=?, error_code=NULL, error_message=NULL
          WHERE id=? AND status IN ('PENDING','RETRY_WAIT')
            AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
      )
      .run(this.ownerId, leaseUntil, timestamp, timestamp, jobId, timestamp);
    return result.changes === 1;
  }

  private recoverExpiredLeases(): void {
    const timestamp = now();
    const rows = this.sqlite
      .prepare(
        `SELECT id, video_id, status, attempts, max_attempts FROM download_jobs
          WHERE status IN ('RESOLVING','DOWNLOADING','VERIFYING')
            AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(timestamp) as Array<{
      id: string;
      video_id: string;
      status: string;
      attempts: number;
      max_attempts: number;
    }>;
    for (const row of rows) {
      if (this.active.has(row.video_id)) continue;
      this.failOrRetry(
        row.id,
        row.video_id,
        new DownloadError("INTERNAL", "租约过期，任务已重新排队", { retryable: true }),
        row.attempts,
        row.max_attempts,
        "lease_expired",
        true,
      );
    }
  }

  private recoverInterrupted(): void {
    const rows = this.sqlite
      .prepare(
        `SELECT j.id, j.video_id, j.status, j.attempts, j.max_attempts,
                v.status AS video_status, v.file_path AS video_file_path
           FROM download_jobs j JOIN videos v ON v.id = j.video_id
          WHERE j.status IN ('RESOLVING','DOWNLOADING','VERIFYING')`,
      )
      .all() as Array<{
      id: string;
      video_id: string;
      status: string;
      attempts: number;
      max_attempts: number;
      video_status: string;
      video_file_path: string | null;
    }>;
    for (const row of rows) {
      // Crash after the atomic file move + video update but before the job row
      // was marked COMPLETED: the cache is already valid, so finish the job
      // instead of re-downloading a source that may now be gone.
      if (row.video_status === "ready" && row.video_file_path) {
        try {
          const absolute = resolveWithin(this.paths.videosDir, row.video_file_path);
          if (existsSync(absolute)) {
            const timestamp = now();
            this.sqlite
              .prepare(
                `UPDATE download_jobs SET status='COMPLETED', progress=1, error_code=NULL,
                    error_message=NULL, lease_owner=NULL, lease_expires_at=NULL,
                    finished_at=?, updated_at=? WHERE id=?`,
              )
              .run(timestamp, timestamp, row.id);
            this.logger.info({ jobId: row.id, videoId: row.video_id }, "恢复任务：媒体已就绪，补记任务完成");
            continue;
          }
        } catch {
          // Fall through to a normal retry; the file check below will flag it.
        }
      }
      this.logger.warn({ jobId: row.id, status: row.status }, "恢复上次中断的下载任务");
      this.failOrRetry(
        row.id,
        row.video_id,
        new DownloadError("INTERNAL", "服务重启，任务已恢复", { retryable: true }),
        row.attempts,
        row.max_attempts,
        "recovered",
        true,
      );
    }

    // A ready record whose file vanished is not a successful cache.
    const readyRows = this.sqlite
      .prepare("SELECT id, file_path FROM videos WHERE status='ready' AND file_path IS NOT NULL")
      .all() as Array<{ id: string; file_path: string }>;
    for (const row of readyRows) {
      try {
        const absolute = resolveWithin(this.paths.videosDir, row.file_path);
        if (!existsSync(absolute)) {
          this.sqlite
            .prepare(
              `UPDATE videos SET status='failed', last_error_code='FILE_MISSING',
                 last_error_message='媒体文件缺失，可能被外部删除', updated_at=? WHERE id=?`,
            )
            .run(now(), row.id);
          this.sqlite
            .prepare(
              `UPDATE download_jobs SET status='FAILED', error_code='FILE_MISSING',
                 error_message='媒体文件缺失', finished_at=?, updated_at=? WHERE video_id=?`,
            )
            .run(now(), now(), row.id);
          this.logger.error({ videoId: row.id }, "已缓存视频的媒体文件缺失，已标记失败");
        }
      } catch {
        // Path validation errors are handled by the orphan audit.
      }
    }

    // Pending videos without a queue row (for example after a manual DB fix)
    // are re-queued instead of silently sitting forever.
    const orphanPending = this.sqlite
      .prepare(
        `SELECT v.id FROM videos v LEFT JOIN download_jobs j ON j.video_id = v.id
          WHERE v.status='pending' AND j.id IS NULL`,
      )
      .all() as Array<{ id: string }>;
    for (const row of orphanPending) {
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO download_jobs
            (id, video_id, status, priority, attempts, max_attempts, progress, source, created_at, updated_at)
           VALUES (?, ?, 'PENDING', 3, 0, ?, 0, 'repair', ?, ?)`,
        )
        .run(ulid(), row.id, this.settings.get().download.maxAttempts, timestamp, timestamp);
    }
  }

  private async processJob(
    jobId: string,
    videoId: string,
    controller: AbortController,
  ): Promise<void> {
    const video = this.db.select().from(videos).where(eq(videos.id, videoId)).get();
    const job = this.db.select().from(downloadJobs).where(eq(downloadJobs.id, jobId)).get();
    if (!video || !job || video.status === "deleting" || video.status === "deleted" || job.status === "CANCELED") {
      this.markCanceled(jobId);
      return;
    }
    const settings = this.settings.get();
    const latestMessage = this.ingest.latestMessageForVideo(videoId);
    let mediaUrl =
      this.mediaCache.getForVideo(videoId) ??
      (latestMessage ? this.mediaCache.get(latestMessage.id) : null);
    let title = video.title;
    let coverUrl = latestMessage?.coverUrl ?? null;
    let resolveFailure: string | null = null;
    if (!mediaUrl && video.workId && this.workMediaResolver) {
      const platformGroupId = latestMessage
        ? this.platformGroupIdFor(latestMessage.groupId)
        : null;
      try {
        const resolved = await this.workMediaResolver(video.workId, platformGroupId);
        if (resolved) {
          mediaUrl = resolved.url;
          title = title ?? resolved.title ?? null;
          coverUrl = coverUrl ?? resolved.coverUrl ?? null;
          // Keep the URL only in memory; it is signed and expires quickly.
          this.mediaCache.setForVideo(videoId, resolved.url);
          if (latestMessage) this.mediaCache.set(latestMessage.id, resolved.url);
          this.logger.info(
            { jobId, videoId, adapter: "douyin-im", host: safeMediaHost(resolved.url) },
            "已通过主 IM 适配器获取媒体直链",
          );
        }
      } catch (error) {
        resolveFailure = safeErrorMessage(error);
        this.logger.warn(
          { jobId, videoId, error: resolveFailure },
          "主 IM 适配器未能解析媒体直链，继续尝试备用下载器",
        );
      }
    }
    const input: MediaInput = {
      videoId,
      workId: video.workId,
      shareUrl: latestMessage?.shareUrl ?? null,
      mediaUrl,
      title,
      coverUrl,
    };
    const adapters = this.buildAdapters(settings.download.preferredQuality, settings.download.timeoutSeconds);
    const candidates = adapters.filter((adapter) => adapter.supports(input));
    if (candidates.length === 0) {
      await this.finishFailure(
        jobId,
        videoId,
        new DownloadError(
          "UNRESOLVED",
          mediaUrl
            ? "没有可用的下载适配器"
            : "媒体直链已过期且未配置下载 API / yt-dlp，无法继续",
          { retryable: false },
        ),
        job.attempts,
        job.maxAttempts,
      );
      return;
    }

    const tempPath = resolve(this.paths.tempDir, `job-${jobId}.part`);
    let lastError: unknown = new DownloadError("UNRESOLVED", "所有下载适配器均失败");
    let retryableError: unknown = null;
    let specificError: unknown = null;
    let tempRetained = false;

    for (let index = 0; index < candidates.length; index++) {
      const adapter = candidates[index] as MediaDownloader;
      if (controller.signal.aborted) {
        this.handleAbort(jobId, tempPath);
        return;
      }
      if (index > 0) this.safeDelete(tempPath);
      try {
        this.updateJobStatus(jobId, "RESOLVING");
        const media = await adapter.resolve(input);
        if (controller.signal.aborted) {
          if (this.stopping) return;
          this.markCanceled(jobId);
          this.safeDelete(tempPath);
          return;
        }
        this.updateJobStatus(jobId, "DOWNLOADING", { leaseExpiresAt: now() + LEASE_MS });
        const renewal = setInterval(() => {
          this.sqlite
            .prepare("UPDATE download_jobs SET lease_expires_at=? WHERE id=? AND status='DOWNLOADING'")
            .run(now() + LEASE_MS, jobId);
        }, 30_000);
        renewal.unref?.();
        let lastDbUpdate = 0;
        let lastSse = 0;
        const onProgress = (progress: DownloadProgress) => {
          const timestamp = now();
          if (timestamp - lastDbUpdate > 450) {
            lastDbUpdate = timestamp;
            this.sqlite
              .prepare(
                `UPDATE download_jobs SET progress=?, downloaded_bytes=?, total_bytes=?, speed_bps=?,
                    lease_expires_at=?, updated_at=? WHERE id=? AND status='DOWNLOADING'`,
              )
              .run(
                progress.fraction ?? 0,
                progress.downloadedBytes,
                progress.totalBytes,
                progress.speedBps,
                timestamp + LEASE_MS,
                timestamp,
                jobId,
              );
          }
          if (timestamp - lastSse > 600) {
            lastSse = timestamp;
            this.bus.publish("download.progress", {
              jobId,
              videoId,
              progress: progress.fraction ?? 0,
              downloadedBytes: progress.downloadedBytes,
              totalBytes: progress.totalBytes,
              speedBps: progress.speedBps,
            });
          }
        };
        let result;
        try {
          result = await adapter.download(media, tempPath, onProgress, controller.signal);
        } finally {
          clearInterval(renewal);
        }
        if (controller.signal.aborted) {
          this.handleAbort(jobId, tempPath);
          return;
        }
        this.updateJobStatus(jobId, "VERIFYING");
        const downloadedPath = result.filePath;
        if (!existsSync(downloadedPath) && existsSync(tempPath)) {
          renameSync(tempPath, downloadedPath);
        }
        const verification = await this.verify(downloadedPath, media.durationSeconds ?? null);
        const relativeDirectory = video.id.slice(0, 2);
        const extension = verification.signature === "webm" ? ".webm" : ".mp4";
        const finalRelative = `${relativeDirectory}/${video.id}${extension}`;
        const finalAbsolute = resolveWithin(this.paths.videosDir, finalRelative);
        mkdirSync(resolve(finalAbsolute, ".."), { recursive: true, mode: 0o700 });
        if (existsSync(finalAbsolute)) unlinkSync(finalAbsolute);
        renameSync(downloadedPath, finalAbsolute);
        if (existsSync(downloadedPath) && downloadedPath !== tempPath) this.safeDelete(downloadedPath);

        const cover = await this.createCover(videoId, coverUrl, finalAbsolute, controller.signal);
        const finalSize = statSync(finalAbsolute).size;
        const readyAt = now();
        this.sqlite
          .prepare(
            `UPDATE videos SET status='ready', file_path=?, cover_path=?, file_size=?, duration_seconds=?,
                width=?, height=?, sha256=?, downloaded_at=?, last_error_code=NULL, last_error_message=NULL,
                updated_at=? WHERE id=? AND status!='deleting'`,
          )
          .run(
            finalRelative,
            cover,
            finalSize,
            verification.durationSeconds,
            verification.width,
            verification.height,
            verification.sha256,
            readyAt,
            readyAt,
            videoId,
          );
        const stillThere = this.db.select().from(videos).where(eq(videos.id, videoId)).get();
        if (!stillThere || stillThere.status === "deleting") {
          this.safeDelete(finalAbsolute);
          if (cover) this.safeDelete(resolveWithin(this.paths.coversDir, cover));
          this.markCanceled(jobId);
          return;
        }

        if (!video.workId) {
          const duplicate = this.sqlite
            .prepare(
              `SELECT id FROM videos WHERE sha256=? AND id!=? AND status='ready' LIMIT 1`,
            )
            .get(verification.sha256, videoId) as { id: string } | undefined;
          if (duplicate) {
            this.library.mergeDuplicate(videoId, duplicate.id);
            if (cover) {
              this.sqlite
                .prepare("UPDATE videos SET cover_path=COALESCE(cover_path, ?) WHERE id=?")
                .run(cover, duplicate.id);
            }
            this.storage.invalidate();
            this.bus.publish("download.completed", {
              jobId,
              videoId: duplicate.id,
              mergedFrom: videoId,
              fileSize: finalSize,
            });
            this.logger.info({ videoId, existingVideoId: duplicate.id }, "下载完成并合并重复媒体");
            return;
          }
        }

        this.sqlite
          .prepare(
            `UPDATE download_jobs SET status='COMPLETED', progress=1, downloaded_bytes=?, total_bytes=?,
                speed_bps=NULL, error_code=NULL, error_message=NULL, lease_owner=NULL, lease_expires_at=NULL,
                finished_at=?, updated_at=? WHERE id=?`,
          )
          .run(
            finalSize,
            finalSize,
            readyAt,
            readyAt,
            jobId,
          );
        this.storage.invalidate();
        this.bus.publish("download.completed", {
          jobId,
          videoId,
          fileSize: finalSize,
          durationSeconds: verification.durationSeconds,
        });
        this.logger.info({ jobId, videoId, adapter: adapter.name, fileSize: finalSize }, "视频缓存完成");
        return;
      } catch (error) {
        lastError = error;
        const vaultError = toVaultError(error);
        this.logger.warn(
          { jobId, videoId, adapter: adapter.name, code: vaultError.code, error: truncate(vaultError.message, 300) },
          "下载适配器失败",
        );
        if (controller.signal.aborted) {
          this.handleAbort(jobId, tempPath);
          return;
        }
        tempRetained = vaultError.code === "NETWORK" || vaultError.code === "TIMEOUT";
        if (vaultError.retryable) retryableError ??= error;
        if (vaultError.code !== "RESOURCE_UNAVAILABLE") specificError ??= error;
        if (vaultError.code === "RATE_LIMITED") {
          this.pauseForRateLimit(300);
          break;
        }
        if (vaultError.code === "DISK_FULL") {
          this.pause("disk_space");
          break;
        }
      }
    }

    // Prefer a transient error so the job can retry, then a concrete media
    // error (invalid format, bad configuration) over a generic "unavailable"
    // from a later fallback adapter. If only generic failures remain, keep the
    // IM resolver's reason because it is the most actionable.
    let error = toVaultError(retryableError ?? specificError ?? lastError);
    if (!retryableError && !specificError && resolveFailure && error.code === "RESOURCE_UNAVAILABLE") {
      error = new DownloadError(
        "RESOURCE_UNAVAILABLE",
        `主 IM 适配器无法解析该作品：${resolveFailure}`,
        { retryable: false },
      );
    }
    if (!tempRetained) this.safeDelete(tempPath);
    await this.finishFailure(jobId, videoId, error, job.attempts, job.maxAttempts);
  }

  private platformGroupIdFor(groupId: string): string | null {
    const row = this.sqlite
      .prepare("SELECT platform_group_id FROM groups WHERE id=?")
      .get(groupId) as { platform_group_id: string } | undefined;
    return row?.platform_group_id ?? null;
  }

  private buildAdapters(
    quality: "540p" | "720p" | "1080p" | "best",
    timeoutSeconds: number,
  ): MediaDownloader[] {
    const adapters: MediaDownloader[] = [
      new DirectMediaDownloader({
        extraHosts: this.config.mediaAllowedHosts,
        allowLoopback: this.config.nodeEnv !== "production",
        timeoutSeconds,
      }),
    ];
    if (this.config.dtkBaseUrl) {
      adapters.push(
        new DouyinApiDownloader({
          baseUrl: this.config.dtkBaseUrl,
          apiKey: this.config.dtkApiKey ?? undefined,
          mode: this.config.dtkMode,
          timeoutSeconds,
          extraHosts: this.config.mediaAllowedHosts,
          allowLoopback: this.config.nodeEnv !== "production",
        }),
      );
    }
    adapters.push(
      new YtDlpDownloader({
        binaryPath: this.config.ytdlpPath,
        ffmpegPath: this.config.ffmpegPath,
        preferredQuality: quality,
        timeoutSeconds: Math.max(timeoutSeconds, 300),
      }),
    );
    return adapters;
  }

  private async verify(
    path: string,
    fallbackDuration: number | null,
  ): Promise<{
    signature: string;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    sha256: string;
  }> {
    const signature = assertLooksLikeMedia(path);
    const settings = this.settings.get();
    let durationSeconds = fallbackDuration;
    let width: number | null = null;
    let height: number | null = null;
    if (settings.download.verifyWithFfprobe) {
      const probe = await probeMedia(path, { ffprobePath: this.config.ffprobePath });
      if (!probe.hasVideo) throw new DownloadError("INVALID_MEDIA", "文件不包含视频轨道");
      durationSeconds = probe.durationSeconds ?? fallbackDuration;
      width = probe.width;
      height = probe.height;
    }
    const sha256 = await computeSha256(path);
    return { signature, durationSeconds, width, height, sha256 };
  }

  private async createCover(
    videoId: string,
    coverUrl: string | null,
    videoPath: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    mkdirSync(this.paths.coversDir, { recursive: true, mode: 0o700 });
    if (coverUrl) {
      const temp = resolve(this.paths.tempDir, `cover-${videoId}.tmp`);
      const allowed = (url: string) => {
        try {
          const host = new URL(url).hostname;
          if (this.config.nodeEnv !== "production" && ["127.0.0.1", "localhost"].includes(host)) return true;
          return (
            host.endsWith(".douyinpic.com") ||
            host.endsWith(".douyinstatic.com") ||
            host.endsWith(".byteimg.com") ||
            host.endsWith(".douyin.com") ||
            this.config.mediaAllowedHosts.some(
              (allowed) => host === allowed || host.endsWith(`.${allowed}`),
            )
          );
        } catch {
          return false;
        }
      };
      const ok = await httpDownloadCover(coverUrl, temp, { validateUrl: allowed, timeoutMs: 15_000 });
      if (ok && !signal.aborted) {
        try {
          const signature = detectImageSignature(temp);
          if (signature) {
            const relative = `${videoId}.${signature}`;
            const target = resolveWithin(this.paths.coversDir, relative);
            renameSync(temp, target);
            return relative;
          }
        } catch {
          // Fall back to an extracted frame.
        }
      }
      this.safeDelete(temp);
    }
    const relative = `${videoId}.jpg`;
    const target = resolveWithin(this.paths.coversDir, relative);
    const generated = await generateCover(videoPath, target, { ffmpegPath: this.config.ffmpegPath });
    return generated ? relative : null;
  }

  private async finishFailure(
    jobId: string,
    videoId: string,
    error: unknown,
    attempts: number,
    maxAttempts: number,
  ): Promise<void> {
    this.failOrRetry(jobId, videoId, error, attempts, maxAttempts, "download", false);
  }

  private failOrRetry(
    jobId: string,
    videoId: string,
    error: unknown,
    attempts: number,
    maxAttempts: number,
    phase: string,
    recovered: boolean,
  ): void {
    const vaultError = toVaultError(error);
    const settings = this.settings.get();
    const retryable = vaultError.retryable && attempts < maxAttempts;
    const timestamp = now();
    const existingJob = this.sqlite
      .prepare("SELECT status FROM download_jobs WHERE id=?")
      .get(jobId) as { status: string } | undefined;
    if (!existingJob || existingJob.status === "CANCELED" || existingJob.status === "COMPLETED") {
      return;
    }
    if (retryable) {
      const delaySeconds = recovered
        ? 0
        : settings.download.retryDelaysSeconds[
            Math.min(attempts - 1, settings.download.retryDelaysSeconds.length - 1)
          ] ?? 60;
      this.sqlite
        .prepare(
          `UPDATE download_jobs SET status='RETRY_WAIT', attempts=?, next_retry_at=?, error_code=?, error_message=?,
              lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(attempts, timestamp + delaySeconds * 1000, vaultError.code, truncate(vaultError.message, 500), timestamp, jobId);
      this.sqlite
        .prepare(
          `UPDATE videos SET status='pending', last_error_code=?, last_error_message=?, updated_at=?
            WHERE id=? AND status!='deleting'`,
        )
        .run(vaultError.code, truncate(vaultError.message, 500), timestamp, videoId);
      this.logger.warn(
        { jobId, videoId, code: vaultError.code, attempts, retryInSeconds: delaySeconds, phase, recovered },
        "下载失败，等待重试",
      );
      return;
    }
    this.sqlite
      .prepare(
        `UPDATE download_jobs SET status='FAILED', attempts=?, error_code=?, error_message=?,
            lease_owner=NULL, lease_expires_at=NULL, finished_at=?, updated_at=? WHERE id=?`,
      )
      .run(attempts, vaultError.code, truncate(vaultError.message, 500), timestamp, timestamp, jobId);
    this.sqlite
      .prepare(
        `UPDATE videos SET status='failed', last_error_code=?, last_error_message=?, updated_at=?
          WHERE id=? AND status!='deleting'`,
      )
      .run(vaultError.code, truncate(vaultError.message, 500), timestamp, videoId);
    this.bus.publish("download.failed", {
      jobId,
      videoId,
      code: vaultError.code,
      message: truncate(vaultError.message, 300),
      attempts,
    });
    this.logger.error({ jobId, videoId, code: vaultError.code, attempts }, "视频缓存最终失败");
  }

  private updateJobStatus(
    jobId: string,
    status: string,
    extra: { leaseExpiresAt?: number } = {},
  ): void {
    const timestamp = now();
    this.sqlite
      .prepare(
        `UPDATE download_jobs SET status=?, updated_at=?, lease_owner=?,
            lease_expires_at=? WHERE id=? AND status NOT IN ('CANCELED','COMPLETED')`,
      )
      .run(status, timestamp, this.ownerId, extra.leaseExpiresAt ?? timestamp + LEASE_MS, jobId);
  }

  private markCanceled(jobId: string): void {
    this.sqlite
      .prepare(
        `UPDATE download_jobs SET status='CANCELED', lease_owner=NULL, lease_expires_at=NULL,
            finished_at=?, updated_at=? WHERE id=? AND status NOT IN ('COMPLETED')`,
      )
      .run(now(), now(), jobId);
  }

  private safeDelete(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Best effort.
    }
  }

  /** Requeue permanently failed jobs after a resolver or configuration change. */
  retryAllFailed(limit = 200): { count: number } {
    const jobs = this.sqlite
      .prepare(
        `SELECT id, video_id FROM download_jobs
          WHERE status='FAILED'
          ORDER BY finished_at DESC, updated_at DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; video_id: string }>;
    if (jobs.length === 0) return { count: 0 };
    const timestamp = now();
    const resetJob = this.sqlite.prepare(
      `UPDATE download_jobs SET status='PENDING', priority=1, attempts=0, next_retry_at=NULL,
          lease_owner=NULL, lease_expires_at=NULL, error_code=NULL, error_message=NULL,
          progress=0, downloaded_bytes=NULL, total_bytes=NULL, speed_bps=NULL,
          finished_at=NULL, updated_at=?
        WHERE id=? AND status='FAILED'`,
    );
    const resetVideo = this.sqlite.prepare(
      `UPDATE videos SET status='pending', last_error_code=NULL, last_error_message=NULL, updated_at=?
        WHERE id=? AND status='failed'`,
    );
    this.sqlite.transaction(() => {
      for (const job of jobs) {
        resetJob.run(timestamp, job.id);
        resetVideo.run(timestamp, job.video_id);
      }
    })();
    this.scheduleTick();
    return { count: jobs.length };
  }

  retryJob(jobId: string): { ok: boolean; videoId: string | null } {
    const job = this.db.select().from(downloadJobs).where(eq(downloadJobs.id, jobId)).get();
    if (!job) throw Object.assign(new Error("下载任务不存在"), { statusCode: 404 });
    if (!["FAILED", "CANCELED", "RETRY_WAIT", "PAUSED"].includes(job.status)) {
      throw Object.assign(new Error("当前任务状态不可重试"), { statusCode: 409 });
    }
    const timestamp = now();
    this.sqlite
      .prepare(
        `UPDATE download_jobs SET status='PENDING', priority=1, attempts=0, next_retry_at=NULL,
            lease_owner=NULL, lease_expires_at=NULL, error_code=NULL, error_message=NULL,
            progress=0, downloaded_bytes=NULL, total_bytes=NULL, speed_bps=NULL, finished_at=NULL, updated_at=?
          WHERE id=?`,
      )
      .run(timestamp, jobId);
    this.sqlite
      .prepare(
        `UPDATE videos SET status='pending', last_error_code=NULL, last_error_message=NULL, updated_at=?
          WHERE id=? AND status='failed'`,
      )
      .run(timestamp, job.videoId);
    this.scheduleTick();
    return { ok: true, videoId: job.videoId };
  }

  listJobs(status: string | undefined, limit: number, offset: number): {
    items: Array<Record<string, unknown>>;
    total: number;
  } {
    const where = status ? "WHERE j.status = ?" : "";
    const params = status ? [status] : [];
    const count = this.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM download_jobs j ${where}`)
      .get(...params) as { count: number };
    const rows = this.sqlite
      .prepare(
        `SELECT j.*, v.title, v.work_id, v.status AS video_status, v.last_error_message AS video_error,
                v.cover_path, v.file_size,
                (SELECT MAX(vs.shared_at) FROM video_shares vs WHERE vs.video_id = v.id) AS latest_shared_at
           FROM download_jobs j JOIN videos v ON v.id = j.video_id
           ${where}
          ORDER BY CASE j.status
            WHEN 'DOWNLOADING' THEN 0 WHEN 'VERIFYING' THEN 1 WHEN 'RESOLVING' THEN 2
            WHEN 'PENDING' THEN 3 WHEN 'RETRY_WAIT' THEN 4 WHEN 'PAUSED' THEN 5
            WHEN 'FAILED' THEN 6 WHEN 'COMPLETED' THEN 7 ELSE 8 END,
            j.priority ASC, j.updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({
        id: row.id,
        videoId: row.video_id,
        status: row.status,
        priority: row.priority,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        progress: row.progress,
        downloadedBytes: row.downloaded_bytes,
        totalBytes: row.total_bytes,
        speedBps: row.speed_bps,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nextRetryAt: row.next_retry_at,
        finishedAt: row.finished_at,
        title: row.title,
        workId: row.work_id,
        videoStatus: row.video_status,
        coverUrl: row.cover_path ? `/api/v1/videos/${row.video_id}/cover` : null,
        latestSharedAt: row.latest_shared_at,
      })),
      total: Number(count.count),
    };
  }

  pausedReason(): string | null {
    return this.pausedReasons.size > 0 ? [...this.pausedReasons].join(",") : null;
  }
}

function safeMediaHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function detectImageSignature(path: string): "jpg" | "png" | "webp" | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(16);
    const bytes = readSync(fd, buffer, 0, 16, 0);
    const data = buffer.subarray(0, bytes);
    if (data[0] === 0xff && data[1] === 0xd8) return "jpg";
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
      return "webp";
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
