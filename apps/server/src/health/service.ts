import { spawnSync } from "node:child_process";
import type BetterSqlite3 from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { accounts, groups, type schema } from "@vault/db";
import { gbToBytes, type AccountStatus } from "@vault/core";
import { APP_VERSION, now, safeErrorMessage } from "@vault/shared";
import type { AuthService } from "../auth/auth-service.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SettingsService } from "../settings/service.js";
import type { StorageService } from "../storage/storage-service.js";
import type { DownloadWorker } from "../downloads/worker.js";

export interface HealthIssue {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface SystemSnapshot {
  generatedAt: number;
  version: string;
  uptimeSeconds: number;
  status: "ok" | "degraded" | "error";
  database: { ok: boolean; schemaReady: boolean };
  auth: {
    status: AccountStatus;
    adapter: string;
    connected: boolean;
    displayName: string | null;
    platformUid: string | null;
    lastConnectedAt: number | null;
    lastMessageAt: number | null;
    lastSuccessfulSyncAt: number | null;
    lastError: string | null;
  };
  groups: { total: number; enabled: number; healthy: number; errors: number };
  videos: {
    total: number;
    ready: number;
    pending: number;
    failed: number;
    unwatched: number;
    favorites: number;
  };
  downloads: {
    pending: number;
    active: number;
    retryWaiting: number;
    failed: number;
    completed: number;
    pausedReason: string | null;
    activeCount: number;
    concurrency: number;
  };
  storage: {
    usedBytes: number;
    capacityBytes: number;
    freeBytes: number;
    safetyReserveBytes: number;
    percent: number;
    overCapacity: boolean;
    diskLow: boolean;
  };
  recent24h: { detected: number; completed: number; failed: number };
  cleanup: { enabled: boolean; lastRunAt: number | null; nextRunAt: number | null };
  unresolvedMessages: number;
  issues: HealthIssue[];
  worker: { running: boolean; lastTickAt: number | null };
}

export class HealthService {
  private startedAt = Date.now();
  private lastFfprobeCheck: { ok: boolean; checkedAt: number } | null = null;

  constructor(
    private readonly sqlite: BetterSqlite3.Database,
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly worker: DownloadWorker,
    private readonly logger: Logger,
  ) {}

  private checkFfprobe(): boolean {
    if (this.lastFfprobeCheck && Date.now() - this.lastFfprobeCheck.checkedAt < 5 * 60_000) {
      return this.lastFfprobeCheck.ok;
    }
    let ok = false;
    try {
      const result = spawnSync(this.config.ffprobePath, ["-version"], { timeout: 3000 });
      ok = result.status === 0;
    } catch {
      ok = false;
    }
    this.lastFfprobeCheck = { ok, checkedAt: Date.now() };
    return ok;
  }

  private count(table: string, where = "1=1", params: unknown[] = []): number {
    try {
      const row = this.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
        .get(...params) as { count: number };
      return Number(row.count);
    } catch {
      return 0;
    }
  }

  private scalar(sql: string, params: unknown[] = []): number | null {
    try {
      const row = this.sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      if (!row) return null;
      const value = Object.values(row)[0];
      return value == null ? null : Number(value);
    } catch {
      return null;
    }
  }

