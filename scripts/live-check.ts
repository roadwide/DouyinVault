import { createWriteStream, mkdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient, configureLogger } from "douyin-im";
import { formatBytes, redactUrl, safeErrorMessage } from "@vault/shared";

type AnyRecord = Record<string, any>;

const preflight = process.argv.includes("--preflight");
const dataDir = resolve(process.env.RUN_LIVE_DATA_DIR ?? "./data/live-check");
const durationSeconds = Number(process.env.LIVE_DURATION_SECONDS ?? 600);
const shouldDownload = process.env.LIVE_DOWNLOAD === "1";
const reportPath = resolve("docs/acceptance-report.local.md");
const reportJsonPath = resolve(dataDir, "report.json");

interface Report {
  startedAt: string;
  finishedAt?: string;
  online: boolean;
  groups: Array<{ id: string; name: string }>;
  messages: number;
  groupMessages: number;
  workCards: number;
  accessDenied: number;
  downloadableMedia: number;
  downloadedFiles: string[];
  historyMessages: number;
  errors: string[];
  notes: string[];
}

const report: Report = {
  startedAt: new Date().toISOString(),
  online: false,
  groups: [],
  messages: 0,
  groupMessages: 0,
  workCards: 0,
  accessDenied: 0,
  downloadableMedia: 0,
  downloadedFiles: [],
  historyMessages: 0,
  errors: [],
  notes: [],
};

function commandVersion(binary: string, args = ["-version"]): string | null {
  try {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return null;
    return `${result.stdout}${result.stderr}`.split("\n")[0]?.trim() ?? "";
  } catch {
    return null;
  }
}

function printPreflight(): void {
  console.log("Douyin Vault · Phase 0 现场检查\n");
  console.log(`Node.js      ${process.version}`);
  console.log(`ffmpeg       ${commandVersion(process.env.FFMPEG_PATH ?? "ffmpeg") ?? "未找到"}`);
  console.log(`ffprobe      ${commandVersion(process.env.FFPROBE_PATH ?? "ffprobe") ?? "未找到"}`);
  console.log(`yt-dlp       ${commandVersion(process.env.YTDLP_PATH ?? "yt-dlp", ["--version"]) ?? "未找到（备用下载器不可用）"}`);
  console.log(`数据目录     ${dataDir}`);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const probe = resolve(dataDir, ".write-test");
    writeFileSync(probe, "ok", { mode: 0o600 });
    console.log("目录可写     是");
  } catch (error) {
    console.log(`目录可写     否（${safeErrorMessage(error)}）`);
  }
  console.log("\n注意：preflight 只检查本机依赖，不代表抖音登录或群消息链路已通过。");
}

async function downloadMedia(url: string, workId: string): Promise<string | null> {
  const directory = resolve(dataDir, "downloads");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, `${workId || "media"}-${Date.now()}.mp4`);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        Referer: "https://www.douyin.com/",
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(target, { mode: 0o600 }));
    report.downloadedFiles.push(target);
    return target;
  } catch (error) {
    report.errors.push(`media download failed: ${safeErrorMessage(error)}`);
    return null;
  }
}

function writeReport(): void {
  report.finishedAt = new Date().toISOString();
  const json = JSON.stringify(report, null, 2);
  writeFileSync(reportJsonPath, json, { mode: 0o600 });
  const markdown = [
    "# Douyin Vault · Phase 0 现场验收记录",
    "",
    `- 开始：${report.startedAt}`,
    `- 结束：${report.finishedAt}`,
    `- 在线：${report.online ? "是" : "否"}`,
    `- 群聊数量：${report.groups.length}`,
    `- 收到消息总数：${report.messages}`,
    `- 群聊消息：${report.groupMessages}`,
    `- 作品卡片：${report.workCards}`,
    `- 可下载作品卡片：${report.downloadableMedia}`,
    `- 无权限 / 不可下载：${report.accessDenied}`,
    `- 历史消息：${report.historyMessages}`,
    `- 已下载文件：${report.downloadedFiles.length}`,
    "",
    "## 群聊",
    ...report.groups.map((group) => `- ${group.name} · ${group.id}`),
    "",
    "## 错误",
    ...(report.errors.length ? report.errors.map((error) => `- ${error}`) : ["- 无"]),
    "",
    "## 仍需人工确认",
    "- [ ] 登录二维码与手机扫码成功",
    "- [ ] 重启后 Session 自动恢复（再次运行同一 RUN_LIVE_DATA_DIR）",
    "- [ ] 两个群各发送一条视频分享，均被识别",
    "- [ ] 同一作品重复分享只产生一个视频文件、两条来源",
    "- [ ] 普通文本与图片未触发视频下载",
    "- [ ] 短暂断网后自动重连并补拉",
    "- [ ] 缓存完成后原作品失效，本地仍可播放",
    "- [ ] 已失效作品分享显示明确失败",
    "",
    "> 本记录只陈述 harness 观察到的事实，不自动宣称 Phase 0 通过。",
    "",
  ].join("\n");
  mkdirSync(resolve("docs"), { recursive: true });
  writeFileSync(reportPath, markdown, { mode: 0o600 });
  console.log(`\n验收记录：${reportPath}`);
  console.log(`JSON：${reportJsonPath}`);
}

