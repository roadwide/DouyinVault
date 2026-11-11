import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv, loadConfig, buildPaths } from "../apps/server/src/config.js";
import { openDatabase } from "@vault/db";

loadDotEnv();
const config = loadConfig();
const paths = buildPaths(config);
if (!existsSync(paths.dbFile)) {
  console.error(`数据库不存在：${paths.dbFile}`);
  process.exit(1);
}
mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "-")
  .slice(0, 19);
const target = resolve(paths.backupsDir, `vault-${stamp}.sqlite`);
const opened = openDatabase({ path: paths.dbFile });
try {
  await opened.sqlite.backup(target);
  chmodSync(target, 0o600);
  const bytes = statSync(target).size;
  const files = readdirSync(paths.backupsDir)
    .filter((name) => /^vault-.*\.sqlite$/.test(name))
    .map((name) => ({ name, path: resolve(paths.backupsDir, name), mtime: statSync(resolve(paths.backupsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(7)) unlinkSync(file.path);
  console.log(`备份完成：${target}`);
  console.log(`大小：${(bytes / 1024 / 1024).toFixed(2)} MB，保留最近 7 份。`);
  console.log("注意：备份包含抖音账号消息元数据与管理员密码哈希，请按敏感文件保管。");
} finally {
  opened.close();
}
