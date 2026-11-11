import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";

const ListQuery = z.object({
  status: z
    .enum([
      "PENDING",
      "RESOLVING",
      "DOWNLOADING",
      "VERIFYING",
      "COMPLETED",
      "RETRY_WAIT",
      "FAILED",
      "PAUSED",
      "CANCELED",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerDownloadRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/downloads", async (request) => {
    const query = ListQuery.parse(request.query);
    const result = deps.worker.listJobs(query.status, query.limit, query.offset);
    return {
      ...result,
      worker: deps.worker.state,
      pausedReason: deps.worker.pausedReason(),
    };
  });

  app.post("/api/v1/downloads/retry-failed", async () => {
    const result = deps.worker.retryAllFailed();
    deps.bus.publish("system.status_changed", { reason: "manual_retry_all", count: result.count });
    return result;
  });

  app.post<{ Params: { id: string } }>("/api/v1/downloads/:id/retry", async (request) => {
    const result = deps.worker.retryJob(request.params.id);
    deps.bus.publish("system.status_changed", { reason: "manual_retry" });
    return result;
  });
}