async function main(): Promise<void> {
  if (preflight) {
    printPreflight();
    return;
  }
  if (process.env.RUN_LIVE_TESTS !== "1") {
    console.error(
      "现场测试默认关闭。请设置 RUN_LIVE_TESTS=1，并使用专门的测试账号与受控群聊。\n" +
        "建议先运行：pnpm live:preflight",
    );
    process.exit(1);
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  configureLogger({ level: process.env.LOG_LEVEL ?? "info", color: process.stdout.isTTY });
  const client = createClient({ dataDir });
  const qrPath = resolve(dataDir, "login.png");
  let shuttingDown = false;

  const finish = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      writeReport();
    } finally {
      // Intentionally do not call client.logout(): the next run must verify
      // that the saved Session restores. Delete RUN_LIVE_DATA_DIR to sign out.
      process.exit(code);
    }
  };

  client.on("system.login.qrcode", async ({ account, qrcodeBase64 }: AnyRecord) => {
    writeFileSync(qrPath, Buffer.from(qrcodeBase64, "base64"), { mode: 0o600 });
    chmodSync(qrPath, 0o600);
    console.log(`\n请用抖音 App 扫码：${qrPath}`);
    console.log("二维码包含登录凭据，请勿截图分享或提交到仓库。\n");
    try {
      await account.continueLogin();
    } catch (error) {
      report.errors.push(`continueLogin failed: ${safeErrorMessage(error)}`);
    }
  });
  client.on("system.login.sms", async ({ account }: AnyRecord) => {
    console.log("需要短信验证，但现场脚本不自动提交验证码。请在官方客户端完成登录后重试。");
    report.errors.push("SMS verification required; manual completion not automated");
    void account;
  });
  client.on("system.login.verification", async ({ verification }: AnyRecord) => {
    console.log(`需要官方二次验证：${verification?.methods?.join(", ") ?? "unknown"}`);
    try {
      const url = await verification.openUrl({ openBrowser: true });
      console.log(`验证页：${redactUrl(url)}（只在本机回环地址）`);
    } catch (error) {
      report.errors.push(`verification open failed: ${safeErrorMessage(error)}`);
    }
  });
  client.on("system.login.error", (error: unknown) => {
    report.errors.push(`login error: ${safeErrorMessage(error)}`);
    console.error("登录失败：", safeErrorMessage(error));
  });
  client.on("system.online", async ({ account }: AnyRecord) => {
    report.online = true;
    console.log(`已上线：${account?.nickname ?? "unknown"} (${account?.uid ?? "unknown"})`);
    try {
      const groups = await account.getGroupList(true);
      report.groups = groups.map((group: AnyRecord) => ({
        id: String(group.groupId),
        name: String(group.name ?? ""),
      }));
      console.log(`群列表（${report.groups.length}）：`);
      for (const group of report.groups) console.log(`  ${group.name}  ${group.id}`);
      if (report.groups[0]) {
        const page = await groups[0].getHistory({ count: 20, direction: "older", includeCurrent: true });
        report.historyMessages = page.messages.length;
        console.log(`历史消息取样：${page.messages.length} 条（hasMore=${page.hasMore}）`);
      }
    } catch (error) {
      report.errors.push(`group list/history failed: ${safeErrorMessage(error)}`);
    }
  });
  client.on("system.reconnecting", () => console.log("连接断开，SDK 正在重连…"));
  client.on("system.offline", () => console.log("连接离线。"));
  client.on("message", async (event: AnyRecord) => {
    report.messages += 1;
    if (event.type !== "message.group" && event.conversationType !== 2) return;
    report.groupMessages += 1;
    const work = event.work as AnyRecord | undefined;
    console.log(
      `消息：${event.group?.name ?? event.threadId} / ${event.member?.nickname ?? event.senderUid}` +
        `${work?.id ? ` / 作品 ${work.id}` : ""}`,
    );
    if (!work) return;
    report.workCards += 1;
    try {
      const access = await Promise.race([
        work.getAccess(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("getAccess timeout")), 15_000)),
      ]) as AnyRecord;
      console.log(
        `  权限：canDownload=${access.canDownload} canShare=${access.canShare} media=${access.media?.length ?? 0}`,
      );
      const video = (access.media ?? []).find((item: AnyRecord) => item.kind === "video");
      if (!access.canDownload || !video) {
        report.accessDenied += 1;
        return;
      }
      report.downloadableMedia += 1;
      if (shouldDownload) {
        const file = await downloadMedia(video.url, String(work.id));
        if (file) console.log(`  已下载：${file} (${formatBytes(statSync(file).size)})`);
      }
    } catch (error) {
      report.accessDenied += 1;
      report.errors.push(`getAccess failed: ${safeErrorMessage(error)}`);
      console.log(`  作品访问失败：${safeErrorMessage(error)}`);
    }
  });
  client.on("system.handler.error", (payload: AnyRecord) => {
    report.errors.push(`handler error ${String(payload?.event)}: ${safeErrorMessage(payload?.error)}`);
  });

  process.once("SIGINT", () => void finish(0));
  process.once("SIGTERM", () => void finish(0));
  setTimeout(() => {
    console.log(`\n现场观察时间结束（${durationSeconds}s）。`);
    void finish(report.online ? 0 : 1);
  }, durationSeconds * 1000).unref?.();

  console.log(`使用独立数据目录：${dataDir}`);
  console.log("请在此窗口保持运行，并从两个受控测试群发送样本消息。Ctrl+C 提前结束。\n");
  try {
    await client.login();
  } catch (error) {
    report.errors.push(`client.login failed: ${safeErrorMessage(error)}`);
    console.error("登录流程失败：", safeErrorMessage(error));
    await finish(1);
  }
}

main().catch((error) => {
  console.error("现场测试异常：", error);
  process.exit(1);
});
