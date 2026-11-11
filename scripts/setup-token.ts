import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { loadDotEnv, loadConfig, buildPaths } from "../apps/server/src/config.js";
import { openDatabase } from "@vault/db";
import { settings } from "@vault/db";

loadDotEnv();
const config = loadConfig();
const paths = buildPaths(config);
const tokenPath = `${paths.sessionsDir}/setup-token.txt`;
if (!existsSync(paths.dbFile)) {
  console.error("数据库尚未创建。请先启动一次 Douyin Vault 服务。");
  process.exit(1);
}
const opened = openDatabase({ path: paths.dbFile, readOnly: false });
const password = opened.db.select().from(settings).where(eq(settings.key, "auth.password_hash")).get();
if (password) {
  console.log("管理员密码已经设置。若需要重置，请先备份数据库，再在本机执行 pnpm reset-password。");
  opened.close();
  process.exit(0);
}
if (!existsSync(tokenPath)) {
  console.error("安装令牌文件不存在。请先启动一次服务，它会生成令牌。");
  opened.close();
  process.exit(1);
}
const token = readFileSync(tokenPath, "utf8").split("\n")[0]?.trim();
if (!token) {
  console.error("安装令牌文件为空，请删除后重启服务重新生成。");
  opened.close();
  process.exit(1);
}
console.log("");
console.log("一次性安装令牌：");
console.log("");
console.log(`  ${token}`);
console.log("");
console.log("打开 Web 页面，粘贴令牌并设置至少 10 个字符的管理员密码。");
console.log("设置完成后该文件会被自动删除。");
opened.close();
