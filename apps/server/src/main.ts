#!/usr/bin/env node
import { loadDotEnv, loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { buildServer } from "./api/server.js";
import { safeErrorMessage } from "@vault/shared";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (config.nodeEnv === "production" && config.imAdapter === "mock") {
    throw new Error(
      "生产模式拒绝使用 mock IM 适配器。请设置 IM_ADAPTER=douyin-im；本地演示请使用 NODE_ENV=development。",
    );
  }

  const context = await createContext(config);
  const app = await buildServer(context);
  let closing = false;
  const shutdown = async (reason: string, exitCode = 0) => {
    if (closing) return;
    closing = true;
    context.logger.info({ reason }, "正在关闭 Douyin Vault");
    const timer = setTimeout(() => {
      context.logger.error("优雅关闭超时，进程强制退出");
      process.exit(exitCode || 1);
    }, 12_000);
    timer.unref();
    try {
      await app.close();
      await context.close();
    } catch (error) {
      context.logger.error({ error: safeErrorMessage(error) }, "关闭时出错");
    } finally {
      clearTimeout(timer);
      process.exit(exitCode);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    context.logger.fatal({ error: safeErrorMessage(error) }, "未捕获异常");
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    context.logger.error({ error: safeErrorMessage(error) }, "未处理的 Promise 拒绝");
  });

  await app.listen({ host: config.host, port: config.port });
  context.worker.start();
  context.scheduler.start();

  context.logger.info(
    {
      url: `http://${config.host}:${config.port}`,
      adapter: config.imAdapter,
      dataDir: config.dataDir,
      demoMode: config.demoMode,
    },
    "Douyin Vault 已启动",
  );
  if (context.adminAuth.setupRequired) {
    context.logger.warn(
      `首次使用：在服务器上执行 pnpm setup-token 获取安装令牌（文件：${context.adminAuth.getSetupTokenPath()}），然后打开 Web 页面设置管理员密码。`,
    );
  }
  if (config.imAdapter === "playwright") {
    context.logger.warn("Playwright 备用适配器为实验性方案，历史补拉未实现；生产使用前必须完成 Phase 0 验收。");
  }
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    context.logger.warn(
      { host: config.host },
      "服务没有绑定回环地址。请确认防火墙与 Cloudflare Access 已正确保护管理接口。",
    );
  }
}

main().catch((error) => {
  console.error("Douyin Vault 启动失败:", error);
  process.exit(1);
});
