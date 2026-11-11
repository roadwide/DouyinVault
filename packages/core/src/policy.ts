import type {
  CleanupCandidate,
  CleanupDecision,
  JobPriority,
  RetentionSettings,
  VaultSettings,
} from "./types.js";

export const DEFAULT_SETTINGS: VaultSettings = {
  retention: {
    unwatchedDays: 30,
    watchedDays: 7,
    failedDays: 7,
    tempHours: 24,
  },
  storage: {
    capacityGb: 20,
    safetyReserveGb: 2,
  },
  download: {
    enabled: true,
    concurrency: 2,
    preferredQuality: "720p",
    maxAttempts: 3,
    retryDelaysSeconds: [30, 120, 600],
    timeoutSeconds: 120,
    verifyWithFfprobe: true,
  },
  cleanup: {
    enabled: true,
    runHourLocal: 3,
  },
  watchedThreshold: 0.8,
};

export const SETTINGS_LIMITS = {
  unwatchedDays: [1, 3650],
  watchedDays: [0, 3650],
  failedDays: [1, 365],
  tempHours: [1, 720],
  capacityGb: [1, 10_000],
  safetyReserveGb: [0, 1000],
  concurrency: [1, 8],
  maxAttempts: [1, 10],
  timeoutSeconds: [10, 3600],
  watchedThreshold: [0.5, 1],
  runHourLocal: [0, 23],
} as const;

export function mergeSettings(value: unknown): VaultSettings {
  const input = (value ?? {}) as Partial<VaultSettings>;
  return {
    retention: { ...DEFAULT_SETTINGS.retention, ...(input.retention ?? {}) },
    storage: { ...DEFAULT_SETTINGS.storage, ...(input.storage ?? {}) },
    download: {
      ...DEFAULT_SETTINGS.download,
      ...(input.download ?? {}),
      retryDelaysSeconds:
        Array.isArray(input.download?.retryDelaysSeconds) && input.download.retryDelaysSeconds.length > 0
          ? input.download.retryDelaysSeconds
          : DEFAULT_SETTINGS.download.retryDelaysSeconds,
    },
    cleanup: { ...DEFAULT_SETTINGS.cleanup, ...(input.cleanup ?? {}) },
    watchedThreshold: input.watchedThreshold ?? DEFAULT_SETTINGS.watchedThreshold,
  };
}

/**
 * A video is watched only after playback crosses the configured fraction.
 * Opening a detail page or the first seconds of a clip must not count.
 */
export function isWatchedByProgress(
  positionSeconds: number,
  durationSeconds: number | null,
  threshold = DEFAULT_SETTINGS.watchedThreshold,
): boolean {
  if (!durationSeconds || durationSeconds <= 0) return false;
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return false;
  return positionSeconds / durationSeconds >= threshold;
}

export function retryDelayMs(attempt: number, delaysSeconds: readonly number[]): number {
  if (delaysSeconds.length === 0) return 30_000;
  const index = Math.min(Math.max(0, attempt - 1), delaysSeconds.length - 1);
  return (delaysSeconds[index] as number) * 1000;
}

export function priorityForSource(
  source: "realtime" | "history" | "manual" | "repair",
): JobPriority {
  switch (source) {
    case "realtime":
      return 0;
    case "manual":
      return 1;
    case "history":
      return 2;
    case "repair":
      return 3;
  }
}

const DAY_MS = 86_400_000;

export function isRetentionExpired(
  candidate: CleanupCandidate,
  retention: RetentionSettings,
  nowMs: number,
): CleanupDecision | null {
  if (candidate.isFavorite) return null;
  if (candidate.isWatched) {
    const watchedAt = candidate.watchedAt ?? candidate.downloadedAt ?? candidate.fileMtime;
    if (watchedAt == null) return null;
    if (nowMs - watchedAt >= retention.watchedDays * DAY_MS) {
      return {
        videoId: candidate.videoId,
        reason: "expired_watched",
        freedBytes: candidate.fileSize,
      };
    }
    return null;
  }
  const downloadedAt = candidate.downloadedAt ?? candidate.fileMtime;
  if (downloadedAt == null) return null;
  if (nowMs - downloadedAt >= retention.unwatchedDays * DAY_MS) {
    return {
      videoId: candidate.videoId,
      reason: "expired_unwatched",
      freedBytes: candidate.fileSize,
    };
  }
  return null;
}

export interface CleanupPlan {
  deletions: CleanupDecision[];
  freedBytes: number;
  projectedBytes: number;
  overCapacity: boolean;
  /** True when the user must expand storage or clean manually. */
  needsPause: boolean;
  reasons: string[];
}

/**
 * Expired watched videos are removed before expired unwatched videos.
 * Favorites, unexpired unwatched videos and any unexpired video are never
 * force-deleted because of capacity pressure.
 */
export function planCleanup(input: {
  candidates: readonly CleanupCandidate[];
  retention: RetentionSettings;
  capacityBytes: number;
  usedBytes: number;
  nowMs: number;
}): CleanupPlan {
  const watched: CleanupDecision[] = [];
  const unwatched: CleanupDecision[] = [];
  for (const candidate of input.candidates) {
    const decision = isRetentionExpired(candidate, input.retention, input.nowMs);
    if (!decision) continue;
    if (decision.reason === "expired_watched") watched.push(decision);
    else unwatched.push(decision);
  }
  // Callers pass candidates oldest-first; preserve that order per group.
  const deletions = [...watched, ...unwatched];
  const freedBytes = deletions.reduce((sum, item) => sum + Math.max(0, item.freedBytes), 0);
  const projectedBytes = Math.max(0, input.usedBytes - freedBytes);
  const overCapacity = input.capacityBytes > 0 && projectedBytes > input.capacityBytes;
  return {
    deletions,
    freedBytes,
    projectedBytes,
    overCapacity,
    needsPause: overCapacity,
    reasons: overCapacity
      ? ["容量超限，但剩余视频未到保留期、属于收藏或未观看保护范围。已暂停新增下载。"]
      : [],
  };
}

export function shouldPauseForDisk(freeBytes: number, safetyReserveBytes: number): boolean {
  return freeBytes < safetyReserveBytes;
}

export function isTempFileStale(mtimeMs: number, nowMs: number, tempHours: number): boolean {
  return nowMs - mtimeMs >= tempHours * 3_600_000;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 ** 3);
}

/** Sharable, human-readable reason labels used by the web client. */
export const CLEANUP_REASON_LABELS: Record<string, string> = {
  expired_watched: "已观看且超过保留期",
  expired_unwatched: "未观看且超过保留期",
  capacity_watched: "容量清理（已观看）",
  capacity_unwatched: "容量清理（未观看）",
  manual: "手动删除",
  failed_record_expired: "失败记录超过保留期",
  orphan_file: "无引用文件",
  stale_temp: "过期临时文件",
  missing_file: "媒体文件缺失",
};
