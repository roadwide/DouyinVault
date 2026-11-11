import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { eq } from "drizzle-orm";
import { loadDotEnv, loadConfig, buildPaths } from "../apps/server/src/config.js";
import { openDatabase, settings, adminSessions } from "@vault/db";
import { createPasswordHash } from "../apps/server/src/auth/admin-auth.js";
import { now } from "@vault/shared";

async function readPassword(): Promise<string> {
  const env = process.env.VAULT_NEW_PASSWORD;
  if (env) return env;
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const first = (await terminal.question("新管理员密码（至少 10 个字符）：")).trim();
    const second = (await terminal.question("再次输入：")).trim();
    if (first !== second) throw new Error("两次输入的密码不一致");
    return first;
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  if (process.env.VAULT_RESET_PASSWORD !== "1") {
    console.error(
      "该脚本会重置管理员密码并使所有管理会话失效。\n" +
        "确认在服务器本机执行后，设置 VAULT_RESET_PASSWORD=1 再运行。",
    );
    process.exit(1);
  }
  const password = await readPassword();
  if (password.length < 10) throw new Error("密码至少需要 10 个字符");
  loadDotEnv();
  const config = loadConfig();
  const paths = buildPaths(config);
  if (!existsSync(paths.dbFile)) {
    throw new Error(`数据库不存在：${paths.dbFile}`);
  }
  const opened = openDatabase({ path: paths.dbFile });
  try {
    const timestamp = now();
    const value = createPasswordHash(password);
    opened.db.transaction((tx) => {
      tx.insert(settings)
        .values({ key: "auth.password_hash", value, updatedAt: timestamp })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: timestamp } })
        .run();
      tx.delete(adminSessions).run();
    });
    // Remove a stale first-run token, if any.
    const { rmSync } = await import("node:fs");
    rmSync(`${paths.sessionsDir}/setup-token.txt`, { force: true });
    console.log("管理员密码已重置，所有管理后台会话已失效。");
    console.log("若服务正在运行，请重启它以清除内存中的限流/会话状态。");
  } finally {
    opened.close();
  }
}

main().catch((error) => {
  console.error("重置失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