  snapshot(): SystemSnapshot {
    const settings = this.settings.get();
    const authStatus = this.auth.getStatus(false);
    const row = this.db.select().from(accounts).limit(1).get();
    const timestamp = now();
    const since = timestamp - 86_400_000;
    const storage = this.storage.get();
    const capacityBytes = gbToBytes(settings.storage.capacityGb);
    const safetyReserveBytes = gbToBytes(settings.storage.safetyReserveGb);
    let dbOk = true;
    let schemaReady = true;
    try {
      this.sqlite.prepare("SELECT 1").get();
      const migration = this.sqlite
        .prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1")
        .get() as { id: string } | undefined;
      schemaReady = Boolean(migration);
    } catch {
      dbOk = false;
      schemaReady = false;
    }

    const groupRows = this.db.select().from(groups).all();
    const enabledGroups = groupRows.filter((group) => group.enabled);
    const groupErrors = groupRows.filter(
      (group) => group.status === "error" || group.status === "verify_required",
    ).length;
    const groupHealthy = enabledGroups.filter((group) => group.status === "active").length;
    const queue = this.sqlite
      .prepare("SELECT status, COUNT(*) AS count FROM download_jobs GROUP BY status")
      .all() as Array<{ status: string; count: number }>;
    const queueMap = new Map(queue.map((item) => [item.status, Number(item.count)]));
    const videoCounts = this.sqlite
      .prepare("SELECT status, COUNT(*) AS count FROM videos GROUP BY status")
      .all() as Array<{ status: string; count: number }>;
    const videoMap = new Map(videoCounts.map((item) => [item.status, Number(item.count)]));
    const unwatched = this.scalar(
      `SELECT COUNT(*) FROM videos v LEFT JOIN video_progress p ON p.video_id=v.id
        WHERE v.status='ready' AND COALESCE(p.is_watched,0)=0`,
    ) ?? 0;
    const favorites = this.count("videos", "is_favorite=1 AND status IN ('ready','pending','failed')");
    const lastRunRaw = this.settings.getInternal("cleanup.last_run_at");
    const lastRunAt = lastRunRaw ? Number(lastRunRaw) : null;
    const lastBackupRaw = this.settings.getInternal("backup.last_run_at");
    const lastBackupAt = lastBackupRaw ? Number(lastBackupRaw) : null;
    const nextRunAt = this.nextCleanupAt(settings.cleanup.runHourLocal);
    const lastSuccessfulSyncAt =
      this.scalar("SELECT MAX(last_successful_sync_at) FROM groups") ?? null;
    const unresolvedMessages = this.count("messages", "status='unresolved'");
    const recentDetected = this.count(
      "messages",
      "created_at >= ? AND type IN ('shared_work','chat_video','text_with_url')",
      [since],
    );
    const recentCompleted = this.count("videos", "downloaded_at >= ?", [since]);
    const recentFailed = this.count(
      "download_jobs",
      "status='FAILED' AND finished_at >= ?",
      [since],
    );

    const issues: HealthIssue[] = [];
    if (!dbOk) issues.push({ level: "error", code: "DB_UNAVAILABLE", message: "SQLite 数据库不可用" });
    if (!this.checkFfprobe()) {
      issues.push({
        level: "warning",
        code: "FFPROBE_MISSING",
        message: `找不到 ffprobe（${this.config.ffprobePath}）。完整性与时长校验无法运行。`,
      });
    }
    if (enabledGroups.length > 0 && !authStatus.lastError && authStatus.status !== "CONNECTED") {
      issues.push({
        level: "warning",
        code: "IM_NOT_CONNECTED",
        message: `抖音账号当前状态为 ${authStatus.status}，监听已暂停。`,
      });
    }
    if (authStatus.status === "VERIFY_REQUIRED" || authStatus.status === "LOGIN_REQUIRED") {
      issues.push({
        level: "warning",
        code: "AUTH_REQUIRED",
        message: "需要重新登录抖音账号后才能继续自动缓存。",
      });
    }
    const failedDownloads = queueMap.get("FAILED") ?? 0;
    if (failedDownloads > 0) {
      issues.push({
        level: "warning",
        code: "DOWNLOAD_FAILURES",
        message: `${failedDownloads} 个视频最终缓存失败，媒体并未保存到本地。`,
      });
    }
    if (groupErrors > 0) {
      issues.push({
        level: "warning",
        code: "GROUP_SYNC_ERROR",
        message: `${groupErrors} 个群聊同步异常，请查看群聊页面。`,
      });
    }
    if (this.worker.state.pausedReasons.includes("disk_space") || storage.freeBytes < safetyReserveBytes) {
      issues.push({
        level: "warning",
        code: "DISK_SPACE",
        message: "磁盘剩余空间低于安全线，下载已暂停。",
      });
    }
    if (storage.totalBytes > capacityBytes) {
      issues.push({
        level: "warning",
        code: "CAPACITY_EXCEEDED",
        message: "缓存占用超过容量上限，新增下载已暂停，等待清理或手动扩容。",
      });
    }
    if (lastBackupAt == null) {
      issues.push({
        level: "info",
        code: "NO_BACKUP_YET",
        message: "尚未完成数据库备份，首次每日备份会在计划时间运行。",
      });
    } else if (timestamp - lastBackupAt > 48 * 3_600_000) {
      issues.push({
        level: "warning",
        code: "BACKUP_STALE",
        message: "最近一次数据库备份已超过 48 小时，请检查备份计划。",
      });
    }
    if (unresolvedMessages > 0) {
      issues.push({
        level: "info",
        code: "UNRESOLVED_MESSAGES",
        message: `${unresolvedMessages} 条视频卡片无法解析，已保留诊断记录。`,
      });
    }
    if (this.worker.state.pausedReasons.includes("rate_limited")) {
      issues.push({
        level: "warning",
        code: "RATE_LIMITED",
        message: "下载队列因平台限流暂停，将在冷却后自动恢复。",
      });
    }
    if (this.worker.state.pausedReasons.includes("downloads_disabled")) {
      issues.push({
        level: "info",
        code: "DOWNLOADS_DISABLED",
        message: "自动下载已在设置中关闭。",
      });
    }
    if (enabledGroups.length === 0) {
      issues.push({
        level: "info",
        code: "NO_GROUPS_ENABLED",
        message: "尚未启用任何群聊监听。",
      });
    }
    const hasError = issues.some((issue) => issue.level === "error");
    const hasWarning = issues.some((issue) => issue.level === "warning");
    const status = hasError ? "error" : hasWarning ? "degraded" : "ok";
    const pausedReason = this.worker.pausedReason();

    return {
      generatedAt: timestamp,
      version: APP_VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      status,
      database: { ok: dbOk, schemaReady },
      auth: {
        status: (row?.status as AccountStatus) ?? authStatus.status,
        adapter: this.config.imAdapter,
        connected: row?.status === "CONNECTED",
        displayName: row?.displayName ?? authStatus.displayName,
        platformUid: row?.platformUid ?? null,
        lastConnectedAt: row?.lastConnectedAt ?? null,
        lastMessageAt: row?.lastMessageAt ?? null,
        lastSuccessfulSyncAt: row?.lastSuccessfulSyncAt ?? lastSuccessfulSyncAt,
        lastError: row?.lastError ?? null,
      },
      groups: {
        total: groupRows.length,
        enabled: enabledGroups.length,
        healthy: groupHealthy,
        errors: groupErrors,
      },
      videos: {
        total: [...videoMap.entries()].filter(([status]) => status !== "deleted").reduce((sum, [, count]) => sum + count, 0),
        ready: videoMap.get("ready") ?? 0,
        pending: videoMap.get("pending") ?? 0,
        failed: videoMap.get("failed") ?? 0,
        unwatched,
        favorites,
      },
      downloads: {
        pending: queueMap.get("PENDING") ?? 0,
        active:
          (queueMap.get("RESOLVING") ?? 0) +
          (queueMap.get("DOWNLOADING") ?? 0) +
          (queueMap.get("VERIFYING") ?? 0),
        retryWaiting: queueMap.get("RETRY_WAIT") ?? 0,
        failed: failedDownloads,
        completed: queueMap.get("COMPLETED") ?? 0,
        pausedReason,
        activeCount: this.worker.state.activeCount,
        concurrency: settings.download.concurrency,
      },
      storage: {
        usedBytes: storage.totalBytes,
        capacityBytes,
        freeBytes: storage.freeBytes,
        safetyReserveBytes,
        percent: capacityBytes > 0 ? Math.min(100, (storage.totalBytes / capacityBytes) * 100) : 0,
        overCapacity: storage.totalBytes > capacityBytes,
        diskLow: storage.freeBytes > 0 && storage.freeBytes < safetyReserveBytes,
      },
      recent24h: { detected: recentDetected, completed: recentCompleted, failed: recentFailed },
      cleanup: { enabled: settings.cleanup.enabled, lastRunAt, nextRunAt },
      unresolvedMessages,
      issues,
      worker: { running: this.worker.state.running, lastTickAt: this.worker.state.lastTickAt },
    };
  }

  fingerprint(): string {
    try {
      const snapshot = this.snapshot();
      return JSON.stringify({
        status: snapshot.status,
        auth: snapshot.auth.status,
        groups: snapshot.groups,
        videos: snapshot.videos,
        downloads: snapshot.downloads,
        storage: snapshot.storage.percent,
        issues: snapshot.issues.map((issue) => issue.code),
        paused: snapshot.downloads.pausedReason,
      });
    } catch (error) {
      return `error:${safeErrorMessage(error)}`;
    }
  }

  publicHealth(): { ok: boolean; version: string; uptimeSeconds: number } {
    let ok = false;
    try {
      this.sqlite.prepare("SELECT 1").get();
      ok = true;
    } catch {
      ok = false;
    }
    return {
      ok,
      version: APP_VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private nextCleanupAt(hour: number): number {
    const date = new Date();
    date.setMinutes(0, 0, 0);
    date.setHours(hour);
    if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
    return date.getTime();
  }

  markStartedAt(timestamp: number): void {
    this.startedAt = timestamp;
  }
}
