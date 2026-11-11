import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { now } from "@vault/shared";
import type { Paths } from "../config.js";
import type { Logger } from "../logger.js";
import type { SettingsService } from "../settings/service.js";

export class BackupService {
  private running = false;

  constructor(
    private readonly sqlite: BetterSqlite3.Database,
    private readonly paths: Paths,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<{ path: string; bytes: number }> {
    if (this.running) throw Object.assign(new Error("备份正在进行"), { statusCode: 409 });
    this.running = true;
    const timestamp = now();
    mkdirSync(this.paths.backupsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(timestamp)
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "-")
      .slice(0, 19);
    const target = resolve(this.paths.backupsDir, `vault-${stamp}.sqlite`);
    try {
      await this.sqlite.backup(target);
      chmodSync(target, 0o600);
      this.settings.setInternal("backup.last_run_at", String(timestamp));
      this.prune(7);
      const bytes = statSync(target).size;
      this.logger.info({ path: target, bytes }, "数据库备份完成");
      return { path: target, bytes };
    } finally {
      this.running = false;
    }
  }

  private prune(keep: number): void {
    try {
      const files = readdirSync(this.paths.backupsDir)
        .filter((name) => /^vault-.*\.sqlite$/.test(name))
        .map((name) => ({
          name,
          path: resolve(this.paths.backupsDir, name),
          mtime: statSync(resolve(this.paths.backupsDir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const file of files.slice(keep)) {
        unlinkSync(file.path);
        this.logger.info({ path: file.path }, "清理旧数据库备份");
      }
    } catch {
      // Backup retention must not fail the backup itself.
    }
  }

  lastRunAt(): number | null {
    const raw = this.settings.getInternal("backup.last_run_at");
    return raw ? Number(raw) : null;
  }
}
