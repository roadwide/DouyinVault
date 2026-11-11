export type AccountStatus =
  | "UNCONFIGURED"
  | "LOGIN_REQUIRED"
  | "AUTHENTICATING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "VERIFY_REQUIRED"
  | "LOGGED_OUT";

export interface LoginChallenge {
  kind: "qr" | "verification" | "none";
  qrDataUrl?: string;
  verificationUrl?: string;
  expiresAt?: number;
  hint?: string;
}

export interface AuthStatus {
  accountId: string;
  adapter: string;
  status: AccountStatus;
  platformUid: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastError: string | null;
  challenge: LoginChallenge | null;
  setupRequired: boolean;
}

export type GroupStatus = "active" | "paused" | "error" | "verify_required";

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

export type VideoStatus = "pending" | "ready" | "failed" | "deleted" | "deleting";

export type VideoAvailabilityState = "available" | "unavailable" | "unknown";

export interface VideoAvailability {
  state: VideoAvailabilityState;
  checkedAt: number | null;
}

export interface VideoView {
  id: string;
  title: string | null;
  authorName: string | null;
  workId: string | null;
  status: VideoStatus;
  fileSize: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  createdAt: number;
  downloadedAt: number | null;
  isFavorite: boolean;
  isWatched: boolean;
  watchedAt: number | null;
  positionSeconds: number;
  lastPlayedAt: number | null;
  latestSharedAt: number;
  shareCount: number;
  hasCover: boolean;
  coverUrl: string | null;
  streamUrl: string | null;
  latestGroup: { id: string; name: string } | null;
  latestSender: string | null;
  lastError: { code: string; message: string } | null;
  /** Present on list/detail responses; unknown when the platform cannot be queried. */
  availability?: VideoAvailability;
}

export interface VideoShare {
  id: string;
  groupId: string;
  groupName: string;
  senderId: string | null;
  senderName: string | null;
  sharedAt: number;
  shareUrl: string | null;
}

export interface VideoJob {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: number | null;
  updatedAt: number;
}

export interface VideoDetail extends VideoView {
  sha256: string | null;
  shares: VideoShare[];
  job: VideoJob | null;
}

export interface VideoListResponse {
  items: VideoView[];
  total: number;
  limit: number;
  offset: number;
}

export interface HealthIssue {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface SystemSnapshot {
  generatedAt: number;
  version: string;
  uptimeSeconds: number;
  status: "ok" | "degraded" | "error";
  database: { ok: boolean; schemaReady: boolean };
  auth: {
    status: AccountStatus;
    adapter: string;
    connected: boolean;
    displayName: string | null;
    platformUid: string | null;
    lastConnectedAt: number | null;
    lastMessageAt: number | null;
    lastSuccessfulSyncAt: number | null;
    lastError: string | null;
  };
  groups: { total: number; enabled: number; healthy: number; errors: number };
  videos: {
    total: number;
    ready: number;
    pending: number;
    failed: number;
    unwatched: number;
    favorites: number;
  };
  downloads: {
    pending: number;
    active: number;
    retryWaiting: number;
    failed: number;
    completed: number;
    pausedReason: string | null;
    activeCount: number;
    concurrency: number;
  };
  storage: {
    usedBytes: number;
    capacityBytes: number;
    freeBytes: number;
    safetyReserveBytes: number;
    percent: number;
    overCapacity: boolean;
    diskLow: boolean;
  };
  recent24h: { detected: number; completed: number; failed: number };
  cleanup: { enabled: boolean; lastRunAt: number | null; nextRunAt: number | null };
  unresolvedMessages: number;
  issues: HealthIssue[];
  worker: { running: boolean; lastTickAt: number | null };
}

export type JobStatus =
  | "PENDING"
  | "RESOLVING"
  | "DOWNLOADING"
  | "VERIFYING"
  | "COMPLETED"
  | "RETRY_WAIT"
  | "FAILED"
  | "PAUSED"
  | "CANCELED";

export interface DownloadItem {
  id: string;
  videoId: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: number;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  source: string;
  createdAt: number;
  updatedAt: number;
  nextRetryAt: number | null;
  finishedAt: number | null;
  title: string | null;
  workId: string | null;
  videoStatus: VideoStatus;
  coverUrl: string | null;
  latestSharedAt: number | null;
}

export interface DownloadListResponse {
  items: DownloadItem[];
  total: number;
  worker: { running: boolean; pausedReasons: string[]; activeCount: number; lastTickAt: number | null };
  pausedReason: string | null;
}

export interface VaultSettings {
  retention: {
    unwatchedDays: number;
    watchedDays: number;
    failedDays: number;
    tempHours: number;
  };
  storage: {
    capacityGb: number;
    safetyReserveGb: number;
  };
  download: {
    enabled: boolean;
    concurrency: number;
    preferredQuality: "540p" | "720p" | "1080p" | "best";
    maxAttempts: number;
    retryDelaysSeconds: number[];
    timeoutSeconds: number;
    verifyWithFfprobe: boolean;
  };
  cleanup: {
    enabled: boolean;
    runHourLocal: number;
  };
  watchedThreshold: number;
}

export interface SettingsResponse {
  settings: VaultSettings;
  environment: {
    adapter: string;
    demoMode: boolean;
    dtkConfigured: boolean;
    dtkMode: string;
    ytdlpPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    mediaAllowedHosts: string[];
    secureCookies: boolean;
    publicOrigin: string | null;
    nodeEnv: string;
  };
  cleanup: { enabled: boolean; lastRunAt: number | null; nextRunAt: number | null };
  backup: { lastRunAt: number | null };
}

export interface CleanupResult {
  trigger: string;
  deletedVideos: number;
  failedRecordsDeleted: number;
  staleTempDeleted: number;
  orphanFilesDeleted: number;
  freedBytes: number;
  missingFiles: number;
  needsPause: boolean;
  usedBytes: number;
  projectedBytes: number;
  errors: string[];
  startedAt: number;
  finishedAt: number;
}

export interface CleanupLog {
  id: string;
  videoId: string | null;
  videoRef: string | null;
  reason: string;
  freedBytes: number;
  detail: string | null;
  createdAt: number;
}

export interface UnresolvedItem {
  id: string;
  platformMessageId: string;
  type: string;
  workId: string | null;
  title: string | null;
  senderName: string | null;
  sentAt: number;
  diagnostic: string | null;
  group: { id: string; name: string; enabled: boolean };
}

export interface SessionInfo {
  setupRequired: boolean;
  authenticated: boolean;
  csrfToken: string | null;
}

export type VaultEventType =
  | "system.status_changed"
  | "auth.status_changed"
  | "group.status_changed"
  | "message.detected"
  | "download.progress"
  | "download.completed"
  | "download.failed"
  | "video.deleted"
  | "cleanup.completed";

export interface VaultEvent {
  type: VaultEventType;
  at: number;
  data: Record<string, unknown>;
}

export interface GroupListResponse {
  items: GroupView[];
  auth: {
    status: AccountStatus;
    connected: boolean;
    adapter: string;
    lastSuccessfulSyncAt: number | null;
  };
}

export interface GroupSyncResult {
  groupId: string;
  ok: boolean;
  messagesFound: number;
  messagesNew: number;
  gap: boolean;
  gapReason?: string;
  error?: string;
}
