import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { ApiDeps } from "./deps.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerVideoRoutes } from "./routes/videos.js";
import { registerDownloadRoutes } from "./routes/downloads.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerDemoRoutes } from "./routes/demo.js";

const PUBLIC_API_ROUTES = new Set([
  "/api/v1/session",
  "/api/v1/session/login",
  "/api/v1/session/setup",
]);

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'",
  };
  if (secure) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    genReqId: () => randomUUID(),
    requestIdHeader: "x-request-id",
  });

  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? request.url;
    if (!url.startsWith("/api/v1/")) return;
    const isPublic = PUBLIC_API_ROUTES.has(url);
    if (!isPublic && deps.adminAuth.setupRequired) {
      reply.code(428).send({
        error: {
          code: "SETUP_REQUIRED",
          message: "尚未设置管理员密码。请在服务器上执行 pnpm setup-token。",
        },
      });
      return;
    }
    if (isPublic) {
      if (isMutation(request.method) && !deps.adminAuth.isOriginAllowed(request)) {
        reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "请求来源不被允许" } });
        return;
      }
      return;
    }
    const session = deps.adminAuth.readSession(request);
    if (!session) {
      reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "请先登录管理后台" } });
      return;
    }
    if (isMutation(request.method)) {
      if (!deps.adminAuth.isOriginAllowed(request)) {
        reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "请求来源不被允许" } });
        return;
      }
      if (!deps.adminAuth.verifyCsrf(request, session)) {
        reply.code(403).send({ error: { code: "CSRF_REJECTED", message: "CSRF 校验失败，请刷新页面" } });
        return;
      }
    }
    (request as unknown as { adminSessionId: string }).adminSessionId = session.id;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    for (const [key, value] of Object.entries(securityHeaders(deps.config.secureCookies))) {
      reply.header(key, value);
    }
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.get("/healthz", async (_request, reply) => {
    const health = deps.health.publicHealth();
    reply.code(health.ok ? 200 : 503);
    return health;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "请求参数不合法",
          details: error.issues.slice(0, 5),
        },
      });
      return;
    }
    const statusCode =
      typeof (error as { statusCode?: number }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    const retryAfter = (error as { retryAfter?: number }).retryAfter;
    if (retryAfter) reply.header("Retry-After", String(retryAfter));
    if (statusCode >= 500) {
      request.log.error({ err: error }, "请求处理失败");
    }
    const expose = deps.config.nodeEnv !== "production" || statusCode < 500;
    reply.code(statusCode).send({
      error: {
        code:
          typeof (error as { code?: string }).code === "string"
            ? (error as { code: string }).code
            : statusCode >= 500
              ? "INTERNAL_ERROR"
              : "REQUEST_ERROR",
        message: expose ? error.message : "服务器内部错误",
        requestId: request.id,
      },
    });
  });

  registerSessionRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerGroupRoutes(app, deps);
  registerVideoRoutes(app, deps);
  registerDownloadRoutes(app, deps);
  registerSystemRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerDemoRoutes(app, deps);

  app.addHook("onClose", async () => {
    deps.bus.closeAllSse();
  });

  app.all("/api/*", async (_request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "API 路径不存在" } });
  });

  const webIndex = resolve(deps.paths.webDist, "index.html");
  const serveWeb = existsSync(webIndex);
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: deps.paths.webDist,
      prefix: "/",
      wildcard: true,
      index: ["index.html"],
      setHeaders: (response, filePath) => {
        if (filePath.includes("/assets/")) {
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          response.setHeader("Cache-Control", "no-cache");
        }
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404).send({ error: { code: "NOT_FOUND", message: "路径不存在" } });
      return;
    }
    if (serveWeb && (request.method === "GET" || request.method === "HEAD")) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Web 前端尚未构建。开发模式请访问 Vite 地址，或执行 pnpm build。",
      },
    });
  });

  return app;
}
