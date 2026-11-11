import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";

const PatchGroupBody = z.object({ enabled: z.boolean() });

export function registerGroupRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/groups", async () => {
    await deps.auth.refresh();
    const auth = deps.auth.getStatus(false);
    return {
      items: deps.groups.list(deps.auth.accountId),
      auth: {
        status: auth.status,
        connected: auth.status === "CONNECTED",
        adapter: auth.adapter,
        lastSuccessfulSyncAt: auth.lastSuccessfulSyncAt,
      },
    };
  });

  app.post("/api/v1/groups/refresh", async () => {
    if (deps.auth.getStatus(false).status !== "CONNECTED") {
      throw Object.assign(new Error("抖音账号未连接"), { statusCode: 409 });
    }
    const count = await deps.groupSync.refreshGroupList();
    return { syncedGroups: count, items: deps.groups.list(deps.auth.accountId) };
  });

  app.patch<{ Params: { id: string } }>("/api/v1/groups/:id", async (request) => {
    const body = PatchGroupBody.parse(request.body);
    const auth = deps.auth.getStatus(false);
    const group = deps.groups.setEnabled(request.params.id, body.enabled, auth.status === "CONNECTED");
    if (!group) throw Object.assign(new Error("群聊不存在"), { statusCode: 404 });
    if (body.enabled && auth.status === "CONNECTED") {
      void deps.groupSync
        .syncGroup(group.id, "manual")
        .catch((error) => deps.logger.warn({ error, groupId: group.id }, "启用群聊后的首次同步失败"));
    }
    return { item: group, syncStarted: body.enabled && auth.status === "CONNECTED" };
  });

  app.post<{ Params: { id: string } }>("/api/v1/groups/:id/sync", async (request) => {
    const result = await deps.groupSync.syncGroup(request.params.id, "manual");
    return { result, item: deps.groups.list(deps.auth.accountId).find((item) => item.id === request.params.id) ?? null };
  });
}
