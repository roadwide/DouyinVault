import { statSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { VideoFilter } from "../../media/library-service.js";
import type { ApiDeps } from "../deps.js";
import { sendFileWithRange, sendSmallFile } from "../media.js";

const ListQuery = z.object({
  filter: z.enum(["all", "unwatched", "watched", "favorites", "failed", "pending"]).default("all"),
  groupId: z.string().min(1).max(64).optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(["latest", "downloaded", "oldest", "title"]).default("latest"),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  offset: z.coerce.number().int().min(0).default(0),
  /** 1 bypasses the short availability cache; normal loads use it. */
  refresh: z.coerce.number().int().min(0).max(1).optional(),
});

const VideoQuery = z.object({
  refresh: z.coerce.number().int().min(0).max(1).optional(),
});

const UNKNOWN_AVAILABILITY = { state: "unknown" as const, checkedAt: null };

const PatchVideoBody = z
  .object({
    isFavorite: z.boolean().optional(),
    isWatched: z.boolean().optional(),
  })
  .refine((value) => value.isFavorite !== undefined || value.isWatched !== undefined, {
    message: "至少提供一个要修改的字段",
  });

const ProgressBody = z.object({
  positionSeconds: z.number().min(0).max(86_400),
  durationSeconds: z.number().min(0).max(86_400).nullable().optional(),
});

const BatchDeleteBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(100),
});

export function registerVideoRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/videos", async (request) => {
    const query = ListQuery.parse(request.query);
    const result = deps.library.list({
      filter: query.filter as VideoFilter,
      groupId: query.groupId,
      search: query.q,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });
    const availability = await deps.availability.resolve(
      result.items.map((item) => item.id),
      { force: query.refresh === 1 },
    );
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        availability: availability.get(item.id) ?? UNKNOWN_AVAILABILITY,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/videos/:id", async (request) => {
    const query = VideoQuery.parse(request.query);
    const video = deps.library.getById(request.params.id);
    if (!video) throw Object.assign(new Error("视频不存在"), { statusCode: 404 });
    const availability = await deps.availability.resolve([video.id], {
      force: query.refresh === 1,
    });
    return {
      item: {
        ...video,
        availability: availability.get(video.id) ?? UNKNOWN_AVAILABILITY,
      },
    };
  });

  app.patch<{ Params: { id: string } }>("/api/v1/videos/:id", async (request) => {
    const body = PatchVideoBody.parse(request.body);
    const video = deps.library.update(request.params.id, body);
    const availability = await deps.availability.resolve([video.id]);
    return {
      item: {
        ...video,
        availability: availability.get(video.id) ?? UNKNOWN_AVAILABILITY,
      },
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/videos/:id/progress", async (request) => {
    const body = ProgressBody.parse(request.body);
    const progress = deps.library.updateProgress(request.params.id, {
      positionSeconds: body.positionSeconds,
      durationSeconds: body.durationSeconds ?? null,
    });
    return { progress };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/videos/:id", async (request) => {
    const result = deps.library.delete(request.params.id, "manual");
    return result;
  });

  app.post("/api/v1/videos/batch-delete", async (request) => {
    const body = BatchDeleteBody.parse(request.body);
    return deps.library.deleteMany(body.ids, "manual");
  });

  const streamHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const info = deps.library.getStreamInfo(request.params.id);
    await sendFileWithRange(request, reply, info);
  };
  // Fastify registers HEAD for GET automatically; the handler emits headers only.
  app.get<{ Params: { id: string } }>("/api/v1/videos/:id/stream", streamHandler);

  app.get<{ Params: { id: string } }>("/api/v1/videos/:id/cover", async (request, reply) => {
    const info = deps.library.getCoverInfo(request.params.id);
    if (!info) throw Object.assign(new Error("封面不存在"), { statusCode: 404 });
    await sendSmallFile(request, reply, {
      ...info,
      etag: `"cover-${info.size}-${Math.floor(info.mtimeMs)}"`,
    });
  });
}
