import { localDateKey } from "./cleanup/service.js";
import type { AuthService } from "./auth/auth-service.js";
import type { BackupService } from "./backup/service.js";
import type { CleanupService } from "./cleanup/service.js";
import type { EventBus } from "./events.js";
import type { GroupSyncService } from "./groups/sync-service.js";
import type { HealthService } from "./health/service.js";
import type { Logger } from "./logger.js";
import type { SettingsService } from "./settings/service.js";
import { safeErrorMessage } from "@vault/shared";

const TICK_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private lastHealthFingerprint = "";
  private lastGroupSyncAt = 0;
  private lastCleanupCheck = "";
  private lastBackupCheck = "";
  private groupSyncRunning = false;
  private started = false;

  constructor(
    private readonly auth: AuthService,
    private readonly groupSync: GroupSyncService,
    private readonly cleanup: CleanupService,
    private readonly backup: BackupService,
    private readonly health: HealthService,
    private readonly settings: SettingsService,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.healthTimer = setInterval(() => this.publishHealthIfChanged(), 60_000);
    this.healthTimer.unref?.();
    setTimeout(() => void this.auth.refresh(), 3000).unref?.();
    setTimeout(() => this.publishHealthIfChanged(), 5000).unref?.();
    setTimeout(() => {
      const settings = this.settings.get();
      if (settings.cleanup.enabled) {
        void this.cleanup
          .run("startup")
          .catch((error) => this.logger.warn({ error: safeErrorMessage(error) }, "启动清理跳过"));
      }
    }, 15_000).unref?.();
    this.logger.info("后台调度器已启动");
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
  }

  private async tick(): Promise<void> {
    try {
      await this.auth.refresh();
      const settings = this.settings.get();
      const nowMs = Date.now();
      const today = localDateKey(new Date(nowMs));

      if (
        settings.cleanup.enabled &&
        new Date(nowMs).getHours() >= settings.cleanup.runHourLocal &&
        this.settings.getInternal("cleanup.last_run_date") !== today &&
        this.lastCleanupCheck !== today
      ) {
        this.lastCleanupCheck = today;
        void this.cleanup
          .run("scheduled")
          .catch((error) => {
            this.lastCleanupCheck = "";
            this.logger.error({ error: safeErrorMessage(error) }, "定时清理失败");
          });
      }

      const lastBackup = this.backup.lastRunAt();
      const backupHour = 4;
      if (
        new Date(nowMs).getHours() >= backupHour &&
        (lastBackup == null || nowMs - lastBackup > 26 * 3_600_000) &&
        this.lastBackupCheck !== today
      ) {
        this.lastBackupCheck = today;
        void this.backup
          .run()
          .catch((error) => {
            this.lastBackupCheck = "";
            this.logger.error({ error: safeErrorMessage(error) }, "定时备份失败");
          });
      }

      const authStatus = this.auth.getStatus(false);
      if (
        authStatus.status === "CONNECTED" &&
        !this.groupSyncRunning &&
        nowMs - this.lastGroupSyncAt >= 10 * 60_000
      ) {
        this.groupSyncRunning = true;
        this.lastGroupSyncAt = nowMs;
        void this.groupSync
          .syncAllEnabled("auto", 2)
          .catch((error) => this.logger.warn({ error: safeErrorMessage(error) }, "低频历史核对失败"))
          .finally(() => {
            this.groupSyncRunning = false;
          });
      }
      this.publishHealthIfChanged();
    } catch (error) {
      this.logger.error({ error: safeErrorMessage(error) }, "后台调度失败");
    }
  }

  private publishHealthIfChanged(): void {
    try {
      const snapshot = this.health.snapshot();
      const next = this.health.fingerprint();
      if (next !== this.lastHealthFingerprint) {
        this.lastHealthFingerprint = next;
        this.bus.publish("system.status_changed", {
          status: snapshot.status,
          issues: snapshot.issues,
        });
      }
    } catch (error) {
      this.logger.warn({ error: safeErrorMessage(error) }, "健康检查失败");
    }
  }
}
