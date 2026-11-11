import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { now, sleep } from "@vault/shared";
import { videos, downloadJobs } from "@vault/db";
import { loadConfig, loadDotEnv } from "../apps/server/src/config.js";
import { createContext } from "../apps/server/src/context.js";
import type { MockMessageSource } from "@vault/im-adapters";

const execFileAsync = promisify(execFile);

const CLIPS = [
  { file: "sunset.mp4", text: "SUNSET", sub: "30 SECONDS", c0: "0x1a1026", c1: "0xfe2c55", title: "海边日落的 30 秒", sender: "林小满", work: "7412345678901234501", group: 0 },
  { file: "city.mp4", text: "4 AM", sub: "CITY", c0: "0x07131f", c1: "0x1f8fa8", title: "凌晨四点的城市", sender: "周野", work: "7412345678901234502", group: 0 },
  { file: "cat.mp4", text: "THE CAT", sub: "OPENS DOORS", c0: "0x21140c", c1: "0xe08a3c", title: "群友的猫会开门", sender: "阿哲", work: "7412345678901234503", group: 0 },
  { file: "noodles.mp4", text: "NOODLES", sub: "UNTIL NOON", c0: "0x1c0d0d", c1: "0xb23b2f", title: "这家面馆只开到中午", sender: "小鹿", work: "7412345678901234504", group: 1 },
  { file: "signal.mp4", text: "SIGNAL", sub: "ON THE PEAK", c0: "0x0b1a13", c1: "0x3f9e6d", title: "山顶的信号比城市好", sender: "老陈", work: "7412345678901234505", group: 1 },
  { file: "rain.mp4", text: "RAINY", sub: "CONVENIENCE", c0: "0x101522", c1: "0x5b6fa8", title: "雨天的便利店", sender: "阿澈", work: "7412345678901234506", group: 1 },
];

async function generateClip(path: string, clip: (typeof CLIPS)[number], ffmpegPath: string): Promise<void> {
  if (existsSync(path) && statSync(path).size > 10_000) return;
  const filter = [
    `gradients=s=720x1280:d=9:c0=${clip.c0}:c1=${clip.c1}:x0=0:y0=0:x1=720:y1=1280`,
  ].join(",");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    filter,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    "9",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "27",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    "-movflags",
    "+faststart",
    "-y",
    path,
  ];
  await execFileAsync(ffmpegPath, args, { timeout: 120_000 });
}

