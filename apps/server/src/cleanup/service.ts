import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { ulid } from "ulid";
import {
  isTempFileStale,
  planCleanup,
  type CleanupCandidate,
} from "@vault/core";
import { cleanupLogs, type schema } from "@vault/db";
import { now, resolveWithin, safeErrorMessage } from "@vault/shared";
import type { Paths } from "../config.js";
import type { DownloadWorker } from "../downloads/worker.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { MediaLibraryService } from "../media/library-service.js";
import type { SettingsService } from "../settings/service.js";
import type { StorageService } from "../storage/storage-service.js";

export interface CleanupResult {
  trigger: string;
  deletedVideos: number;
  failedRecordsDeleted: number;
  staleTempDeleted: number;
  orphanFilesDeleted: number;
  freedBytes: number;
  missingFiles: number;
  needsPause: boolean;
  usedBytes: number;
  projectedBytes: number;
  errors: string[];
  startedAt: number;
  finishedAt: number;
}

interface CandidateRow {
  id: string;
  file_path: string | null;
  is_favorite: number;
  file_size: number | null;
  downloaded_at: number | null;
  created_at: number;
  is_watched: number | null;
  watched_at: number | null;
}

export class CleanupService {
  private running = false;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly sqlite: BetterSqlite3.Database,
    private readonly paths: Paths,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly library: MediaLibraryService,
    private readonly worker: DownloadWorker,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(trigger: "manual" | "scheduled" | "startup"): Promise<CleanupResult> {
    if (this.running) {
      throw Object.assign(new Error("清理任务正在运行"), { statusCode: 409 });
    }
    this.running = true;
    const startedAt = now();
    const settings = this.settings.get();
    const errors: string[] = [];
    let deletedVideos = 0;
    let failedRecordsDeleted = 0;
    let staleTempDeleted = 0;
    let orphanFilesDeleted = 0;
    let freedBytes = 0;
    let missingFiles = 0;

    try {
      missingFiles = this.repairMissingFiles();
      const temp = this.cleanTemp(settings.retention.tempHours);
      staleTempDeleted = temp.count;
      freedBytes += temp.bytes;

      const failedCutoff = startedAt - settings.retention.failedDays * 86_400_000;
      const failedRows = this.sqlite
        .prepare("SELECT id FROM videos WHERE status='failed' AND updated_at < ?")
        .all(failedCutoff) as Array<{ id: string }>;
      for (const row of failedRows) {
        try {
          const result = this.library.delete(row.id, "failed_record_expired");
          if (result.deleted) failedRecordsDeleted += 1;
          freedBytes += result.freedBytes;
        } catch (error) {
          errors.push(`清理失败记录 ${row.id}: ${safeErrorMessage(error)}`);
        }
      }

      const candidates = this.collectCandidates();
      const usedBytes = this.storage.get().totalBytes;
      const capacityBytes = settings.storage.capacityGb * 1024 ** 3;
      const plan = planCleanup({
        candidates,
        retention: settings.retention,
        capacityBytes,
        usedBytes,
        nowMs: startedAt,
      });
      for (const decision of plan.deletions) {
        try {
          const result = this.library.delete(decision.videoId, decision.reason);
          if (result.deleted) {
            deletedVideos += 1;
            freedBytes += result.freedBytes;
          }
        } catch (error) {
          errors.push(`清理视频 ${decision.videoId}: ${safeErrorMessage(error)}`);
        }
      }

      const orphan = this.cleanOrphans();
      orphanFilesDeleted = orphan.count;
      freedBytes += orphan.bytes;

      this.storage.invalidate();
      const storage = this.storage.get();
      const projectedBytes = Math.max(0, storage.totalBytes);
      const overCapacity = projectedBytes > capacityBytes;
      if (overCapacity) {
        this.worker.pause("storage_capacity");
      } else {
        this.worker.resume("storage_capacity");
      }
      const reserve = settings.storage.safetyReserveGb * 1024 ** 3;
      if (storage.freeBytes > 0 && storage.freeBytes < reserve) {
        this.worker.pause("disk_space");
      } else {
        this.worker.resume("disk_space");
      }

      // Keep operational logs bounded on a long-running single-host install.
      const syncRunsPruned = this.sqlite
        .prepare("DELETE FROM sync_runs WHERE started_at < ?")
        .run(startedAt - 90 * 86_400_000).changes;
      const cleanupLogsPruned = this.sqlite
        .prepare("DELETE FROM cleanup_logs WHERE created_at < ?")
        .run(startedAt - 365 * 86_400_000).changes;
      const sessionsPruned = this.sqlite
        .prepare("DELETE FROM admin_sessions WHERE expires_at < ?")
        .run(startedAt).changes;

      const finishedAt = now();
      this.settings.setInternal("cleanup.last_run_at", String(finishedAt));
      this.settings.setInternal("cleanup.last_run_date", localDateKey(new Date(finishedAt)));
      this.db
        .insert(cleanupLogs)
        .values({
          id: ulid(),
          videoId: null,
          videoRef: null,
          reason: "run_summary",
          freedBytes,
          detail: JSON.stringify({
            trigger,
            deletedVideos,
            failedRecordsDeleted,
            staleTempDeleted,
            orphanFilesDeleted,
            missingFiles,
            needsPause: overCapacity,
            syncRunsPruned,
            cleanupLogsPruned,
            sessionsPruned,
            errors,
          }),
          createdAt: finishedAt,
        })
        .run();
      this.storage.invalidate();
      const result: CleanupResult = {
        trigger,
        deletedVideos,
        failedRecordsDeleted,
        staleTempDeleted,
        orphanFilesDeleted,
        freedBytes,
        missingFiles,
        needsPause: overCapacity,
        usedBytes,
        projectedBytes,
        errors,
        startedAt,
        finishedAt,
      };
      this.bus.publish("cleanup.completed", { ...result });
      this.logger.info(
        { trigger, deletedVideos, freedBytes, orphanFilesDeleted, staleTempDeleted, missingFiles },
        "自动清理完成",
      );
      return result;
    } finally {
      this.running = false;
    }
  }

