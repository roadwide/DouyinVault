import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { GroupInfo, GroupStatus } from "@vault/core";
import { groups, messages, syncRuns, videoShares, videos, type GroupRow, type schema } from "@vault/db";
import { now } from "@vault/shared";
import type { EventBus } from "../events.js";

export interface GroupView {
  id: string;
  accountId: string;
  platformGroupId: string;
  name: string;
  avatarUrl: string | null;
  memberCount: number | null;
  enabled: boolean;
  status: GroupStatus;
  lastMessageAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSyncGapAt: number | null;
  lastSyncGapReason: string | null;
  lastError: string | null;
  cachedVideoCount: number;
  lastSyncStatus: string | null;
}

export class GroupService {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly bus: EventBus,
  ) {}

  upsertGroups(accountId: string, infos: GroupInfo[]): void {
    const timestamp = now();
    this.db.transaction((tx) => {
      for (const info of infos) {
        const existing = tx
          .select()
          .from(groups)
          .where(
            and(eq(groups.accountId, accountId), eq(groups.platformGroupId, info.platformGroupId)),
          )
          .get();
        if (existing) {
          tx.update(groups)
            .set({
              name: info.name,
              avatarUrl: info.avatarUrl ?? null,
              memberCount: info.memberCount ?? null,
              updatedAt: timestamp,
            })
            .where(eq(groups.id, existing.id))
            .run();
        } else {
          tx.insert(groups)
            .values({
              id: ulid(),
              accountId,
              platformGroupId: info.platformGroupId,
              name: info.name,
              avatarUrl: info.avatarUrl ?? null,
              memberCount: info.memberCount ?? null,
              enabled: false,
              status: "paused",
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .run();
        }
      }
    });
    this.bus.publish("group.status_changed", { reason: "groups_synced", count: infos.length });
  }

  list(accountId: string): GroupView[] {
    const rows = this.db
      .select()
      .from(groups)
      .where(eq(groups.accountId, accountId))
      .orderBy(desc(groups.enabled), desc(groups.lastMessageAt), groups.name)
      .all();
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const counts = this.db
      .select({
        groupId: messages.groupId,
        count: sql<number>`count(distinct ${videoShares.videoId})`,
      })
      .from(videoShares)
      .innerJoin(messages, eq(messages.id, videoShares.messageId))
      .innerJoin(videos, eq(videos.id, videoShares.videoId))
      .where(and(inArray(messages.groupId, ids), eq(videos.status, "ready")))
      .groupBy(messages.groupId)
      .all();
    const countMap = new Map(counts.map((row) => [row.groupId, Number(row.count)]));
    const latestRuns = this.db
      .select()
      .from(syncRuns)
      .where(inArray(syncRuns.groupId, ids))
      .orderBy(desc(syncRuns.startedAt))
      .all();
    const runMap = new Map<string, (typeof latestRuns)[number]>();
    for (const run of latestRuns) {
      if (!runMap.has(run.groupId)) runMap.set(run.groupId, run);
    }
    const messageTimes = this.db
      .select({ groupId: messages.groupId, last: sql<number>`max(${messages.sentAt})` })
      .from(messages)
      .where(inArray(messages.groupId, ids))
      .groupBy(messages.groupId)
      .all();
    const messageMap = new Map(messageTimes.map((row) => [row.groupId, Number(row.last)]));
    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      platformGroupId: row.platformGroupId,
      name: row.name,
      avatarUrl: row.avatarUrl,
      memberCount: row.memberCount,
      enabled: row.enabled,
      status: row.status as GroupStatus,
      lastMessageAt: Math.max(row.lastMessageAt ?? 0, messageMap.get(row.id) ?? 0) || null,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      lastSyncGapAt: row.lastSyncGapAt,
      lastSyncGapReason: row.lastSyncGapReason,
      lastError: row.lastError,
      cachedVideoCount: countMap.get(row.id) ?? 0,
      lastSyncStatus: runMap.get(row.id)?.status ?? null,
    }));
  }

  getById(id: string): GroupRow | null {
    return this.db.select().from(groups).where(eq(groups.id, id)).get() ?? null;
  }

  getByPlatformId(accountId: string, platformGroupId: string): GroupRow | null {
    return (
      this.db
        .select()
        .from(groups)
        .where(and(eq(groups.accountId, accountId), eq(groups.platformGroupId, platformGroupId)))
        .get() ?? null
    );
  }

  ensureFromMessage(accountId: string, platformGroupId: string, name?: string): GroupRow {
    const existing = this.getByPlatformId(accountId, platformGroupId);
    if (existing) return existing;
    const id = ulid();
    const timestamp = now();
    this.db
      .insert(groups)
      .values({
        id,
        accountId,
        platformGroupId,
        name: name?.trim() || "未命名群聊",
        enabled: false,
        status: "paused",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.getById(id) as GroupRow;
  }

  setEnabled(id: string, enabled: boolean, connected: boolean): GroupView | null {
    const row = this.getById(id);
    if (!row) return null;
    const status: GroupStatus = enabled ? (connected ? "active" : "paused") : "paused";
    this.db
      .update(groups)
      .set({
        enabled,
        status,
        lastError: enabled && !connected ? "等待抖音账号登录" : null,
        updatedAt: now(),
      })
      .where(eq(groups.id, id))
      .run();
    this.bus.publish("group.status_changed", { groupId: id, enabled, status });
    return this.list(row.accountId).find((item) => item.id === id) ?? null;
  }

  updateActivity(groupId: string, sentAt: number): void {
    const row = this.getById(groupId);
    if (!row) return;
    this.db
      .update(groups)
      .set({
        lastMessageAt: Math.max(row.lastMessageAt ?? 0, sentAt),
        updatedAt: now(),
      })
      .where(eq(groups.id, groupId))
      .run();
  }

  markSyncStart(groupId: string): void {
    this.bus.publish("group.status_changed", { groupId, syncing: true });
  }

  markSyncSuccess(input: {
    groupId: string;
    at: number;
    cursor: string | null;
    gap: boolean;
    gapReason?: string;
  }): void {
    const row = this.getById(input.groupId);
    if (!row) return;
    const enabled = this.getById(input.groupId)?.enabled ?? row.enabled;
    this.db
      .update(groups)
      .set({
        syncCursor: input.cursor ?? row.syncCursor,
        lastSuccessfulSyncAt: input.at,
        lastSyncGapAt: input.gap ? input.at : row.lastSyncGapAt,
        lastSyncGapReason: input.gap ? (input.gapReason ?? "同步窗口不完整") : row.lastSyncGapReason,
        status: enabled ? "active" : "paused",
        lastError: null,
        updatedAt: input.at,
      })
      .where(eq(groups.id, input.groupId))
      .run();
    this.bus.publish("group.status_changed", {
      groupId: input.groupId,
      status: enabled ? "active" : "paused",
      gap: input.gap,
    });
  }

  markSyncFailure(groupId: string, message: string): void {
    const row = this.getById(groupId);
    if (!row) return;
    this.db
      .update(groups)
      .set({
        status: "error",
        lastError: message,
        updatedAt: now(),
      })
      .where(eq(groups.id, groupId))
      .run();
    this.bus.publish("group.status_changed", { groupId, status: "error", error: message });
  }

  enabledGroups(accountId: string): GroupRow[] {
    return this.db
      .select()
      .from(groups)
      .where(and(eq(groups.accountId, accountId), eq(groups.enabled, true)))
      .all();
  }

  stats(accountId: string): { total: number; enabled: number; healthy: number; errors: number } {
    const rows = this.db.select().from(groups).where(eq(groups.accountId, accountId)).all();
    return {
      total: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      healthy: rows.filter((row) => row.enabled && (row.status === "active" || row.status === "paused")).length,
      errors: rows.filter((row) => row.status === "error" || row.status === "verify_required").length,
    };
  }
}
