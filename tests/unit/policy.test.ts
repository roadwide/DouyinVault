import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  gbToBytes,
  isRetentionExpired,
  isTempFileStale,
  isWatchedByProgress,
  mergeSettings,
  planCleanup,
  retryDelayMs,
  shouldPauseForDisk,
  type CleanupCandidate,
} from "@vault/core";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function candidate(overrides: Partial<CleanupCandidate> = {}): CleanupCandidate {
  return {
    videoId: "video-1",
    isFavorite: false,
    isWatched: false,
    watchedAt: null,
    downloadedAt: NOW - 40 * DAY,
    fileSize: 1000,
    fileMtime: NOW - 40 * DAY,
    ...overrides,
  };
}

describe("watched threshold", () => {
  it("requires 80% of the duration by default", () => {
    expect(isWatchedByProgress(79, 100)).toBe(false);
    expect(isWatchedByProgress(80, 100)).toBe(true);
    expect(isWatchedByProgress(120, 100)).toBe(true);
  });

  it("never counts opening a video as watched", () => {
    expect(isWatchedByProgress(0, 100)).toBe(false);
    expect(isWatchedByProgress(1, null)).toBe(false);
    expect(isWatchedByProgress(1, 0)).toBe(false);
  });

  it("accepts a custom threshold", () => {
    expect(isWatchedByProgress(60, 100, 0.6)).toBe(true);
    expect(isWatchedByProgress(59, 100, 0.6)).toBe(false);
  });
});

describe("retry backoff", () => {
  it("walks the configured delay list and clamps at the end", () => {
    expect(retryDelayMs(1, [30, 120, 600])).toBe(30_000);
    expect(retryDelayMs(2, [30, 120, 600])).toBe(120_000);
    expect(retryDelayMs(3, [30, 120, 600])).toBe(600_000);
    expect(retryDelayMs(9, [30, 120, 600])).toBe(600_000);
  });

  it("falls back safely for empty lists", () => {
    expect(retryDelayMs(1, [])).toBe(30_000);
  });
});

describe("retention policy", () => {
  it("expires unwatched videos after the configured window", () => {
    const result = isRetentionExpired(candidate(), DEFAULT_SETTINGS.retention, NOW);
    expect(result?.reason).toBe("expired_unwatched");
  });

  it("keeps unexpired unwatched videos", () => {
    const result = isRetentionExpired(
      candidate({ downloadedAt: NOW - 2 * DAY }),
      DEFAULT_SETTINGS.retention,
      NOW,
    );
    expect(result).toBeNull();
  });

  it("uses the watched timestamp for watched videos", () => {
    const result = isRetentionExpired(
      candidate({ isWatched: true, watchedAt: NOW - 8 * DAY, downloadedAt: NOW }),
      DEFAULT_SETTINGS.retention,
      NOW,
    );
    expect(result?.reason).toBe("expired_watched");
  });

  it("never expires favorites", () => {
    expect(
      isRetentionExpired(
        candidate({ isFavorite: true, isWatched: true, watchedAt: NOW - 100 * DAY }),
        DEFAULT_SETTINGS.retention,
        NOW,
      ),
    ).toBeNull();
  });
});

describe("cleanup planning", () => {
  it("deletes expired watched before expired unwatched and skips favorites", () => {
    const plan = planCleanup({
      candidates: [
        candidate({ videoId: "favorite", isFavorite: true, isWatched: true, watchedAt: NOW - 40 * DAY }),
        candidate({ videoId: "unwatched", downloadedAt: NOW - 40 * DAY }),
        candidate({ videoId: "watched", isWatched: true, watchedAt: NOW - 20 * DAY, downloadedAt: NOW - 20 * DAY }),
        candidate({ videoId: "recent", downloadedAt: NOW - 1 * DAY }),
      ],
      retention: DEFAULT_SETTINGS.retention,
      capacityBytes: gbToBytes(20),
      usedBytes: gbToBytes(1),
      nowMs: NOW,
    });
    expect(plan.deletions.map((item) => item.videoId)).toEqual(["watched", "unwatched"]);
    expect(plan.deletions.every((item) => item.videoId !== "favorite")).toBe(true);
    expect(plan.needsPause).toBe(false);
  });

  it("pauses instead of deleting unexpired videos under capacity pressure", () => {
    const plan = planCleanup({
      candidates: [
        candidate({ videoId: "expired", downloadedAt: NOW - 40 * DAY, fileSize: 100 }),
        candidate({ videoId: "recent", downloadedAt: NOW - 1 * DAY, fileSize: 900 }),
      ],
      retention: DEFAULT_SETTINGS.retention,
      capacityBytes: 500,
      usedBytes: 1000,
      nowMs: NOW,
    });
    expect(plan.deletions.map((item) => item.videoId)).toEqual(["expired"]);
    expect(plan.overCapacity).toBe(true);
    expect(plan.needsPause).toBe(true);
    expect(plan.freedBytes).toBe(100);
    expect(plan.projectedBytes).toBe(900);
  });

  it("does not delete anything when nothing is expired", () => {
    const plan = planCleanup({
      candidates: [candidate({ downloadedAt: NOW - 1 * DAY })],
      retention: DEFAULT_SETTINGS.retention,
      capacityBytes: 100,
      usedBytes: 1000,
      nowMs: NOW,
    });
    expect(plan.deletions).toHaveLength(0);
    expect(plan.needsPause).toBe(true);
  });
});

describe("storage helpers", () => {
  it("pauses below the disk safety reserve", () => {
    expect(shouldPauseForDisk(1_000, 2_000)).toBe(true);
    expect(shouldPauseForDisk(2_000, 2_000)).toBe(false);
  });

  it("detects stale temp files", () => {
    expect(isTempFileStale(NOW - 25 * 3_600_000, NOW, 24)).toBe(true);
    expect(isTempFileStale(NOW - 23 * 3_600_000, NOW, 24)).toBe(false);
  });

  it("converts GiB to bytes", () => {
    expect(gbToBytes(1)).toBe(1024 ** 3);
    expect(gbToBytes(20)).toBe(20 * 1024 ** 3);
  });

  it("merges partial settings without losing defaults", () => {
    const merged = mergeSettings({
      retention: { watchedDays: 3 },
      download: { concurrency: 3 },
      watchedThreshold: 0.9,
    });
    expect(merged.retention.watchedDays).toBe(3);
    expect(merged.retention.unwatchedDays).toBe(DEFAULT_SETTINGS.retention.unwatchedDays);
    expect(merged.download.concurrency).toBe(3);
    expect(merged.download.maxAttempts).toBe(DEFAULT_SETTINGS.download.maxAttempts);
  });
});
