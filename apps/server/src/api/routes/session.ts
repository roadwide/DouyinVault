import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";

const LoginBody = z.object({
  password: z.string().min(1).max(500),
});

const SetupBody = z.object({
  token: z.string().min(8).max(500),
  password: z.string().min(10).max(500),
});

export function registerSessionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/session", async (request) => {
    return deps.adminAuth.sessionInfo(request);
  });

  app.post("/api/v1/session/setup", async (request, reply) => {
    const body = SetupBody.parse(request.body);
    const session = deps.adminAuth.completeSetup(body, request.ip);
    deps.adminAuth.setSessionCookie(reply, session, request);
    deps.bus.publish("system.status_changed", { reason: "admin_setup_complete" });
    return {
      ok: true,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  });

  app.post("/api/v1/session/login", async (request, reply) => {
    const body = LoginBody.parse(request.body);
    const session = deps.adminAuth.login(body.password, request.ip, request.headers["user-agent"]);
    deps.adminAuth.setSessionCookie(reply, session, request);
    return {
      ok: true,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  });

  app.post("/api/v1/session/logout", async (request, reply) => {
    deps.adminAuth.logout(request, reply);
    reply.code(204).send();
  });
}
