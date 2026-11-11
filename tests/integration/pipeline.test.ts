import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { videos } from "@vault/db";
import { now } from "@vault/shared";
import type { NormalizedMessage } from "@vault/core";
import { createTestVault, fakeMp4, type TestVault } from "../helpers/vault.js";
import { startTestMediaServer, type TestMediaServer } from "../helpers/media-server.js";

async function waitFor<T>(
  check: () => T | null | undefined | false,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

function message(
  input: Partial<NormalizedMessage> & Pick<NormalizedMessage, "groupId" | "messageId">,
): NormalizedMessage {
  return {
    accountId: input.accountId ?? "",
    groupName: "测试群",
    senderId: "sender-1",
    senderName: "测试群友",
    sentAt: now(),
    receivedAt: now(),
    type: "shared_work",
    source: "realtime",
    ...input,
  } as NormalizedMessage;
}

describe("message ingestion and download pipeline", () => {
  let vault: TestVault;
  let media: TestMediaServer;

  beforeEach(async () => {
    vault = await createTestVault();
    media = await startTestMediaServer(Buffer.concat([fakeMp4()]));
  });

  afterEach(async () => {
    await vault.dispose();
    await media.close();
  });

  it("downloads a shared work once, verifies it, and records a second share", async () => {
    const { context } = vault;
    const group = context.groups.ensureFromMessage(context.auth.accountId, "7000000000000000001", "测试群 A");
    context.groups.setEnabled(group.id, true, true);
    const groupB = context.groups.ensureFromMessage(context.auth.accountId, "7000000000000000002", "测试群 B");
    context.groups.setEnabled(groupB.id, true, true);

    const result = await context.ingest.ingest(
      message({
        accountId: context.auth.accountId,
        groupId: "7000000000000000001",
        messageId: "message-1",
        workId: "7412345678901234567",
        title: "流水线测试视频",
        mediaUrl: media.url,
        shareUrl: "https://www.douyin.com/video/7412345678901234567",
      }),
    );
    expect(result.outcome).toBe("resolved");
    expect(result.newVideo).toBe(true);
    expect(result.videoId).toBeTruthy();

    context.worker.start();
    const completed = await waitFor(() => {
      const row = context.sqlite
        .prepare("SELECT status, error_code, error_message FROM download_jobs WHERE video_id=?")
        .get(result.videoId) as
        | { status: string; error_code: string | null; error_message: string | null }
        | undefined;
      if (!row) return null;
      if (row.status === "FAILED") throw new Error(`Job failed: ${row.error_code} ${row.error_message}`);
      return row.status === "COMPLETED" ? row : null;
    });
    await context.worker.stop();
    expect(completed.status).toBe("COMPLETED");

    const detail = context.library.getById(result.videoId!);
    expect(detail?.status).toBe("ready");
    expect(detail?.fileSize).toBe(fakeMp4().length);
    expect(detail?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(detail?.shares).toHaveLength(1);
    expect(detail?.fileSize).toBeGreaterThan(1024);

    const stored = context.db.select().from(videos).where(eq(videos.id, result.videoId!)).get();
    expect(stored?.filePath).toBeTruthy();
    expect(existsSync(`${context.paths.videosDir}/${stored!.filePath}`)).toBe(true);

    const duplicate = await context.ingest.ingest(
      message({
        accountId: context.auth.accountId,
        groupId: "7000000000000000002",
        messageId: "message-2",
        workId: "7412345678901234567",
        title: "同一作品在另一个群被分享",
      }),
    );
    expect(duplicate.outcome).toBe("resolved");
    expect(duplicate.newVideo).toBe(false);
    expect(duplicate.videoId).toBe(result.videoId);

    const updated = context.library.getById(result.videoId!);
    expect(updated?.shares).toHaveLength(2);
    expect(updated?.shareCount).toBe(2);
    const total = context.sqlite.prepare("SELECT COUNT(*) AS count FROM videos").get() as { count: number };
    expect(total.count).toBe(1);

    const sameMessage = await context.ingest.ingest(
      message({
        accountId: context.auth.accountId,
        groupId: "7000000000000000002",
        messageId: "message-2",
        workId: "7412345678901234567",
      }),
    );
    expect(sameMessage.outcome).toBe("duplicate");
  });

  it("ignores disabled groups and non-video messages without storing text", async () => {
    const { context } = vault;
    const group = context.groups.ensureFromMessage(context.auth.accountId, "7000000000000000003", "未启用群");
    const ignored = await context.ingest.ingest(
      message({
        accountId: context.auth.accountId,
        groupId: group.platformGroupId,
        messageId: "disabled-1",
        workId: "7412345678901234999",
      }),
    );
    expect(ignored.outcome).toBe("ignored");

    context.groups.setEnabled(group.id, true, true);
    const text = await context.ingest.ingest(
      message({
        accountId: context.auth.accountId,
        groupId: group.platformGroupId,
        messageId: "text-1",
        type: "unknown",
        workId: undefined,
        title: "普通聊天文本不应保存",
      }),
    );
    expect(text.outcome).toBe("ignored");
    const count = context.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("keeps an unresolved work card as a diagnosable message", async () => {
    const { context } = vault;
    const group = context.groups.ensureFromMessage(context.auth.accountId, "7000000000000000004", "诊断群");
    context.groups.setEnabled(group.id, true, true);
    const result = await context.ingest.ingest(
      message({
        accountId: context.auth.accountId,
        groupId: group.platformGroupId,
        messageId: "unresolved-1",
        type: "unknown",
        workId: undefined,
        diagnostic: "Work card without a usable work id (UNRESOLVED).",
      }),
    );
    expect(result.outcome).toBe("unresolved");
    expect(result.videoId).toBeNull();
    const row = context.sqlite
      .prepare("SELECT status, diagnostic FROM messages WHERE platform_message_id='unresolved-1'")
      .get() as { status: string; diagnostic: string } | undefined;
    expect(row?.status).toBe("unresolved");
    expect(row?.diagnostic).toContain("UNRESOLVED");
    expect(context.ingest.unresolvedCount()).toBe(1);
  });

  it("deletes expired videos and records an audit entry", async () => {
    const { context } = vault;
    const group = context.groups.ensureFromMessage(context.auth.accountId, "7000000000000000005", "清理群");
    context.groups.setEnabled(group.id, true, true);
    const result = await context.ingest.ingest(
      message({
        accountId: context.auth.accountId,
        groupId: group.platformGroupId,
        messageId: "cleanup-1",
        workId: "7412345678901234601",
        mediaUrl: media.url,
      }),
    );
    context.worker.start();
    await waitFor(() => {
      const row = context.sqlite.prepare("SELECT status FROM download_jobs WHERE video_id=?").get(result.videoId) as
        | { status: string }
        | undefined;
      if (row?.status === "FAILED") throw new Error("download failed");
      return row?.status === "COMPLETED";
    });
    await context.worker.stop();
    const video = context.db.select().from(videos).where(eq(videos.id, result.videoId!)).get()!;
    const old = now() - 40 * 86_400_000;
    context.sqlite.prepare("UPDATE videos SET downloaded_at=?, created_at=? WHERE id=?").run(old, old, video.id);
    const storedPath = `${context.paths.videosDir}/${video.filePath}`;
    expect(existsSync(storedPath)).toBe(true);

    const cleanup = await context.cleanup.run("manual");
    expect(cleanup.deletedVideos).toBe(1);
    expect(cleanup.freedBytes).toBeGreaterThan(0);
    expect(existsSync(storedPath)).toBe(false);
    expect(context.library.getById(video.id)).toBeNull();
    const log = context.sqlite
      .prepare("SELECT reason, freed_bytes FROM cleanup_logs WHERE reason='expired_unwatched'")
      .get() as { reason: string; freed_bytes: number } | undefined;
    expect(log?.reason).toBe("expired_unwatched");
    expect(log?.freed_bytes).toBeGreaterThan(0);
  });
});
