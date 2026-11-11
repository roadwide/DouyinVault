import { createHash } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  isDouyinUrl,
  isValidWorkId,
  mediaKeyForMessage,
  mediaKeyForWork,
  priorityForSource,
  type NormalizedMessage,
} from "@vault/core";
import {
  downloadJobs,
  messages,
  videoShares,
  videos,
  type MessageRow,
  type schema,
  type VideoRow,
} from "@vault/db";
import { now, truncate } from "@vault/shared";
import type { AuthService } from "../auth/auth-service.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { SettingsService } from "../settings/service.js";
import type { GroupService } from "../groups/group-service.js";
import type { MediaUrlCache } from "./media-cache.js";

export interface IngestResult {
  outcome: "ignored" | "duplicate" | "resolved" | "unresolved";
  messageId: string | null;
  videoId: string | null;
  jobId: string | null;
  newVideo: boolean;
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "message";
}

export class MessageIngestService {
  private onEnqueued: (() => void) | null = null;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly settings: SettingsService,
    private readonly groupService: GroupService,
    private readonly auth: AuthService,
    private readonly bus: EventBus,
    private readonly mediaCache: MediaUrlCache,
    private readonly logger: Logger,
  ) {}

  setOnEnqueued(callback: () => void): void {
    this.onEnqueued = callback;
  }

  async ingest(message: NormalizedMessage): Promise<IngestResult> {
    const result = this.ingestSync(message);
    if (result.outcome === "resolved" && result.videoId) {
      this.bus.publish("message.detected", {
        groupId: message.groupId,
        messageId: result.messageId,
        videoId: result.videoId,
        workId: message.workId ?? null,
        type: message.type,
      });
      this.onEnqueued?.();
    }
    return result;
  }

  private ingestSync(message: NormalizedMessage): IngestResult {
    if (!message.accountId || !message.groupId) {
      return { outcome: "ignored", messageId: null, videoId: null, jobId: null, newVideo: false };
    }
    const group = this.groupService.ensureFromMessage(
      message.accountId,
      message.groupId,
      message.groupName,
    );
    this.groupService.updateActivity(group.id, message.sentAt);
    this.auth.markMessageReceived(message.receivedAt);
    if (!group.enabled) {
      return { outcome: "ignored", messageId: null, videoId: null, jobId: null, newVideo: false };
    }

    const isUnresolvedCard =
      message.type === "unknown" &&
      Boolean(message.diagnostic && /UNRESOLVED|作品卡片|Work card/i.test(message.diagnostic));
    const isVideo =
      message.type === "shared_work" || message.type === "chat_video" || message.type === "text_with_url";
    if (!isVideo && !isUnresolvedCard) {
      return { outcome: "ignored", messageId: null, videoId: null, jobId: null, newVideo: false };
    }

    const platformMessageId =
      message.messageId?.trim() ||
      createHash("sha1")
        .update(`${message.groupId}|${message.sentAt}|${message.senderId ?? ""}|${message.title ?? ""}`)
        .digest("hex");
    const existing = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.groupId, group.id), eq(messages.platformMessageId, platformMessageId)))
      .get();
    if (existing) {
      return {
        outcome: "duplicate",
        messageId: existing.id,
        videoId: null,
        jobId: null,
        newVideo: false,
      };
    }

    const workId = isValidWorkId(message.workId) ? message.workId : null;
    const canResolve =
      Boolean(workId) ||
      (message.type === "chat_video" && Boolean(message.mediaUrl));
    const title = message.title ? truncate(message.title.trim(), 200) : null;
    const authorName = message.authorName ? truncate(message.authorName.trim(), 120) : null;
    const shareUrl = message.shareUrl && isDouyinUrl(message.shareUrl) ? message.shareUrl : null;
    const diagnostic = message.diagnostic ? truncate(message.diagnostic, 500) : null;
    const timestamp = now();
    const messageRowId = ulid();
    const maxAttempts = this.settings.get().download.maxAttempts;

    let videoId: string | null = null;
    let jobId: string | null = null;
    let newVideo = false;

    this.db.transaction((tx) => {
      tx.insert(messages)
        .values({
          id: messageRowId,
          accountId: message.accountId,
          groupId: group.id,
          platformMessageId,
          senderId: message.senderId ?? null,
          senderName: message.senderName ?? null,
          sentAt: message.sentAt,
          receivedAt: message.receivedAt,
          type: message.type,
          workId,
          shareUrl,
          title,
          coverUrl: message.coverUrl ?? null,
          authorName,
          source: message.source,
          status: canResolve ? "resolved" : "unresolved",
          diagnostic,
          createdAt: timestamp,
        })
        .run();

      if (!canResolve) {
        return;
      }

      const mediaKey = workId
        ? mediaKeyForWork(workId)
        : mediaKeyForMessage(`${message.accountId}:${platformMessageId}`);
      let video = workId
        ? tx
            .select()
            .from(videos)
            .where(and(eq(videos.platform, "douyin"), eq(videos.workId, workId)))
            .get()
        : tx.select().from(videos).where(eq(videos.mediaKey, mediaKey)).get();
      if (!video) {
        video = tx.select().from(videos).where(eq(videos.mediaKey, mediaKey)).get();
      }
      if (!video) {
        newVideo = true;
        video = {
          id: ulid(),
          platform: "douyin",
          workId,
          mediaKey,
          title,
          authorName,
          authorId: null,
          filePath: null,
          coverPath: null,
          fileSize: null,
          durationSeconds: null,
          width: null,
          height: null,
          sha256: null,
          status: "pending",
          isFavorite: false,
          createdAt: timestamp,
          downloadedAt: null,
          deletedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: timestamp,
        } satisfies VideoRow;
        tx.insert(videos).values(video).run();
      } else {
        const wasFailed = video.status === "failed";
        const patch: Partial<VideoRow> = { updatedAt: timestamp };
        if (!video.title && title) patch.title = title;
        if (!video.authorName && authorName) patch.authorName = authorName;
        if (wasFailed) {
          patch.status = "pending";
          patch.lastErrorCode = null;
          patch.lastErrorMessage = null;
        }
        if (Object.keys(patch).length > 0) {
          tx.update(videos)
            .set(patch)
            .where(eq(videos.id, video.id))
            .run();
        }
        if (wasFailed) {
          tx.update(downloadJobs)
            .set({
              status: "PENDING",
              priority: priorityForSource(message.source),
              attempts: 0,
              nextRetryAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              errorCode: null,
              errorMessage: null,
              progress: 0,
              downloadedBytes: null,
              totalBytes: null,
              speedBps: null,
              finishedAt: null,
              updatedAt: timestamp,
            })
            .where(eq(downloadJobs.videoId, video.id))
            .run();
        }
      }

      tx.insert(videoShares)
        .values({
          id: ulid(),
          videoId: video.id,
          messageId: messageRowId,
          sharedAt: message.sentAt,
          createdAt: timestamp,
        })
        .onConflictDoNothing()
        .run();

      const existingJob = tx
        .select()
        .from(downloadJobs)
        .where(eq(downloadJobs.videoId, video.id))
        .get();
      if (!existingJob) {
        const job = {
          id: ulid(),
          videoId: video.id,
          status: "PENDING" as const,
          priority: priorityForSource(message.source),
          attempts: 0,
          maxAttempts,
          nextRetryAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          progress: 0,
          downloadedBytes: null,
          totalBytes: null,
          speedBps: null,
          errorCode: null,
          errorMessage: null,
          source: message.source,
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: null,
          finishedAt: null,
        };
        tx.insert(downloadJobs).values(job).run();
        jobId = job.id;
      } else {
        jobId = existingJob.id;
      }
      videoId = video.id;
    });

    if (message.mediaUrl) {
      this.mediaCache.set(messageRowId, message.mediaUrl);
      if (videoId) this.mediaCache.setForVideo(videoId, message.mediaUrl);
    }
    if (!videoId) {
      this.bus.publish("message.detected", {
        groupId: message.groupId,
        messageId: messageRowId,
        unresolved: true,
        type: message.type,
      });
      this.logger.warn(
        { groupId: group.id, messageId: messageRowId, type: message.type },
        "收到无法解析的视频消息，已保留诊断记录。",
      );
      return {
        outcome: "unresolved",
        messageId: messageRowId,
        videoId: null,
        jobId: null,
        newVideo: false,
      };
    }

    return {
      outcome: "resolved",
      messageId: messageRowId,
      videoId,
      jobId,
      newVideo,
    };
  }

  /** Latest share metadata for a video job (used for resolver fallback). */
  latestMessageForVideo(videoId: string): MessageRow | null {
    const share = this.db
      .select()
      .from(videoShares)
      .where(eq(videoShares.videoId, videoId))
      .orderBy(videoShares.sharedAt)
      .all()
      .at(-1);
    if (!share) return null;
    return this.db.select().from(messages).where(eq(messages.id, share.messageId)).get() ?? null;
  }

  unresolvedCount(): number {
    return this.db.select().from(messages).where(eq(messages.status, "unresolved")).all().length;
  }

  safeId(value: string): string {
    return safeIdPart(value);
  }
}
