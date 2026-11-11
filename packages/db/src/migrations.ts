export interface Migration {
  id: string;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001",
    name: "init",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY NOT NULL,
        platform TEXT NOT NULL DEFAULT 'douyin',
        platform_uid TEXT,
        display_name TEXT,
        avatar_url TEXT,
        status TEXT NOT NULL DEFAULT 'LOGIN_REQUIRED',
        adapter TEXT NOT NULL DEFAULT 'mock',
        last_connected_at INTEGER,
        last_message_at INTEGER,
        last_successful_sync_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_platform_uid_unique
        ON accounts (platform, platform_uid) WHERE platform_uid IS NOT NULL;

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        platform_group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar_url TEXT,
        member_count INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0,
        sync_cursor TEXT,
        last_message_at INTEGER,
        last_successful_sync_at INTEGER,
        last_sync_gap_at INTEGER,
        last_sync_gap_reason TEXT,
        status TEXT NOT NULL DEFAULT 'paused',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS groups_account_platform_unique
        ON groups (account_id, platform_group_id);
      CREATE INDEX IF NOT EXISTS groups_enabled_idx ON groups (enabled);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        platform_message_id TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        sent_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        work_id TEXT,
        share_url TEXT,
        title TEXT,
        cover_url TEXT,
        author_name TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        diagnostic TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_group_platform_unique
        ON messages (group_id, platform_message_id);
      CREATE INDEX IF NOT EXISTS messages_work_idx ON messages (work_id);
      CREATE INDEX IF NOT EXISTS messages_sent_idx ON messages (sent_at);
      CREATE INDEX IF NOT EXISTS messages_status_idx ON messages (status);

      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY NOT NULL,
        platform TEXT NOT NULL DEFAULT 'douyin',
        work_id TEXT,
        media_key TEXT NOT NULL,
        title TEXT,
        author_name TEXT,
        author_id TEXT,
        file_path TEXT,
        cover_path TEXT,
        file_size INTEGER,
        duration_seconds REAL,
        width INTEGER,
        height INTEGER,
        sha256 TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        is_favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        downloaded_at INTEGER,
        deleted_at INTEGER,
        last_error_code TEXT,
        last_error_message TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS videos_media_key_unique ON videos (media_key);
      CREATE UNIQUE INDEX IF NOT EXISTS videos_platform_work_unique
        ON videos (platform, work_id) WHERE work_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS videos_status_idx ON videos (status);
      CREATE INDEX IF NOT EXISTS videos_sha_idx ON videos (sha256);
      CREATE INDEX IF NOT EXISTS videos_created_idx ON videos (created_at);

      CREATE TABLE IF NOT EXISTS video_shares (
        id TEXT PRIMARY KEY NOT NULL,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        shared_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS video_shares_video_message_unique
        ON video_shares (video_id, message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS video_shares_message_unique
        ON video_shares (message_id);
      CREATE INDEX IF NOT EXISTS video_shares_video_idx ON video_shares (video_id);

      CREATE TABLE IF NOT EXISTS download_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'PENDING',
        priority INTEGER NOT NULL DEFAULT 2,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_retry_at INTEGER,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        progress REAL NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER,
        total_bytes INTEGER,
        speed_bps INTEGER,
        error_code TEXT,
        error_message TEXT,
        source TEXT NOT NULL DEFAULT 'history',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS download_jobs_video_unique ON download_jobs (video_id);
      CREATE INDEX IF NOT EXISTS download_jobs_status_idx
        ON download_jobs (status, priority, next_retry_at);
      CREATE INDEX IF NOT EXISTS download_jobs_lease_idx ON download_jobs (lease_expires_at);

      CREATE TABLE IF NOT EXISTS video_progress (
        video_id TEXT PRIMARY KEY NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        position_seconds REAL NOT NULL DEFAULT 0,
        duration_seconds REAL,
        is_watched INTEGER NOT NULL DEFAULT 0,
        watched_at INTEGER,
        last_played_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cleanup_logs (
        id TEXT PRIMARY KEY NOT NULL,
        video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
        video_ref TEXT,
        reason TEXT NOT NULL,
        freed_bytes INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cleanup_logs_created_idx ON cleanup_logs (created_at);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY NOT NULL,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        messages_found INTEGER NOT NULL DEFAULT 0,
        messages_new INTEGER NOT NULL DEFAULT 0,
        cursor_before TEXT,
        cursor_after TEXT,
        gap INTEGER NOT NULL DEFAULT 0,
        gap_reason TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_runs_group_idx ON sync_runs (group_id, started_at);

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        token_hash TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_token_unique ON admin_sessions (token_hash);
    `,
  },
];
