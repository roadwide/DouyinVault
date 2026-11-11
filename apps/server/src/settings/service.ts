import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, type VaultSettings } from "@vault/core";
import { settings, type schema } from "@vault/db";
import { now } from "@vault/shared";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";

const range = (key: keyof typeof SETTINGS_LIMITS) => {
  const [min, max] = SETTINGS_LIMITS[key];
  return z.number().min(min).max(max);
};

const SettingsSchema = z.object({
  retention: z.object({
    unwatchedDays: range("unwatchedDays").int(),
    watchedDays: range("watchedDays").int(),
    failedDays: range("failedDays").int(),
    tempHours: range("tempHours").int(),
  }),
  storage: z.object({
    capacityGb: range("capacityGb"),
    safetyReserveGb: range("safetyReserveGb"),
  }),
  download: z.object({
    enabled: z.boolean(),
    concurrency: range("concurrency").int(),
    preferredQuality: z.enum(["540p", "720p", "1080p", "best"]),
    maxAttempts: range("maxAttempts").int(),
    retryDelaysSeconds: z.array(z.number().int().min(5).max(86_400)).min(1).max(6),
    timeoutSeconds: range("timeoutSeconds").int(),
    verifyWithFfprobe: z.boolean(),
  }),
  cleanup: z.object({
    enabled: z.boolean(),
    runHourLocal: range("runHourLocal").int(),
  }),
  watchedThreshold: range("watchedThreshold"),
});

const PartialSettingsSchema = z
  .object({
    retention: SettingsSchema.shape.retention.partial().optional(),
    storage: SettingsSchema.shape.storage.partial().optional(),
    download: SettingsSchema.shape.download.partial().optional(),
    cleanup: SettingsSchema.shape.cleanup.partial().optional(),
    watchedThreshold: range("watchedThreshold").optional(),
  })
  .strict();

export type PartialSettings = z.infer<typeof PartialSettingsSchema>;

const SETTINGS_KEY = "vault.settings";

function deepMerge(base: VaultSettings, patch: PartialSettings): VaultSettings {
  return {
    retention: { ...base.retention, ...(patch.retention ?? {}) },
    storage: { ...base.storage, ...(patch.storage ?? {}) },
    download: { ...base.download, ...(patch.download ?? {}) },
    cleanup: { ...base.cleanup, ...(patch.cleanup ?? {}) },
    watchedThreshold: patch.watchedThreshold ?? base.watchedThreshold,
  };
}

export class SettingsService {
  private cached: VaultSettings | null = null;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  get(): VaultSettings {
    if (this.cached) return structuredClone(this.cached);
    const row = this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
    let value: VaultSettings = DEFAULT_SETTINGS;
    if (row) {
      try {
        const parsed = SettingsSchema.safeParse(JSON.parse(row.value));
        if (parsed.success) value = parsed.data;
        else this.logger.warn("保存的设置不合法，已使用默认值并等待下一次更新修正。");
      } catch {
        this.logger.warn("保存的设置无法解析，已使用默认值。");
      }
    }
    this.cached = value;
    return structuredClone(value);
  }

  update(patch: unknown): VaultSettings {
    const parsedPatch = PartialSettingsSchema.parse(patch);
    const merged = deepMerge(this.get(), parsedPatch);
    const parsed = SettingsSchema.parse(merged);
    const timestamp = now();
    this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: JSON.stringify(parsed), updatedAt: timestamp })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: JSON.stringify(parsed), updatedAt: timestamp },
      })
      .run();
    this.cached = parsed;
    this.bus.publish("system.status_changed", { reason: "settings_updated" });
    return structuredClone(parsed);
  }

  getInternal(key: string): string | null {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
  }

  setInternal(key: string, value: string): void {
    const timestamp = now();
    this.db
      .insert(settings)
      .values({ key, value, updatedAt: timestamp })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: timestamp } })
      .run();
  }
}