  private collectCandidates(): CleanupCandidate[] {
    const rows = this.sqlite
      .prepare(
        `SELECT v.id, v.file_path, v.is_favorite, v.file_size, v.downloaded_at, v.created_at,
                p.is_watched, p.watched_at
           FROM videos v LEFT JOIN video_progress p ON p.video_id=v.id
          WHERE v.status='ready'
          ORDER BY COALESCE(v.downloaded_at, v.created_at) ASC`,
      )
      .all() as CandidateRow[];
    return rows.map((row) => {
      let mtime: number | null = null;
      try {
        if (row.file_path) {
          const absolute = resolveWithin(this.paths.videosDir, row.file_path);
          if (existsSync(absolute)) mtime = statSync(absolute).mtimeMs;
        }
      } catch {
        mtime = null;
      }
      return {
        videoId: row.id,
        isFavorite: Boolean(row.is_favorite),
        isWatched: Boolean(row.is_watched),
        watchedAt: row.watched_at,
        downloadedAt: row.downloaded_at,
        fileSize: row.file_size ?? 0,
        fileMtime: mtime,
      };
    });
  }

  private repairMissingFiles(): number {
    const rows = this.sqlite
      .prepare("SELECT id, file_path FROM videos WHERE status='ready' AND file_path IS NOT NULL")
      .all() as Array<{ id: string; file_path: string }>;
    let missing = 0;
    const timestamp = now();
    for (const row of rows) {
      let present = false;
      try {
        present = existsSync(resolveWithin(this.paths.videosDir, row.file_path));
      } catch {
        present = false;
      }
      if (present) continue;
      missing += 1;
      this.sqlite
        .prepare(
          `UPDATE videos SET status='failed', last_error_code='FILE_MISSING',
              last_error_message='媒体文件缺失，可能被外部移动或删除', updated_at=? WHERE id=?`,
        )
        .run(timestamp, row.id);
      this.sqlite
        .prepare(
          `UPDATE download_jobs SET status='FAILED', error_code='FILE_MISSING',
              error_message='媒体文件缺失', finished_at=?, updated_at=? WHERE video_id=?`,
        )
        .run(timestamp, timestamp, row.id);
    }
    if (missing > 0) {
      this.logger.warn({ missing }, "一致性检查发现媒体文件缺失");
    }
    return missing;
  }

  private cleanTemp(tempHours: number): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    const active = new Set(
      (
        this.sqlite
          .prepare(
            "SELECT id FROM download_jobs WHERE status IN ('RESOLVING','DOWNLOADING','VERIFYING')",
          )
          .all() as Array<{ id: string }>
      ).map((row) => `job-${row.id}.part`),
    );
    const timestamp = now();
    let entries: string[] = [];
    try {
      entries = readdirSync(this.paths.tempDir);
    } catch {
      return { count, bytes };
    }
    for (const name of entries) {
      if (active.has(name)) continue;
      const path = resolve(this.paths.tempDir, name);
      try {
        const stats = statSync(path);
        if (!stats.isFile()) continue;
        if (!isTempFileStale(stats.mtimeMs, timestamp, tempHours)) continue;
        unlinkSync(path);
        count += 1;
        bytes += stats.size;
      } catch {
        // File disappeared.
      }
    }
    return { count, bytes };
  }

  private cleanOrphans(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    const timestamp = now();
    const protectedAgeMs = 60 * 60_000;
    const referencedVideos = new Set(
      (
        this.sqlite
          .prepare("SELECT file_path FROM videos WHERE file_path IS NOT NULL")
          .all() as Array<{ file_path: string }>
      ).map((row) => row.file_path.replaceAll(sep, "/")),
    );
    const referencedCovers = new Set(
      (
        this.sqlite
          .prepare("SELECT cover_path FROM videos WHERE cover_path IS NOT NULL")
          .all() as Array<{ cover_path: string }>
      ).map((row) => row.cover_path.replaceAll(sep, "/")),
    );
    const scan = (root: string, referenced: Set<string>) => {
      const walk = (directory: string) => {
        let entries;
        try {
          entries = readdirSync(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) {
            walk(path);
            continue;
          }
          if (!entry.isFile()) continue;
          const relative = path.slice(root.length + 1).replaceAll(sep, "/");
          if (referenced.has(relative)) continue;
          try {
            const stats = statSync(path);
            if (timestamp - stats.mtimeMs < protectedAgeMs) continue;
            unlinkSync(path);
            count += 1;
            bytes += stats.size;
          } catch {
            // Ignore files removed during scan.
          }
        }
      };
      walk(root);
    };
    scan(this.paths.videosDir, referencedVideos);
    scan(this.paths.coversDir, referencedCovers);
    if (count > 0) {
      this.db
        .insert(cleanupLogs)
        .values({
          id: ulid(),
          videoId: null,
          videoRef: null,
          reason: "orphan_file",
          freedBytes: bytes,
          detail: JSON.stringify({ count }),
          createdAt: timestamp,
        })
        .run();
    }
    return { count, bytes };
  }

  lastRunAt(): number | null {
    const raw = this.settings.getInternal("cleanup.last_run_at");
    return raw ? Number(raw) : null;
  }
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
