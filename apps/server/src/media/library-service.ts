import { existsSync, statSync, unlinkSync } from "node:fs";
import { extname, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  isWatchedByProgress,
  type VideoAvailability,
  type VideoStatus,
} from "@vault/core";
import {
  cleanupLogs,
  downloadJobs,
  videoProgress,
  videos,
  videoShares,
  type schema,
} from "@vault/db";
import { now, resolveWithin, safeErrorMessage } from "@vault/shared";
import type { Paths } from "../config.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { SettingsService } from "../settings/service.js";
import type { StorageService } from "../storage/storage-service.js";

export type VideoFilter = "all" | "unwatched" | "watched" | "favorites" | "failed" | "pending";

export interface VideoShareView {
  id: string;
  groupId: string;
  groupName: string;
  senderId: string | null;
  senderName: string | null;
  sharedAt: number;
  shareUrl: string | null;
}

export interface VideoView {
  id: string;
  title: string | null;
  authorName: string | null;
  workId: string | null;
  status: VideoStatus;
  fileSize: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  createdAt: number;
  downloadedAt: number | null;
  isFavorite: boolean;
  isWatched: boolean;
  watchedAt: number | null;
  positionSeconds: number;
  lastPlayedAt: number | null;
  latestSharedAt: number;
  shareCount: number;
  hasCover: boolean;
  coverUrl: string | null;
  streamUrl: string | null;
  latestGroup: { id: string; name: string } | null;
  latestSender: string | null;
  lastError: { code: string; message: string } | null;
  /** Filled by the API route for ready videos. */
  availability?: VideoAvailability;
}

export interface VideoDetail extends VideoView {
  shares: VideoShareView[];
  sha256: string | null;
  job: {
    id: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    progress: number;
    errorCode: string | null;
    errorMessage: string | null;
    nextRetryAt: number | null;
    updatedAt: number;
  } | null;
}

interface RawVideoRow {
  id: string;
  title: string | null;
  author_name: string | null;
  work_id: string | null;
  status: string;
  file_size: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  created_at: number;
  downloaded_at: number | null;
  is_favorite: number;
  cover_path: string | null;
  file_path: string | null;
  sha256: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  is_watched: number | null;
  watched_at: number | null;
  position_seconds: number | null;
  last_played_at: number | null;
  latest_shared_at: number | null;
  share_count: number;
}

function mimeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".m4v":
      return "video/x-m4v";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "video/mp4";
  }
}

export class MediaLibraryService {
  private cancelHandler: ((videoId: string) => void) | null = null;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly sqlite: BetterSqlite3.Database,
    private readonly paths: Paths,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  setCancelHandler(handler: (videoId: string) => void): void {
    this.cancelHandler = handler;
  }

  private mapVideo(row: RawVideoRow): VideoView {
    const isWatched = Boolean(row.is_watched);
    return {
      id: row.id,
      title: row.title,
      authorName: row.author_name,
      workId: row.work_id,
      status: row.status as VideoStatus,
      fileSize: row.file_size,
      durationSeconds: row.duration_seconds,
      width: row.width,
      height: row.height,
      createdAt: row.created_at,
      downloadedAt: row.downloaded_at,
      isFavorite: Boolean(row.is_favorite),
      isWatched,
      watchedAt: row.watched_at,
      positionSeconds: row.position_seconds ?? 0,
      lastPlayedAt: row.last_played_at,
      latestSharedAt: row.latest_shared_at ?? row.created_at,
      shareCount: Number(row.share_count),
      hasCover: Boolean(row.cover_path),
      coverUrl: row.cover_path ? `/api/v1/videos/${row.id}/cover` : null,
      streamUrl: row.status === "ready" ? `/api/v1/videos/${row.id}/stream` : null,
      latestGroup: null,
      latestSender: null,
      lastError: row.last_error_code
        ? { code: row.last_error_code, message: row.last_error_message ?? "下载失败" }
        : null,
    };
  }

