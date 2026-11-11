import type { Millis } from "@vault/shared";

export type AccountStatus =
  | "UNCONFIGURED"
  | "LOGIN_REQUIRED"
  | "AUTHENTICATING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "VERIFY_REQUIRED"
  | "LOGGED_OUT";

export type GroupStatus = "active" | "paused" | "error" | "verify_required";

export type MessageType =
  | "shared_work"
  | "chat_video"
  | "text_with_url"
  | "image"
  | "unknown";

export type MessageOrigin = "realtime" | "history";

export type MessageStatus = "received" | "resolved" | "unresolved" | "ignored";

/**
 * Platform-agnostic message event. This is the only shape business code sees;
 * IM adapters are responsible for mapping platform payloads into it.
 */
export interface NormalizedMessage {
  accountId: string;
  groupId: string;
  groupName?: string;
  messageId: string;
  senderId?: string;
  senderName?: string;
  sentAt: Millis;
  receivedAt: Millis;

  type: MessageType;

  /** Decimal string. Never coerce platform IDs to JavaScript numbers. */
  workId?: string;
  shareUrl?: string;
  /** Direct, authorized media URL when the platform exposes one. */
  mediaUrl?: string;
  title?: string;
  coverUrl?: string;
  authorName?: string;

  source: MessageOrigin;
  /** Truncated, credential-free diagnostic for unresolved cards. */
  diagnostic?: string;
}

export interface GroupInfo {
  platformGroupId: string;
  name: string;
  avatarUrl?: string;
  memberCount?: number;
}

export interface SourceStatus {
  state: AccountStatus;
  connected: boolean;
  lastConnectedAt: Millis | null;
  lastMessageAt: Millis | null;
  lastSuccessfulSyncAt: Millis | null;
  lastError: string | null;
  reconnectAttempts: number;
}

export interface LoginChallenge {
  kind: "qr" | "verification" | "none";
  /** data: URL. Never a raw session token. */
  qrDataUrl?: string;
  verificationUrl?: string;
  expiresAt?: Millis;
  hint?: string;
}

export interface HistorySyncResult {
  messages: NormalizedMessage[];
  nextCursor?: string;
  hasMore: boolean;
  /**
   * True when the adapter knows the requested window was not fully covered.
   * Never report an incomplete window as complete.
   */
  gap: boolean;
  gapReason?: string;
}

export type VideoStatus = "pending" | "ready" | "failed" | "deleted" | "deleting";

export interface VideoRecord {
  id: string;
  platform: "douyin";
  workId: string | null;

  title: string | null;
  authorName: string | null;
  authorId: string | null;

  filePath: string | null;
  coverPath: string | null;

  fileSize: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;

  status: VideoStatus;

  createdAt: Millis;
  downloadedAt: Millis | null;
  deletedAt: Millis | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;

