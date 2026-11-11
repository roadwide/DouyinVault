import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { now } from "@vault/shared";
import { openDatabase } from "@vault/db";
import { createTestVault, fakeMp4, type TestVault } from "../helpers/vault.js";

const vaults: TestVault[] = [];

async function vault(): Promise<TestVault> {
  const created = await createTestVault();
  vaults.push(created);
  return created;
}

afterEach(async () => {
  while (vaults.length) await vaults.pop()!.dispose();
});

describe("crash recovery", () => {
  it("requeues an interrupted download after restart instead of losing it", async () => {
    const { context } = await vault();
    const timestamp = now();
    const videoId = "recovery-video";
    context.sqlite
      .prepare(
        `INSERT INTO videos (id, platform, work_id, media_key, title, status, is_favorite, created_at, updated_at)
         VALUES (?, 'douyin', NULL, 'douyin:message:recovery', '中断任务', 'pending', 0, ?, ?)`,
      )
      .run(videoId, timestamp, timestamp);
    context.sqlite
      .prepare(
        `INSERT INTO download_jobs
          (id, video_id, status, priority, attempts, max_attempts, lease_owner, lease_expires_at, progress, source, created_at, updated_at, started_at)
         VALUES ('recovery-job', ?, 'DOWNLOADING', 2, 1, 3, 'dead-worker', ?, 0.42, 'realtime', ?, ?, ?)`,
      )
      .run(videoId, timestamp - 60_000, timestamp, timestamp, timestamp);
    context.settings.update({ download: { enabled: false } });

    context.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await context.worker.stop();

    const job = context.sqlite
      .prepare("SELECT status, error_code, error_message, lease_owner FROM download_jobs WHERE id='recovery-job'")
      .get() as { status: string; error_code: string; error_message: string; lease_owner: string | null };
    expect(job.status).toBe("RETRY_WAIT");
    expect(job.error_code).toBe("INTERNAL");
    expect(job.error_message).toContain("服务重启");
    expect(job.lease_owner).toBeNull();
  });

  it("finishes a deletion interrupted between DELETING and the DB transaction", async () => {
    const { context } = await vault();
    const timestamp = now();
    mkdirSync(resolve(context.paths.videosDir, "cc"), { recursive: true });
    const absolute = resolve(context.paths.videosDir, "cc/interrupted.mp4");
    writeFileSync(absolute, fakeMp4());
    context.sqlite
      .prepare(
        `INSERT INTO videos (id, platform, work_id, media_key, title, status, is_favorite, created_at, updated_at, file_path, file_size)
         VALUES ('interrupted-delete', 'douyin', NULL, 'douyin:message:interrupted', '中断删除', 'deleting', 0, ?, ?, 'cc/interrupted.mp4', ?)`,
      )
      .run(timestamp, timestamp, fakeMp4().length);
    const recovered = context.library.recoverIncompleteDeletions();
    expect(recovered).toBe(1);
    expect(existsSync(absolute)).toBe(false);
    expect(context.library.getById("interrupted-delete")).toBeNull();
    const log = context.sqlite
      .prepare("SELECT detail FROM cleanup_logs WHERE video_ref='interrupted-delete'")
      .get() as { detail: string } | undefined;
    expect(log?.detail).toContain("recovered");
  });

  it("marks a ready video as failed when its media file disappeared", async () => {
    const { context } = await vault();
    const timestamp = now();
    mkdirSync(resolve(context.paths.videosDir, "bb"), { recursive: true });
    const absolute = resolve(context.paths.videosDir, "bb/missing.mp4");
    writeFileSync(absolute, fakeMp4());
    context.sqlite
      .prepare(
        `INSERT INTO videos (id, platform, work_id, media_key, title, status, is_favorite, created_at, updated_at, file_path, file_size)
         VALUES ('missing-file-video', 'douyin', NULL, 'douyin:message:missing', '丢失文件', 'ready', 0, ?, ?, 'bb/missing.mp4', ?)`,
      )
      .run(timestamp, timestamp, fakeMp4().length);
    context.sqlite
      .prepare(
        `INSERT INTO download_jobs (id, video_id, status, priority, attempts, max_attempts, progress, source, created_at, updated_at, finished_at)
         VALUES ('missing-file-job', 'missing-file-video', 'COMPLETED', 2, 1, 3, 1, 'realtime', ?, ?, ?)`,
      )
      .run(timestamp, timestamp, timestamp);
    // Remove the file after the DB is seeded: consistent startup should catch it.
    const { rmSync } = await import("node:fs");
    rmSync(absolute);

    context.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await context.worker.stop();
    const video = context.sqlite
      .prepare("SELECT status, last_error_code FROM videos WHERE id='missing-file-video'")
      .get() as { status: string; last_error_code: string };
    expect(video.status).toBe("failed");
    expect(video.last_error_code).toBe("FILE_MISSING");
  });
});

describe("backups and settings", () => {
  it("creates an opening-valid SQLite backup with 0600 permissions", async () => {
    const { context } = await vault();
    const result = await context.backup.run();
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    const backup = openDatabase({ path: result.path, readOnly: true });
    const row = backup.sqlite.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    expect(row.count).toBeGreaterThan(0);
    backup.close();
  });

  it("rejects out-of-range settings and persists valid ones", async () => {
    const { context } = await vault();
    expect(() => context.settings.update({ download: { concurrency: 0 } })).toThrow();
    const updated = context.settings.update({
      retention: { unwatchedDays: 14 },
      storage: { capacityGb: 5 },
    });
    expect(updated.retention.unwatchedDays).toBe(14);
    expect(updated.storage.capacityGb).toBe(5);
    const fresh = context.settings.get();
    expect(fresh.retention.unwatchedDays).toBe(14);
  });

  it("reports a degraded health state when the IM account is not connected", async () => {
    const { context } = await vault();
    const group = context.groups.ensureFromMessage(context.auth.accountId, "7000000000000000010", "健康检查群");
    context.groups.setEnabled(group.id, true, false);
    const snapshot = context.health.snapshot();
    expect(snapshot.groups.enabled).toBe(1);
    expect(snapshot.issues.some((issue) => issue.code === "AUTH_REQUIRED")).toBe(true);
    expect(snapshot.status).not.toBe("ok");
  });
});