async function startMediaServer(directory: string): Promise<{ url: (name: string) => string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/").replace(/^\/+/, "");
    const file = resolve(directory, pathname);
    if (!file.startsWith(directory) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const stats = statSync(file);
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
        if (start >= stats.size || end < start) {
          response.writeHead(416, { "Content-Range": `bytes */${stats.size}` }).end();
          return;
        }
        response.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stats.size}`,
          "Accept-Ranges": "bytes",
        });
        createReadStream(file, { start, end }).pipe(response);
        return;
      }
    }
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stats.size,
      "Accept-Ranges": "bytes",
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动演示媒体服务器");
  return {
    url: (name: string) => `http://127.0.0.1:${address.port}/${encodeURIComponent(name)}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig({ DEMO_MODE: "true" });
  if (config.nodeEnv === "production") {
    console.error("演示种子不能在 NODE_ENV=production 下运行。请使用开发/测试数据目录。");
    process.exit(1);
  }
  if (config.imAdapter !== "mock") {
    console.error(
      `演示种子只适用于 mock 适配器，当前 IM_ADAPTER=${config.imAdapter}。请使用单独的数据目录并设置 IM_ADAPTER=mock。`,
    );
    process.exit(1);
  }
  const context = await createContext(config);
  const existing = context.sqlite.prepare("SELECT COUNT(*) AS count FROM videos").get() as { count: number };
  if (existing.count > 0) {
    console.error(
      `数据目录已有 ${existing.count} 个视频，为避免破坏真实数据，演示种子不会继续。请指定新的 DATA_DIR。`,
    );
    await context.close();
    process.exit(1);
  }

  const assetsDir = resolve(context.paths.tempDir, "demo-assets");
  mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
  console.log("生成演示视频（ffmpeg）…");
  for (const clip of CLIPS) {
    await generateClip(resolve(assetsDir, clip.file), clip, config.ffmpegPath);
  }
  const mediaServer = await startMediaServer(assetsDir);

  try {
    console.log("连接演示账号并读取群列表…");
    if (!(context.auth.sourceRef as MockMessageSource).demoConnected) {
      await context.auth.completeDemoLogin("演示账号 · 时光仓");
    }
    await context.groupSync.refreshGroupList();
    const groups = context.groups.list(context.auth.accountId);
    if (groups.length < 2) throw new Error("演示适配器没有返回足够的群聊");

    for (const group of groups.slice(0, 2)) {
      context.groups.setEnabled(group.id, true, true);
      context.groups.markSyncSuccess({
        groupId: group.id,
        at: now(),
        cursor: String(now()),
        gap: false,
      });
    }
    context.auth.markSyncSucceeded(now());

    const source = context.auth.sourceRef as MockMessageSource;
    console.log("注入群聊视频分享…");
    for (const clip of CLIPS) {
      const group = groups[clip.group]!;
      await source.publish({
        groupId: group.platformGroupId,
        workId: clip.work,
        title: clip.title,
        senderName: clip.sender,
      });
      // Chat-native media URL exercises the real DirectMediaDownloader path
      // without pretending a public Douyin CDN URL exists.
      const video = context.sqlite
        .prepare("SELECT id FROM videos WHERE work_id=?")
        .get(clip.work) as { id: string } | undefined;
      if (video) {
        const message = context.sqlite
          .prepare(
            `SELECT m.id FROM messages m JOIN video_shares vs ON vs.message_id=m.id
              WHERE vs.video_id=? ORDER BY vs.shared_at DESC LIMIT 1`,
          )
          .get(video.id) as { id: string } | undefined;
        if (message) context.mediaCache.set(message.id, mediaServer.url(clip.file));
      }
    }

    // Make one cached work unavailable so the UI can exercise the live tag.
    // The e2e server starts in a new process, so persist the mock fixture.
    source.setWorkUnavailable(CLIPS[2]!.work);
    writeFileSync(
      resolve(context.paths.sessionsDir, "mock-unavailable.json"),
      JSON.stringify([CLIPS[2]!.work]),
      { mode: 0o600 },
    );

    // One duplicate share from another group must reuse the same video file.
    await source.publish({
      groupId: groups[1]!.platformGroupId,
      workId: CLIPS[0]!.work,
      title: CLIPS[0]!.title,
      senderName: "另一个群友",
    });
    {
      const video = context.sqlite
        .prepare("SELECT id FROM videos WHERE work_id=?")
        .get(CLIPS[0]!.work) as { id: string } | undefined;
      if (video) {
        const message = context.sqlite
          .prepare(
            `SELECT m.id FROM messages m JOIN video_shares vs ON vs.message_id=m.id
              WHERE vs.video_id=? ORDER BY vs.shared_at DESC LIMIT 1`,
          )
          .get(video.id) as { id: string } | undefined;
        if (message) context.mediaCache.set(message.id, mediaServer.url(CLIPS[0]!.file));
      }
    }

    // One unresolved work card and one failed record for diagnostics.
    await context.ingest.ingest({
      accountId: context.auth.accountId,
      groupId: groups[0]!.platformGroupId,
      groupName: groups[0]!.name,
      messageId: `demo-unresolved-${Date.now()}`,
      senderName: "系统诊断",
      sentAt: now() - 5 * 60_000,
      receivedAt: now(),
      type: "unknown",
      source: "realtime",
      diagnostic: "Work card without a usable work id (UNRESOLVED): recorded by demo seed.",
    });

    console.log("启动下载 Worker，等待演示视频完成真实下载与校验…");
    context.worker.start();
    const expected = CLIPS.length;
    const deadline = Date.now() + 120_000;
    let done = 0;
    while (Date.now() < deadline) {
      const row = context.sqlite
        .prepare(
          `SELECT COUNT(DISTINCT j.video_id) AS count FROM download_jobs j
            JOIN videos v ON v.id=j.video_id WHERE j.status='COMPLETED' AND v.work_id LIKE '74123456789012345%'`,
        )
        .get() as { count: number };
      done = Number(row.count);
      if (done >= expected) break;
      await sleep(500);
    }
    await context.worker.stop();
    if (done < expected) {
      const failed = context.sqlite
        .prepare(
          `SELECT v.title, j.status, j.error_code, j.error_message FROM download_jobs j
            JOIN videos v ON v.id=j.video_id WHERE j.status != 'COMPLETED'`,
        )
        .all();
      console.error(`仅有 ${done}/${expected} 个演示视频完成。失败任务：`, failed);
      throw new Error("演示下载未全部完成");
    }

    // Add one realistic failed record without waiting for external retries.
    await context.ingest.ingest({
      accountId: context.auth.accountId,
      groupId: groups[0]!.platformGroupId,
      groupName: groups[0]!.name,
      messageId: `demo-failed-${Date.now()}`,
      senderName: "阿哲",
      sentAt: now() - 12 * 60_000,
      receivedAt: now(),
      type: "shared_work",
      workId: "7412345678901234599",
      title: "已删除的作品（演示失败记录）",
      source: "history",
    });
    const failedVideo = context.db.select().from(videos).where(eq(videos.workId, "7412345678901234599")).get();
    if (failedVideo) {
      const timestamp = now();
      context.sqlite
        .prepare(
          `UPDATE videos SET status='failed', last_error_code='RESOURCE_UNAVAILABLE',
            last_error_message='作品已失效或作者设为私密，无法获取媒体资源', updated_at=? WHERE id=?`,
        )
        .run(timestamp, failedVideo.id);
      context.sqlite
        .prepare(
          `UPDATE download_jobs SET status='FAILED', error_code='RESOURCE_UNAVAILABLE',
            error_message='作品已失效或作者设为私密，无法获取媒体资源', finished_at=?, updated_at=? WHERE video_id=?`,
        )
        .run(timestamp, timestamp, failedVideo.id);
    }

    const ready = context.sqlite
      .prepare("SELECT id, title, duration_seconds FROM videos WHERE status='ready' ORDER BY created_at")
      .all() as Array<{ id: string; title: string | null; duration_seconds: number }>;
    if (ready[0]) context.library.update(ready[0].id, { isFavorite: true });
    if (ready[1]) context.library.updateProgress(ready[1].id, { positionSeconds: (ready[1].duration_seconds ?? 9) * 0.9, durationSeconds: ready[1].duration_seconds ?? 9 });

    console.log("");
    console.log(`演示数据已生成：${ready.length} 个可播放视频，1 个失败记录，1 条未解析卡片。`);
    console.log("启动服务后使用管理员密码登录即可看到视频库。");
    console.log(`数据目录：${config.dataDir}`);
  } finally {
    await mediaServer.close();
    await context.close();
    rmSync(assetsDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("演示种子失败：", error);
  process.exit(1);
});