  isFavorite: boolean;
  watchedAt: Millis | null;
  lastPlayedAt: Millis | null;
  positionSeconds: number | null;
  isWatched: boolean;
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

export type JobPriority = 0 | 1 | 2 | 3;

export interface DownloadJob {
  id: string;
  videoId: string;
  status: JobStatus;
  priority: JobPriority;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Millis | null;
  leaseOwner: string | null;
  leaseExpiresAt: Millis | null;
  progress: number;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  source: "realtime" | "history" | "manual" | "repair";
  createdAt: Millis;
  updatedAt: Millis;
  startedAt: Millis | null;
  finishedAt: Millis | null;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number | null;
  /** 0..1 when total size is known, otherwise null. */
  fraction: number | null;
}

export type MediaKind = "video" | "image";

export interface MediaInput {
  videoId: string;
  workId: string | null;
  shareUrl: string | null;
  mediaUrl: string | null;
  title: string | null;
  coverUrl: string | null;
}

/**
 * Fresh, authorized media link obtained from the signed-in IM session.
 * Signed URLs must stay in memory and never be persisted or logged.
 */
export interface WorkMediaLink {
  url: string;
  title?: string | null;
  coverUrl?: string | null;
  authorName?: string | null;
}

export type WorkAvailabilityState = "available" | "unavailable" | "unknown";

export interface WorkAvailabilityResult {
  workId: string;
  state: "available" | "unavailable";
  /** Platform-side reason such as filtered/missing. Never contains a URL. */
  reason?: string | null;
}

/** A live availability snapshot for a locally cached video. */
export interface VideoAvailability {
  state: WorkAvailabilityState;
  checkedAt: Millis | null;
}

export interface ResolvedMedia {
  /** Signed URL. Never log or return this value. */
  url: string;
  kind: MediaKind;
  headers?: Record<string, string>;
  container?: string | null;
  title?: string | null;
  coverUrl?: string | null;
  durationSeconds?: number | null;
  /** Adapter-specific opaque state (e.g. yt-dlp pseudo URL). */
  adapterState?: Record<string, unknown>;
}

export interface DownloadResult {
  filePath: string;
  bytesWritten: number;
  contentType: string | null;
}

export interface MediaDownloader {
  readonly name: string;
  supports(input: MediaInput): boolean;
  resolve(input: MediaInput): Promise<ResolvedMedia>;
  download(
    media: ResolvedMedia,
    outputPath: string,
    onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<DownloadResult>;
}

export interface LoginCapableSource {
  /** Start a login and return a user-presentable challenge. */
  startLogin(): Promise<LoginChallenge>;
  cancelLogin?(): Promise<void>;
  logout(): Promise<void>;
}

export interface MessageSource extends LoginCapableSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listGroups(): Promise<GroupInfo[]>;
  subscribe(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<void>;
  syncHistory(groupId: string, cursor?: string): Promise<HistorySyncResult>;
  getStatus(): SourceStatus;
  /**
   * Resolve a fresh, signed media link for a shared work through the primary
   * IM session. Optional: adapters without a platform session simply omit it.
   * The returned URL is memory-only and must never be persisted or logged.
   */
  resolveWorkMedia?(workId: string, platformGroupId: string | null): Promise<WorkMediaLink | null>;
  /**
   * Check whether shared works are still available on the platform. Used to
   * tag already cached videos as deleted/private/filtered without persisting a
   * permanent flag.
   */
  checkWorkAvailability?(
    workIds: readonly string[],
    platformGroupId: string | null,
  ): Promise<readonly WorkAvailabilityResult[]>;
}

export interface MediaProbe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  format: string | null;
}

export interface RetentionSettings {
  unwatchedDays: number;
  watchedDays: number;
  failedDays: number;
  tempHours: number;
}

export interface StorageSettings {
  capacityGb: number;
  safetyReserveGb: number;
}

export interface DownloadSettings {
  enabled: boolean;
  concurrency: number;
  preferredQuality: "540p" | "720p" | "1080p" | "best";
  maxAttempts: number;
  retryDelaysSeconds: number[];
  timeoutSeconds: number;
  verifyWithFfprobe: boolean;
}

export interface CleanupSettings {
  enabled: boolean;
  runHourLocal: number;
}

export interface VaultSettings {
  retention: RetentionSettings;
  storage: StorageSettings;
  download: DownloadSettings;
  cleanup: CleanupSettings;
  watchedThreshold: number;
}

export interface CleanupCandidate {
  videoId: string;
  isFavorite: boolean;
  isWatched: boolean;
  watchedAt: Millis | null;
  downloadedAt: Millis | null;
  fileSize: number;
  fileMtime: Millis | null;
}

export type CleanupReason =
  | "expired_watched"
  | "expired_unwatched"
  | "capacity_watched"
  | "capacity_unwatched";

export interface CleanupDecision {
  videoId: string;
  reason: CleanupReason;
  freedBytes: number;
}
