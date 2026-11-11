import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { HistorySyncResult } from "@vault/core";
import { syncRuns, type schema } from "@vault/db";
import { mapLimit, now, safeErrorMessage } from "@vault/shared";
import type { AuthService } from "../auth/auth-service.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { GroupService } from "../groups/group-service.js";
import type { MessageIngestService } from "../messages/ingest-service.js";

export interface GroupSyncResult {
  groupId: string;
  ok: boolean;
  messagesFound: number;
  messagesNew: number;
  gap: boolean;
  gapReason?: string;
  error?: string;
}

export class GroupSyncService {
  private inFlight = new Map<string, Promise<GroupSyncResult>>();

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly auth: AuthService,
    private readonly groupService: GroupService,
    private readonly ingest: MessageIngestService,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  async syncGroup(groupId: string, trigger: "manual" | "auto" | "startup" | "reconnect"): Promise<GroupSyncResult> {
    const existing = this.inFlight.get(groupId);
    if (existing) return existing;
    const task = this.runSync(groupId, trigger).finally(() => {
      this.inFlight.delete(groupId);
    });
    this.inFlight.set(groupId, task);
    return task;
  }

  private async runSync(
    groupId: string,
    trigger: "manual" | "auto" | "startup" | "reconnect",
  ): Promise<GroupSyncResult> {
    const group = this.groupService.getById(groupId);
    if (!group) throw Object.assign(new Error("群聊不存在"), { statusCode: 404 });
    if (trigger !== "manual" && !group.enabled) {
      return { groupId, ok: true, messagesFound: 0, messagesNew: 0, gap: false };
    }
    const authStatus = this.auth.getStatus(false);
    const authenticated =
      authStatus.status === "CONNECTED" || authStatus.status === "DISCONNECTED" || authStatus.status === "RECONNECTING";
    if (!authenticated) {
      const message = "抖音账号未连接，无法补拉历史消息";
      if (trigger === "manual") {
        throw Object.assign(new Error(message), { statusCode: 409 });
      }
      this.groupService.markSyncFailure(groupId, message);
      return { groupId, ok: false, messagesFound: 0, messagesNew: 0, gap: true, error: message };
    }

    const runId = ulid();
    const startedAt = now();
    const cursorBefore = group.syncCursor;
    this.db
      .insert(syncRuns)
      .values({
        id: runId,
        groupId,
        startedAt,
        status: "running",
        messagesFound: 0,
        messagesNew: 0,
        cursorBefore,
        gap: false,
        createdAt: startedAt,
      })
      .run();
    this.groupService.markSyncStart(groupId);

    try {
      const result = await this.auth.syncHistory(group.platformGroupId, cursorBefore ?? undefined);
      let messagesNew = 0;
      for (const message of result.messages) {
        const ingested = await this.ingest.ingest({ ...message, accountId: group.accountId });
        if (ingested.outcome === "resolved" || ingested.outcome === "unresolved") {
          messagesNew += 1;
        }
      }
      const finishedAt = now();
      const status = result.gap ? "gap" : "ok";
      this.db
        .update(syncRuns)
        .set({
          finishedAt,
          status,
          messagesFound: result.messages.length,
          messagesNew,
          cursorAfter: result.nextCursor ?? cursorBefore,
          gap: result.gap,
          gapReason: result.gapReason ?? null,
        })
        .where(eq(syncRuns.id, runId))
        .run();
      this.groupService.markSyncSuccess({
        groupId,
        at: finishedAt,
        cursor: result.nextCursor ?? cursorBefore,
        gap: result.gap,
        gapReason: result.gapReason,
      });
      this.auth.markSyncSucceeded(finishedAt);
      this.bus.publish("group.status_changed", {
        groupId,
        synced: true,
        messagesNew,
        gap: result.gap,
        trigger,
      });
      this.logger.info(
        { groupId, trigger, found: result.messages.length, new: messagesNew, gap: result.gap },
        "群聊同步完成",
      );
      return {
        groupId,
        ok: true,
        messagesFound: result.messages.length,
        messagesNew,
        gap: result.gap,
        gapReason: result.gapReason,
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      const finishedAt = now();
      this.db
        .update(syncRuns)
        .set({ finishedAt, status: "error", error: message, cursorAfter: cursorBefore })
        .where(eq(syncRuns.id, runId))
        .run();
      this.groupService.markSyncFailure(groupId, message);
      this.logger.error({ groupId, trigger, error: message }, "群聊同步失败");
      if (trigger === "manual") {
        throw Object.assign(new Error(message), { statusCode: 502 });
      }
      return { groupId, ok: false, messagesFound: 0, messagesNew: 0, gap: true, error: message };
    }
  }

  async syncAllEnabled(
    reason: "auto" | "startup" | "reconnect" = "auto",
    concurrency = 2,
  ): Promise<GroupSyncResult[]> {
    const groups = this.groupService.enabledGroups(this.auth.accountId);
    if (groups.length === 0) return [];
    return mapLimit(groups, concurrency, (group) => this.syncGroup(group.id, reason));
  }

  lastRun(groupId: string) {
    return (
      this.db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.groupId, groupId))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1)
        .get() ?? null
    );
  }

  async refreshGroupList(): Promise<number> {
    const infos = await this.auth.listGroups();
    this.groupService.upsertGroups(this.auth.accountId, infos);
    return infos.length;
  }
}
