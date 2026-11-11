import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../deps.js";

export function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/auth/status", async () => {
    await deps.auth.refresh();
    return deps.auth.getStatus(false);
  });

  app.post("/api/v1/auth/login", async () => {
    const challenge = await deps.auth.startLogin();
    await deps.auth.refresh();
    return {
      challenge,
      status: deps.auth.getStatus(false),
    };
  });

  app.post("/api/v1/auth/demo/complete", async () => {
    await deps.auth.completeDemoLogin();
    return { status: deps.auth.getStatus(false) };
  });

  app.post("/api/v1/auth/refresh", async () => {
    await deps.auth.refresh(true);
    return { status: deps.auth.getStatus(false) };
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    await deps.auth.logout();
    reply.code(204).send();
  });
}
