import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MockMessageSource } from "@vault/im-adapters";
import { now } from "@vault/shared";
import { buildServer } from "../../apps/server/src/api/server.js";
import { createTestVault, fakeMp4, type TestVault } from "../helpers/vault.js";

interface Harness {
  vault: TestVault;
  base: string;
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];

async function apiHarness(options: { adminPassword?: string | null } = {}): Promise<Harness> {
  const vault = await createTestVault(options);
  const app = await buildServer(vault.context);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const harness: Harness = {
    vault,
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
      await vault.dispose();
    },
  };
  harnesses.push(harness);
  return harness;
}

async function login(harness: Harness, password = "test-password-123") {
  const response = await fetch(`${harness.base}/api/v1/session/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .filter(Boolean)
    .join("; ");
  const session = (await (
    await fetch(`${harness.base}/api/v1/session`, { headers: { Cookie: cookie } })
  ).json()) as { csrfToken: string };
  return { cookie, csrf: session.csrfToken };
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

describe("HTTP API authentication", () => {
  it("requires an admin session and CSRF token for mutations", async () => {
    const harness = await apiHarness();
    expect((await fetch(`${harness.base}/api/v1/system/status`)).status).toBe(401);

    const unauthorizedSettings = await fetch(`${harness.base}/api/v1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ download: { concurrency: 2 } }),
    });
    expect(unauthorizedSettings.status).toBe(401);

    const { cookie, csrf } = await login(harness);
    const status = await fetch(`${harness.base}/api/v1/system/status`, {
      headers: { Cookie: cookie },
    });
    expect(status.status).toBe(200);
    const snapshot = (await status.json()) as { database: { ok: boolean }; auth: { adapter: string } };
    expect(snapshot.database.ok).toBe(true);
    expect(snapshot.auth.adapter).toBe("mock");

    const noCsrf = await fetch(`${harness.base}/api/v1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ download: { concurrency: 2 } }),
    });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { error: { code: string } }).error.code).toBe("CSRF_REJECTED");

    const badOrigin = await fetch(`${harness.base}/api/v1/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ download: { concurrency: 2 } }),
    });
    expect(badOrigin.status).toBe(403);

    const ok = await fetch(`${harness.base}/api/v1/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ download: { concurrency: 2 } }),
    });
    expect(ok.status).toBe(200);
  });

  it("supports first-run setup with a one-time token and rejects wrong tokens", async () => {
    const harness = await apiHarness({ adminPassword: null });
    const session = (await (await fetch(`${harness.base}/api/v1/session`)).json()) as {
      setupRequired: boolean;
    };
    expect(session.setupRequired).toBe(true);
    expect((await fetch(`${harness.base}/api/v1/system/status`)).status).toBe(428);

    const tokenPath = harness.vault.context.adminAuth.getSetupTokenPath();
    expect(existsSync(tokenPath)).toBe(true);
    const token = (await import("node:fs")).readFileSync(tokenPath, "utf8").split("\n")[0]!.trim();

    const wrong = await fetch(`${harness.base}/api/v1/session/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token", password: "long-enough-password" }),
    });
    expect(wrong.status).toBe(401);

    const short = await fetch(`${harness.base}/api/v1/session/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "short" }),
    });
    expect(short.status).toBe(400);

    const setup = await fetch(`${harness.base}/api/v1/session/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "correct-horse-battery" }),
    });
    expect(setup.status).toBe(200);
    expect(existsSync(tokenPath)).toBe(false);
    const cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;

    const status = await fetch(`${harness.base}/api/v1/system/status`, { headers: { Cookie: cookie } });
    expect(status.status).toBe(200);

    const wrongLogin = await fetch(`${harness.base}/api/v1/session/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(wrongLogin.status).toBe(401);
    const goodLogin = await fetch(`${harness.base}/api/v1/session/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-horse-battery" }),
    });
    expect(goodLogin.status).toBe(200);
  });

  it("rejects invalid settings with a validation error", async () => {
    const harness = await apiHarness();
    const { cookie, csrf } = await login(harness);
    const response = await fetch(`${harness.base}/api/v1/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ download: { concurrency: 999 } }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("video streaming and deletion", () => {
  it("supports HTTP Range, authorization, and idempotent deletion", async () => {
    const harness = await apiHarness();
    const { cookie, csrf } = await login(harness);
    const { context } = harness.vault;
    const videoId = "video-api-range-test";
    const relative = "aa/video.mp4";
    mkdirSync(resolve(context.paths.videosDir, "aa"), { recursive: true });
    const absolute = resolve(context.paths.videosDir, relative);
    const body = fakeMp4(2048);
    writeFileSync(absolute, body);
    const timestamp = now();
    context.sqlite
      .prepare(
        `INSERT INTO videos
          (id, platform, work_id, media_key, title, status, is_favorite, created_at, updated_at, file_path, file_size, duration_seconds)
         VALUES (?, 'douyin', ?, ?, ?, 'ready', 0, ?, ?, ?, ?, 9)`,
      )
      .run(
        videoId,
        "7412345678901234777",
        "douyin:work:7412345678901234777",
        "API Range 测试",
        timestamp,
        timestamp,
        relative,
        body.length,
      );

    const fullUnauthorized = await fetch(`${harness.base}/api/v1/videos/${videoId}/stream`);
    expect(fullUnauthorized.status).toBe(401);

    const ranged = await fetch(`${harness.base}/api/v1/videos/${videoId}/stream`, {
      headers: { Cookie: cookie, Range: "bytes=10-19" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 10-19/${body.length}`);
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    const chunk = Buffer.from(await ranged.arrayBuffer());
    expect(chunk.length).toBe(10);
    expect(chunk.equals(body.subarray(10, 20))).toBe(true);

    const invalidRange = await fetch(`${harness.base}/api/v1/videos/${videoId}/stream`, {
      headers: { Cookie: cookie, Range: `bytes=${body.length}-` },
    });
    expect(invalidRange.status).toBe(416);

    const head = await fetch(`${harness.base}/api/v1/videos/${videoId}/stream`, {
      method: "HEAD",
      headers: { Cookie: cookie },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(body.length));

    const cover = await fetch(`${harness.base}/api/v1/videos/${videoId}/cover`, {
      headers: { Cookie: cookie },
    });
    expect(cover.status).toBe(404);

    const noCsrfDelete = await fetch(`${harness.base}/api/v1/videos/${videoId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(noCsrfDelete.status).toBe(403);

    const deleteResponse = await fetch(`${harness.base}/api/v1/videos/${videoId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "X-CSRF-Token": csrf },
    });
    expect(deleteResponse.status).toBe(200);
    expect(((await deleteResponse.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(existsSync(absolute)).toBe(false);

    const again = await fetch(`${harness.base}/api/v1/videos/${videoId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "X-CSRF-Token": csrf },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { deleted: boolean }).deleted).toBe(false);
  });

  it("tags ready videos as unavailable from a live IM availability check", async () => {
    const harness = await apiHarness();
    const { cookie } = await login(harness);
    const { context } = harness.vault;
    const group = context.groups.ensureFromMessage(
      context.auth.accountId,
      "7000000000000000099",
      "可访问性测试群",
    );
    const workId = "7412345678901234999";
    const videoId = "video-availability-test";
    const messageId = "message-availability-test";
    const timestamp = now();

    context.sqlite
      .prepare(
        `INSERT INTO messages
          (id, account_id, group_id, platform_message_id, sent_at, received_at, type, work_id, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'shared_work', ?, 'realtime', 'resolved', ?)`,
      )
      .run(
        messageId,
        context.auth.accountId,
        group.id,
        "platform-message-availability-test",
        timestamp,
        timestamp,
        workId,
        timestamp,
      );
    context.sqlite
      .prepare(
        `INSERT INTO videos
          (id, platform, work_id, media_key, title, status, is_favorite, created_at, updated_at)
         VALUES (?, 'douyin', ?, ?, '可访问性测试视频', 'ready', 0, ?, ?)`,
      )
      .run(videoId, workId, `douyin:work:${workId}`, timestamp, timestamp);
    context.sqlite
      .prepare(
        `INSERT INTO video_shares (id, video_id, message_id, shared_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("share-availability-test", videoId, messageId, timestamp, timestamp);

    const source = context.auth.sourceRef as MockMessageSource;
    source.setWorkUnavailable(workId);

    const listResponse = await fetch(`${harness.base}/api/v1/videos`, {
      headers: { Cookie: cookie },
    });
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      items: Array<{ id: string; availability?: { state: string; checkedAt: number | null } }>;
    };
    const item = list.items.find((entry) => entry.id === videoId);
    expect(item?.availability?.state).toBe("unavailable");
    expect(item?.availability?.checkedAt).toEqual(expect.any(Number));

    source.setWorkUnavailable(workId, false);
    const detailResponse = await fetch(`${harness.base}/api/v1/videos/${videoId}?refresh=1`, {
      headers: { Cookie: cookie },
    });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      item: { availability?: { state: string } };
    };
    expect(detail.item.availability?.state).toBe("available");
  });

  it("streams a Server-Sent Event snapshot to authenticated clients", async () => {
    const harness = await apiHarness();
    const { cookie } = await login(harness);
    const controller = new AbortController();
    const response = await fetch(`${harness.base}/api/v1/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 3000)),
    ]);
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: system.status_changed");
    expect(text).toContain("snapshot");
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