  private decorateShares(items: VideoView[]): VideoView[] {
    if (items.length === 0) return items;
    const placeholders = items.map(() => "?").join(",");
    const rows = this.sqlite
      .prepare(
        `SELECT vs.video_id, vs.shared_at, m.sender_name, m.share_url,
                g.id AS group_id, g.name AS group_name
           FROM video_shares vs
           JOIN messages m ON m.id = vs.message_id
           JOIN groups g ON g.id = m.group_id
          WHERE vs.video_id IN (${placeholders})
          ORDER BY vs.shared_at DESC`,
      )
      .all(...items.map((item) => item.id)) as Array<{
      video_id: string;
      shared_at: number;
      sender_name: string | null;
      share_url: string | null;
      group_id: string;
      group_name: string;
    }>;
    const latest = new Map<string, (typeof rows)[number]>();
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.video_id, (counts.get(row.video_id) ?? 0) + 1);
      if (!latest.has(row.video_id)) latest.set(row.video_id, row);
    }
    return items.map((item) => {
      const row = latest.get(item.id);
      return {
        ...item,
        shareCount: counts.get(item.id) ?? item.shareCount,
        latestGroup: row ? { id: row.group_id, name: row.group_name } : null,
        latestSender: row?.sender_name ?? null,
      };
    });
  }

  list(input: {
    filter: VideoFilter;
    groupId?: string;
    search?: string;
    sort: "latest" | "downloaded" | "oldest" | "title";
    limit: number;
    offset: number;
  }): { items: VideoView[]; total: number; limit: number; offset: number } {
    const conditions: string[] = ["v.status IN ('ready','pending','failed')"];
    const params: unknown[] = [];
    switch (input.filter) {
      case "unwatched":
        conditions.push("v.status = 'ready'", "COALESCE(p.is_watched,0) = 0");
        break;
      case "watched":
        conditions.push("v.status = 'ready'", "p.is_watched = 1");
        break;
      case "favorites":
        conditions.push("v.is_favorite = 1");
        break;
      case "failed":
        conditions.push("v.status = 'failed'");
        break;
      case "pending":
        conditions.push("v.status = 'pending'");
        break;
      case "all":
        break;
    }
    if (input.groupId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM video_shares vs2 JOIN messages m2 ON m2.id = vs2.message_id WHERE vs2.video_id = v.id AND m2.group_id = ?)",
      );
      params.push(input.groupId);
    }
    if (input.search?.trim()) {
      const like = `%${input.search.trim()}%`;
      conditions.push(
        "(v.title LIKE ? OR v.work_id LIKE ? OR v.author_name LIKE ? OR EXISTS (SELECT 1 FROM video_shares vs3 JOIN messages m3 ON m3.id = vs3.message_id WHERE vs3.video_id = v.id AND (m3.sender_name LIKE ? OR m3.title LIKE ?)))",
      );
      params.push(like, like, like, like, like);
    }
    const where = conditions.join(" AND ");
    const order =
      input.sort === "title"
        ? "COALESCE(v.title,'') COLLATE NOCASE ASC"
        : input.sort === "downloaded"
          ? "v.downloaded_at DESC NULLS LAST, latest_shared_at DESC"
          : input.sort === "oldest"
            ? "latest_shared_at ASC"
            : "latest_shared_at DESC";
    const countRow = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
           FROM videos v
           LEFT JOIN video_progress p ON p.video_id = v.id
          WHERE ${where}`,
      )
      .get(...params) as { count: number };
    const rows = this.sqlite
      .prepare(
        `SELECT v.*, p.is_watched, p.watched_at, p.position_seconds, p.last_played_at,
                (SELECT MAX(vs.shared_at) FROM video_shares vs WHERE vs.video_id = v.id) AS latest_shared_at,
                (SELECT COUNT(*) FROM video_shares vs WHERE vs.video_id = v.id) AS share_count
           FROM videos v
           LEFT JOIN video_progress p ON p.video_id = v.id
          WHERE ${where}
          ORDER BY ${order}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, input.limit, input.offset) as RawVideoRow[];
    return {
      items: this.decorateShares(rows.map((row) => this.mapVideo(row))),
      total: Number(countRow.count),
      limit: input.limit,
      offset: input.offset,
    };
  }

  getById(id: string): VideoDetail | null {
    const row = this.sqlite
      .prepare(
        `SELECT v.*, p.is_watched, p.watched_at, p.position_seconds, p.last_played_at,
                (SELECT MAX(vs.shared_at) FROM video_shares vs WHERE vs.video_id = v.id) AS latest_shared_at,
                (SELECT COUNT(*) FROM video_shares vs WHERE vs.video_id = v.id) AS share_count
           FROM videos v
           LEFT JOIN video_progress p ON p.video_id = v.id
          WHERE v.id = ?`,
      )
      .get(id) as RawVideoRow | undefined;
    if (!row) return null;
    const video = this.decorateShares([this.mapVideo(row)])[0] as VideoView;
    const shares = this.sqlite
      .prepare(
        `SELECT vs.id, vs.shared_at, m.sender_id, m.sender_name, m.share_url,
                g.id AS group_id, g.name AS group_name
           FROM video_shares vs
           JOIN messages m ON m.id = vs.message_id
           JOIN groups g ON g.id = m.group_id
          WHERE vs.video_id = ?
          ORDER BY vs.shared_at DESC`,
      )
      .all(id) as Array<{
      id: string;
      shared_at: number;
      sender_id: string | null;
      sender_name: string | null;
      share_url: string | null;
      group_id: string;
      group_name: string;
    }>;
    const job = this.db.select().from(downloadJobs).where(eq(downloadJobs.videoId, id)).get();
    return {
      ...video,
      sha256: row.sha256,
      shares: shares.map((share) => ({
        id: share.id,
        groupId: share.group_id,
        groupName: share.group_name,
        senderId: share.sender_id,
        senderName: share.sender_name,
        sharedAt: share.shared_at,
        shareUrl: share.share_url,
      })),
      job: job
        ? {
            id: job.id,
            status: job.status,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            progress: job.progress,
            errorCode: job.errorCode,
            errorMessage: job.errorMessage,
            nextRetryAt: job.nextRetryAt,
            updatedAt: job.updatedAt,
          }
        : null,
    };
  }

  update(id: string, patch: { isFavorite?: boolean; isWatched?: boolean }): VideoDetail {
    const video = this.db.select().from(videos).where(eq(videos.id, id)).get();
    if (!video || video.status === "deleted" || video.status === "deleting") {
      throw Object.assign(new Error("视频不存在"), { statusCode: 404 });
    }
    const timestamp = now();
    if (patch.isFavorite !== undefined) {
      this.db.update(videos).set({ isFavorite: patch.isFavorite, updatedAt: timestamp }).where(eq(videos.id, id)).run();
    }
    if (patch.isWatched !== undefined) {
      const progress = this.db.select().from(videoProgress).where(eq(videoProgress.videoId, id)).get();
      if (progress) {
        this.db
          .update(videoProgress)
          .set({
            isWatched: patch.isWatched,
            watchedAt: patch.isWatched ? (progress.watchedAt ?? timestamp) : null,
            updatedAt: timestamp,
          })
          .where(eq(videoProgress.videoId, id))
          .run();
      } else {
        this.db
          .insert(videoProgress)
          .values({
            videoId: id,
            positionSeconds: 0,
            isWatched: patch.isWatched,
            watchedAt: patch.isWatched ? timestamp : null,
            updatedAt: timestamp,
          })
          .run();
      }
    }
    return this.getById(id) as VideoDetail;
  }

  updateProgress(
    id: string,
    input: { positionSeconds: number; durationSeconds?: number | null },
  ): { positionSeconds: number; isWatched: boolean; watchedAt: number | null } {
    const video = this.db.select().from(videos).where(eq(videos.id, id)).get();
    if (!video || video.status !== "ready") {
      throw Object.assign(new Error("视频不可播放"), { statusCode: 409 });
    }
    const settings = this.settings.get();
    const current = this.db.select().from(videoProgress).where(eq(videoProgress.videoId, id)).get();
    const duration =
      input.durationSeconds && input.durationSeconds > 0
        ? input.durationSeconds
        : (video.durationSeconds ?? current?.durationSeconds ?? null);
    const position = Math.max(0, Math.min(input.positionSeconds, duration ? duration * 1.02 : input.positionSeconds));
    const thresholdReached = isWatchedByProgress(position, duration, settings.watchedThreshold);
    const timestamp = now();
    const alreadyWatched = Boolean(current?.isWatched);
    const watchedNow = thresholdReached || alreadyWatched;
    const watchedAt = current?.watchedAt ?? (thresholdReached ? timestamp : null);
    if (current) {
      this.db
        .update(videoProgress)
        .set({
          positionSeconds: position,
          durationSeconds: duration,
          isWatched: watchedNow,
          watchedAt,
          lastPlayedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(videoProgress.videoId, id))
        .run();
    } else {
      this.db
        .insert(videoProgress)
        .values({
          videoId: id,
          positionSeconds: position,
          durationSeconds: duration,
          isWatched: watchedNow,
          watchedAt,
          lastPlayedAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }
    return { positionSeconds: position, isWatched: watchedNow, watchedAt };
  }

  getStreamInfo(id: string): {
    absolutePath: string;
    size: number;
    mtimeMs: number;
    mime: string;
    etag: string;
  } {
    const video = this.db.select().from(videos).where(eq(videos.id, id)).get();
    if (!video || video.status === "deleted" || video.status === "deleting") {
      throw Object.assign(new Error("视频不存在或已删除"), { statusCode: 404 });
    }
    if (video.status !== "ready" || !video.filePath) {
      throw Object.assign(new Error("视频尚未缓存完成"), { statusCode: 409 });
    }
    const absolutePath = resolveWithin(this.paths.videosDir, video.filePath);
    if (!existsSync(absolutePath)) {
      throw Object.assign(new Error("媒体文件缺失"), { statusCode: 404 });
    }
    const stats = statSync(absolutePath);
    return {
      absolutePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mime: mimeForExtension(extname(absolutePath)),
      etag: `"${stats.size}-${Math.floor(stats.mtimeMs)}"`,
    };
  }

  getCoverInfo(id: string): { absolutePath: string; size: number; mime: string; mtimeMs: number } | null {
    const video = this.db.select().from(videos).where(eq(videos.id, id)).get();
    if (!video || !video.coverPath) return null;
    const absolutePath = resolveWithin(this.paths.coversDir, video.coverPath);
    if (!existsSync(absolutePath)) return null;
    const stats = statSync(absolutePath);
    return {
      absolutePath,
      size: stats.size,
      mime: mimeForExtension(extname(absolutePath)),
      mtimeMs: stats.mtimeMs,
    };
  }

  delete(id: string, reason = "manual"): { deleted: boolean; freedBytes: number } {
    const video = this.db.select().from(videos).where(eq(videos.id, id)).get();
    if (!video || video.status === "deleted") return { deleted: false, freedBytes: 0 };
    if (video.status === "deleting") return { deleted: false, freedBytes: 0 };
    const previousStatus = video.status;
    const timestamp = now();
    this.db
      .update(videos)
      .set({ status: "deleting", updatedAt: timestamp })
      .where(eq(videos.id, id))
      .run();
    this.db
      .update(downloadJobs)
      .set({ status: "CANCELED", leaseOwner: null, leaseExpiresAt: null, errorCode: "CANCELED", errorMessage: "用户删除视频", updatedAt: timestamp })
      .where(eq(downloadJobs.videoId, id))
      .run();
    this.cancelHandler?.(id);

    let freedBytes = 0;
    try {
      if (video.filePath) {
        const path = resolveWithin(this.paths.videosDir, video.filePath);
        if (existsSync(path)) {
          freedBytes += statSync(path).size;
          unlinkSync(path);
        }
      }
      if (video.coverPath) {
        const cover = resolveWithin(this.paths.coversDir, video.coverPath);
        if (existsSync(cover)) {
          freedBytes += statSync(cover).size;
          unlinkSync(cover);
        }
      }
    } catch (error) {
      const message = `删除媒体文件失败：${safeErrorMessage(error)}`;
      this.db
        .update(videos)
        .set({ status: previousStatus, lastErrorCode: "DELETE_FAILED", lastErrorMessage: message, updatedAt: now() })
        .where(eq(videos.id, id))
        .run();
      // Keep the queue consistent with the restored playable state. A video
      // that was ready still has its complete task; otherwise leave a visible
      // failed task so the user can retry after fixing permissions.
      if (previousStatus === "ready") {
        this.db
          .update(downloadJobs)
          .set({
            status: "COMPLETED",
            progress: 1,
            errorCode: null,
            errorMessage: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: now(),
            updatedAt: now(),
          })
          .where(eq(downloadJobs.videoId, id))
          .run();
      } else {
        this.db
          .update(downloadJobs)
          .set({
            status: "FAILED",
            errorCode: "DELETE_FAILED",
            errorMessage: message,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: now(),
            updatedAt: now(),
          })
          .where(eq(downloadJobs.videoId, id))
          .run();
      }
      throw Object.assign(new Error(message), { statusCode: 500 });
    }

    this.db.transaction((tx) => {
      tx.insert(cleanupLogs)
        .values({
          id: ulid(),
          videoId: id,
          videoRef: id,
          reason,
          freedBytes,
          detail: JSON.stringify({ title: video.title, workId: video.workId, status: video.status }),
          createdAt: timestamp,
        })
        .run();
      tx.delete(videos).where(eq(videos.id, id)).run();
    });
    this.storage.invalidate();
    this.bus.publish("video.deleted", { videoId: id, reason, freedBytes });
    this.logger.info({ videoId: id, reason, freedBytes }, "视频已删除");
    return { deleted: true, freedBytes };
  }

  /**
   * Finish deletions interrupted between marking DELETING and the final DB
   * transaction. Called at startup; safe to repeat because the work is driven
   * by rows that still exist in the DELETING state.
   */
  recoverIncompleteDeletions(): number {
    const rows = this.db.select().from(videos).where(eq(videos.status, "deleting")).all();
    let recovered = 0;
    for (const video of rows) {
      let freedBytes = 0;
      try {
        if (video.filePath) {
          const path = resolveWithin(this.paths.videosDir, video.filePath);
          if (existsSync(path)) {
            freedBytes += statSync(path).size;
            unlinkSync(path);
          }
        }
        if (video.coverPath) {
          const cover = resolveWithin(this.paths.coversDir, video.coverPath);
          if (existsSync(cover)) {
            freedBytes += statSync(cover).size;
            unlinkSync(cover);
          }
        }
      } catch (error) {
        this.logger.warn(
          { videoId: video.id, error: safeErrorMessage(error) },
          "恢复未完成删除时无法移除媒体文件，保留 DELETING 状态等待下次重试",
        );
        continue;
      }
      const timestamp = now();
      this.db.transaction((tx) => {
        tx.insert(cleanupLogs)
          .values({
            id: ulid(),
            videoId: video.id,
            videoRef: video.id,
            reason: "manual",
            freedBytes,
            detail: JSON.stringify({ title: video.title, recovered: true }),
            createdAt: timestamp,
          })
          .run();
        tx.delete(videos).where(eq(videos.id, video.id)).run();
      });
      recovered += 1;
      this.bus.publish("video.deleted", { videoId: video.id, reason: "manual_recovery", freedBytes });
    }
    if (recovered > 0) {
      this.storage.invalidate();
      this.logger.info({ recovered }, "已恢复中断的删除操作");
    }
    return recovered;
  }

  deleteMany(ids: string[], reason = "manual"): { deleted: number; failed: number; freedBytes: number } {
    let deleted = 0;
    let failed = 0;
    let freedBytes = 0;
    for (const id of ids) {
      try {
        const result = this.delete(id, reason);
        if (result.deleted) deleted += 1;
        freedBytes += result.freedBytes;
      } catch (error) {
        failed += 1;
        this.logger.warn({ videoId: id, error: safeErrorMessage(error) }, "批量删除中单项失败");
      }
    }
    return { deleted, failed, freedBytes };
  }

  /** Reassign shares and remove a duplicate chat-video row after SHA-256 matching. */
  mergeDuplicate(videoId: string, existingVideoId: string): boolean {
    if (videoId === existingVideoId) return false;
    const duplicate = this.db.select().from(videos).where(eq(videos.id, videoId)).get();
    if (!duplicate) return false;
    this.db.transaction((tx) => {
      const shares = tx.select().from(videoShares).where(eq(videoShares.videoId, videoId)).all();
      for (const share of shares) {
        const conflict = tx
          .select()
          .from(videoShares)
          .where(eq(videoShares.messageId, share.messageId))
          .get();
        if (conflict) {
          tx.delete(videoShares).where(eq(videoShares.id, share.id)).run();
        } else {
          tx.update(videoShares).set({ videoId: existingVideoId }).where(eq(videoShares.id, share.id)).run();
        }
      }
      tx.delete(videos).where(eq(videos.id, videoId)).run();
    });
    try {
      if (duplicate.filePath) {
        const path = resolveWithin(this.paths.videosDir, duplicate.filePath);
        if (existsSync(path)) unlinkSync(path);
      }
    } catch {
      // The duplicate row is gone; orphan scan will remove the extra file.
    }
    this.logger.info({ videoId, existingVideoId }, "SHA-256 命中去重，已合并分享来源");
    return true;
  }
}
