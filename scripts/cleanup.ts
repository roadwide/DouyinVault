import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const base = (process.env.VAULT_URL ?? "http://127.0.0.1:18760").replace(/\/+$/, "");

async function readPassword(): Promise<string> {
  if (process.env.VAULT_ADMIN_PASSWORD) return process.env.VAULT_ADMIN_PASSWORD;
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return (await terminal.question("管理员密码：")).trim();
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const password = await readPassword();
  const login = await fetch(`${base}/api/v1/session/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) {
    console.error(`登录失败：HTTP ${login.status}`);
    process.exit(1);
  }
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .filter(Boolean)
    .join("; ");
  const session = (await (
    await fetch(`${base}/api/v1/session`, { headers: { Cookie: cookie } })
  ).json()) as { csrfToken?: string };
  if (!session.csrfToken) {
    console.error("无法获取 CSRF 令牌。");
    process.exit(1);
  }
  const response = await fetch(`${base}/api/v1/cleanup/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    body: "{}",
  });
  const payload = (await response.json()) as {
    result?: {
      deletedVideos: number;
      failedRecordsDeleted: number;
      staleTempDeleted: number;
      orphanFilesDeleted: number;
      freedBytes: number;
      missingFiles: number;
    };
    error?: { message?: string };
  };
  if (!response.ok || !payload.result) {
    console.error(`清理失败：${payload.error?.message ?? `HTTP ${response.status}`}`);
    process.exit(1);
  }
  const result = payload.result;
  console.log("清理完成：");
  console.log(`  删除视频：${result.deletedVideos}`);
  console.log(`  失败记录：${result.failedRecordsDeleted}`);
  console.log(`  临时文件：${result.staleTempDeleted}`);
  console.log(`  孤儿文件：${result.orphanFilesDeleted}`);
  console.log(`  缺失文件：${result.missingFiles}`);
  console.log(`  释放空间：${(result.freedBytes / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((error) => {
  console.error("清理失败：", error);
  process.exit(1);
});
