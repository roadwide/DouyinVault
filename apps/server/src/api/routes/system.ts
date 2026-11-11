import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";

const LogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function registerSystemRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/system/status", async () => {
    await deps.auth.refresh();
    return deps.health.snapshot();
  });

  app.get("/api/v1/system/unresolved", async () => {
    const rows = deps.sqlite
      .prepare(
        `SELECT m.id, m.platform_message_id, m.type, m.work_id, m.title, m.sender_name,
                m.sent_at, m.diagnostic, g.id AS group_id, g.name AS group_name, g.enabled
           FROM messages m JOIN groups g ON g.id=m.group_id
          WHERE m.status='unresolved'
          ORDER BY m.sent_at DESC LIMIT 100`,
      )
      .all() as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({
        id: row.id,
        platformMessageId: row.platform_message_id,
        type: row.type,
        workId: row.work_id,
        title: row.title,
        senderName: row.sender_name,
        sentAt: row.sent_at,
        diagnostic: row.diagnostic,
        group: { id: row.group_id, name: row.group_name, enabled: Boolean(row.enabled) },
      })),
      total: deps.ingest.unresolvedCount(),
    };
  });

  app.get("/api/v1/system/cleanup-logs", async (request) => {
    const { limit } = LogsQuery.parse(request.query);
    const rows = deps.sqlite
      .prepare("SELECT * FROM cleanup_logs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({
        id: row.id,
        videoId: row.video_id,
        videoRef: row.video_ref,
        reason: row.reason,
        freedBytes: row.freed_bytes,
        detail: row.detail,
        createdAt: row.created_at,
      })),
    };
  });
}
