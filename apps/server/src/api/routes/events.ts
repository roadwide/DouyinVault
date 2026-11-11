import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../deps.js";

export function registerEventRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    reply.raw.write("retry: 5000\n\n");

    const send = (event: { type: string; at: number; data: Record<string, unknown> }) => {
      if (reply.raw.writableEnded) return;
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected.
      }
    };
    send({
      type: "system.status_changed",
      at: Date.now(),
      data: { snapshot: deps.health.snapshot() },
    });
    const unsubscribe = deps.bus.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      unregisterSse();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const unregisterSse = deps.bus.registerSse(close);
    request.raw.on("close", close);
    request.raw.on("error", close);
  });
}
