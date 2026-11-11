import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MockMessageSource } from "@vault/im-adapters";
import type { ApiDeps } from "../deps.js";

const DemoMessageBody = z.object({
  groupId: z.string().min(1).max(64).optional(),
  senderName: z.string().max(60).optional(),
  title: z.string().max(200).optional(),
  workId: z.string().regex(/^\d{8,32}$/).optional(),
  shareUrl: z.string().url().max(500).optional(),
});

export function registerDemoRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/api/v1/demo/messages", async (request) => {
    if (!deps.config.demoMode || deps.config.imAdapter !== "mock") {
      throw Object.assign(new Error("演示接口未启用"), { statusCode: 404 });
    }
    if (!(deps.auth.sourceRef instanceof MockMessageSource)) {
      throw Object.assign(new Error("当前不是演示适配器"), { statusCode: 400 });
    }
    const body = DemoMessageBody.parse(request.body);
    const message = await (deps.auth.sourceRef as MockMessageSource).publish({
      groupId: body.groupId,
      senderName: body.senderName,
      title: body.title,
      workId: body.workId,
      shareUrl: body.shareUrl,
    });
    return { ok: true, messageId: message.messageId, type: message.type, workId: message.workId ?? null };
  });
}
