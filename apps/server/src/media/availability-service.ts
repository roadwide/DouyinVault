import type BetterSqlite3 from "better-sqlite3";
import type { VideoAvailability, WorkAvailabilityResult } from "@vault/core";
import { mapLimit, safeErrorMessage, withTimeout } from "@vault/shared";
import type { AuthService } from "../auth/auth-service.js";
import type { Logger } from "../logger.js";

const AVAILABLE_TTL_MS = 2 * 60_000;
const UNAVAILABLE_TTL_MS = 60_000;
const UNKNOWN_TTL_MS = 20_000;
const CHECK_TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 5_000;

interface VideoAvailabilityRow {
  video_id: string;
  work_id: string | null;
  status: string;
  platform_group_id: string | null;
}

interface KnownEntry {
  state: "available" | "unavailable";
  checkedAt: number;
  expiresAt: number;
}

interface UnknownEntry {
  checkedAt: number;
  expiresAt: number;
}

function unknownAvailability(): VideoAvailability {
  return { state: "unknown", checkedAt: null };
}

/**
 * Live source-availability checks for locally cached videos.
 *
 * Only `ready` videos with a work id are queried. Results are cached in memory
 * for a short period so opening the library does not hammer the IM API, while
 * a manual refresh can bypass the cache. Nothing is written to the database:
 * a video can become available again after the platform restores it.
 */
export class WorkAvailabilityService {
  private readonly known = new Map<string, KnownEntry>();
  private readonly unknown = new Map<string, UnknownEntry>();

  constructor(
    private readonly sqlite: BetterSqlite3.Database,
    private readonly auth: AuthService,
    private readonly logger: Logger,
  ) {}

  async resolve(
    videoIds: readonly string[],
    options: { force?: boolean } = {},
  ): Promise<Map<string, VideoAvailability>> {
    const ids = [...new Set(videoIds.filter(Boolean))];
    const result = new Map<string, VideoAvailability>();
    if (ids.length === 0) return result;

    const pending = new Map<string, Array<{ videoId: string; workId: string }>>();
    const nowMs = Date.now();
    for (const row of this.rowsFor(ids)) {
      if (row.status !== "ready" || !row.work_id) {
        result.set(row.video_id, unknownAvailability());
        continue;
      }
      if (!options.force) {
        const cached = this.readCached(row.work_id, nowMs);
        if (cached) {
          result.set(row.video_id, cached);
          continue;
        }
      }
      if (!row.platform_group_id) {
        result.set(row.video_id, unknownAvailability());
        continue;
      }
      const bucket = pending.get(row.platform_group_id) ?? [];
      bucket.push({ videoId: row.video_id, workId: row.work_id });
      pending.set(row.platform_group_id, bucket);
    }

    for (const id of ids) {
      if (!result.has(id)) result.set(id, unknownAvailability());
    }

    await mapLimit([...pending.entries()], 2, ([groupId, entries]) =>
      this.checkGroup(groupId, entries, result),
    );
    this.prune();
    return result;
  }

  private rowsFor(ids: readonly string[]): VideoAvailabilityRow[] {
    const placeholders = ids.map(() => "?").join(",");
    return this.sqlite
      .prepare(
        `SELECT v.id AS video_id, v.work_id, v.status,
                (SELECT g.platform_group_id
                   FROM video_shares vs
                   JOIN messages m ON m.id = vs.message_id
                   JOIN groups g ON g.id = m.group_id
                  WHERE vs.video_id = v.id
                  ORDER BY vs.shared_at DESC
                  LIMIT 1) AS platform_group_id
           FROM videos v
          WHERE v.id IN (${placeholders})`,
      )
      .all(...ids) as VideoAvailabilityRow[];
  }

  private readCached(workId: string, nowMs: number): VideoAvailability | null {
    const known = this.known.get(workId);
    if (known) {
      if (known.expiresAt > nowMs) {
        return { state: known.state, checkedAt: known.checkedAt };
      }
      this.known.delete(workId);
    }
    const unknown = this.unknown.get(workId);
    if (unknown) {
      if (unknown.expiresAt > nowMs) {
        return { state: "unknown", checkedAt: unknown.checkedAt };
      }
      this.unknown.delete(workId);
    }
    return null;
  }

  private async checkGroup(
    groupId: string,
    entries: Array<{ videoId: string; workId: string }>,
    result: Map<string, VideoAvailability>,
  ): Promise<void> {
    const workIds = [...new Set(entries.map((entry) => entry.workId))];
    const checkedAt = Date.now();
    try {
      const source = this.auth.sourceRef;
      if (!source.checkWorkAvailability) {
        throw new Error("当前 IM 适配器不支持可访问性检查");
      }
      const checked = await withTimeout(
        source.checkWorkAvailability(workIds, groupId),
        CHECK_TIMEOUT_MS,
        "检查作品可访问性超时",
      );
      const byWork = new Map<string, WorkAvailabilityResult>(
        checked.map((item) => [item.workId, item]),
      );
      for (const entry of entries) {
        const item = byWork.get(entry.workId);
        if (!item) {
          this.setUnknown(entry.workId, checkedAt);
          result.set(entry.videoId, { state: "unknown", checkedAt });
          continue;
        }
        this.setKnown(entry.workId, item, checkedAt);
        result.set(entry.videoId, { state: item.state, checkedAt });
      }
    } catch (error) {
      const checkedAtNow = Date.now();
      this.logger.warn(
        { count: entries.length, error: safeErrorMessage(error) },
        "检查作品可访问性失败，本次不展示不可访问标签",
      );
      for (const entry of entries) {
        this.setUnknown(entry.workId, checkedAtNow);
        result.set(entry.videoId, { state: "unknown", checkedAt: checkedAtNow });
      }
    }
  }

  private setKnown(workId: string, item: WorkAvailabilityResult, checkedAt: number): void {
    const ttl = item.state === "unavailable" ? UNAVAILABLE_TTL_MS : AVAILABLE_TTL_MS;
    this.known.set(workId, {
      state: item.state,
      checkedAt,
      expiresAt: checkedAt + ttl,
    });
    this.unknown.delete(workId);
  }

  private setUnknown(workId: string, checkedAt: number): void {
    // A failed refresh must not keep serving an old "available" result.
    this.known.delete(workId);
    this.unknown.set(workId, {
      checkedAt,
      expiresAt: checkedAt + UNKNOWN_TTL_MS,
    });
  }

  private prune(): void {
    if (this.known.size + this.unknown.size <= MAX_CACHE_ENTRIES) return;
    const nowMs = Date.now();
    for (const [key, entry] of this.known) {
      if (entry.expiresAt <= nowMs) this.known.delete(key);
    }
    for (const [key, entry] of this.unknown) {
      if (entry.expiresAt <= nowMs) this.unknown.delete(key);
    }
    while (this.known.size + this.unknown.size > MAX_CACHE_ENTRIES) {
      const key = this.known.keys().next().value ?? this.unknown.keys().next().value;
      if (!key) break;
      if (!this.known.delete(key)) this.unknown.delete(key);
    }
  }
}
