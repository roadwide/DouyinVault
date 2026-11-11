import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = integer("created_at", { mode: "number" }).notNull();
const updatedAt = integer("updated_at", { mode: "number" }).notNull();

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull().default("douyin"),
    platformUid: text("platform_uid"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("LOGIN_REQUIRED"),
    adapter: text("adapter").notNull().default("mock"),
    lastConnectedAt: integer("last_connected_at", { mode: "number" }),
    lastMessageAt: integer("last_message_at", { mode: "number" }),
    lastSuccessfulSyncAt: integer("last_successful_sync_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("accounts_platform_uid_unique")
      .on(table.platform, table.platformUid)
      .where(sql`${table.platformUid} IS NOT NULL`),
  ],
);

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    platformGroupId: text("platform_group_id").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    memberCount: integer("member_count"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    syncCursor: text("sync_cursor"),
    lastMessageAt: integer("last_message_at", { mode: "number" }),
    lastSuccessfulSyncAt: integer("last_successful_sync_at", { mode: "number" }),
    lastSyncGapAt: integer("last_sync_gap_at", { mode: "number" }),
    lastSyncGapReason: text("last_sync_gap_reason"),
    status: text("status").notNull().default("paused"),
    lastError: text("last_error"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("groups_account_platform_unique").on(table.accountId, table.platformGroupId),
    index("groups_enabled_idx").on(table.enabled),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    platformMessageId: text("platform_message_id").notNull(),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    sentAt: integer("sent_at", { mode: "number" }).notNull(),
    receivedAt: integer("received_at", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    workId: text("work_id"),
    shareUrl: text("share_url"),
    title: text("title"),
    coverUrl: text("cover_url"),
    authorName: text("author_name"),
    source: text("source").notNull(),
    status: text("status").notNull(),
    diagnostic: text("diagnostic"),
    createdAt,
  },
  (table) => [
    uniqueIndex("messages_group_platform_unique").on(table.groupId, table.platformMessageId),
    index("messages_work_idx").on(table.workId),
    index("messages_sent_idx").on(table.sentAt),
    index("messages_status_idx").on(table.status),
  ],
);

export const videos = sqliteTable(
  "videos",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull().default("douyin"),
    workId: text("work_id"),
    mediaKey: text("media_key").notNull(),
    title: text("title"),
    authorName: text("author_name"),
    authorId: text("author_id"),
    filePath: text("file_path"),
    coverPath: text("cover_path"),
    fileSize: integer("file_size", { mode: "number" }),
    durationSeconds: real("duration_seconds"),
    width: integer("width", { mode: "number" }),
    height: integer("height", { mode: "number" }),
    sha256: text("sha256"),
    status: text("status").notNull().default("pending"),
    isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
    createdAt,
    downloadedAt: integer("downloaded_at", { mode: "number" }),
    deletedAt: integer("deleted_at", { mode: "number" }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    updatedAt,
  },
  (table) => [
    uniqueIndex("videos_media_key_unique").on(table.mediaKey),
    uniqueIndex("videos_platform_work_unique")
      .on(table.platform, table.workId)
      .where(sql`${table.workId} IS NOT NULL`),
    index("videos_status_idx").on(table.status),
    index("videos_sha_idx").on(table.sha256),
    index("videos_created_idx").on(table.createdAt),
  ],
);

export const videoShares = sqliteTable(
  "video_shares",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sharedAt: integer("shared_at", { mode: "number" }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("video_shares_video_message_unique").on(table.videoId, table.messageId),
    uniqueIndex("video_shares_message_unique").on(table.messageId),
    index("video_shares_video_idx").on(table.videoId),
  ],
);

export const downloadJobs = sqliteTable(
  "download_jobs",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("PENDING"),
    priority: integer("priority").notNull().default(2),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextRetryAt: integer("next_retry_at", { mode: "number" }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "number" }),
    progress: real("progress").notNull().default(0),
    downloadedBytes: integer("downloaded_bytes", { mode: "number" }),
    totalBytes: integer("total_bytes", { mode: "number" }),
    speedBps: integer("speed_bps", { mode: "number" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    source: text("source").notNull().default("history"),
    createdAt,
    updatedAt,
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("download_jobs_video_unique").on(table.videoId),
    index("download_jobs_status_idx").on(table.status, table.priority, table.nextRetryAt),
    index("download_jobs_lease_idx").on(table.leaseExpiresAt),
  ],
);

export const videoProgress = sqliteTable("video_progress", {
  videoId: text("video_id")
    .primaryKey()
    .references(() => videos.id, { onDelete: "cascade" }),
  positionSeconds: real("position_seconds").notNull().default(0),
  durationSeconds: real("duration_seconds"),
  isWatched: integer("is_watched", { mode: "boolean" }).notNull().default(false),
  watchedAt: integer("watched_at", { mode: "number" }),
  lastPlayedAt: integer("last_played_at", { mode: "number" }),
  updatedAt,
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt,
});

export const cleanupLogs = sqliteTable(
  "cleanup_logs",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id").references(() => videos.id, { onDelete: "set null" }),
    videoRef: text("video_ref"),
    reason: text("reason").notNull(),
    freedBytes: integer("freed_bytes", { mode: "number" }).notNull().default(0),
    detail: text("detail"),
    createdAt,
  },
  (table) => [index("cleanup_logs_created_idx").on(table.createdAt)],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    startedAt: integer("started_at", { mode: "number" }).notNull(),
    finishedAt: integer("finished_at", { mode: "number" }),
    status: text("status").notNull(),
    messagesFound: integer("messages_found", { mode: "number" }).notNull().default(0),
    messagesNew: integer("messages_new", { mode: "number" }).notNull().default(0),
    cursorBefore: text("cursor_before"),
    cursorAfter: text("cursor_after"),
    gap: integer("gap", { mode: "boolean" }).notNull().default(false),
    gapReason: text("gap_reason"),
    error: text("error"),
    createdAt,
  },
  (table) => [index("sync_runs_group_idx").on(table.groupId, table.startedAt)],
);

/** Admin auth sessions. Only a SHA-256 digest of the opaque cookie token is stored. */
export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    csrfToken: text("csrf_token").notNull(),
    createdAt,
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "number" }).notNull(),
    userAgent: text("user_agent"),
  },
  (table) => [uniqueIndex("admin_sessions_token_unique").on(table.tokenHash)],
);

export const schema = {
  accounts,
  groups,
  messages,
  videos,
  videoShares,
  downloadJobs,
  videoProgress,
  settings,
  cleanupLogs,
  syncRuns,
  adminSessions,
};

export type AccountRow = typeof accounts.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type VideoRow = typeof videos.$inferSelect;
export type DownloadJobRow = typeof downloadJobs.$inferSelect;
export type ProgressRow = typeof videoProgress.$inferSelect;
export type SyncRunRow = typeof syncRuns.$inferSelect;
export type CleanupLogRow = typeof cleanupLogs.$inferSelect;
