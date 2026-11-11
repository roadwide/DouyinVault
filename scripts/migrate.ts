import { loadDotEnv, loadConfig, buildPaths } from "../apps/server/src/config.js";
import { createDatabase } from "@vault/db";

loadDotEnv();
const config = loadConfig();
const paths = buildPaths(config);
const opened = createDatabase(paths.dbFile);
console.log(
  opened.appliedMigrations.length > 0
    ? `已应用迁移：${opened.appliedMigrations.join(", ")}`
    : "数据库已是最新版本。",
);
console.log(`数据库：${paths.dbFile}`);
opened.close();
