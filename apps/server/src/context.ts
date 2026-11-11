import type BetterSqlite3 from "better-sqlite3";
import { createDatabase, type VaultDatabase } from "@vault/db";
import type { AppConfig, Paths } from "./config.js";
import { buildPaths } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { ensureDataScaffold } from "./paths.js";
import { EventBus } from "./events.js";
import { AdminAuthService } from "./auth/admin-auth.js";
import { AuthService } from "./auth/auth-service.js";
import { GroupService } from "./groups/group-service.js";
import { GroupSyncService } from "./groups/sync-service.js";
import { SettingsService } from "./settings/service.js";
import { MediaUrlCache } from "./messages/media-cache.js";
import { MessageIngestService } from "./messages/ingest-service.js";
import { StorageService } from "./storage/storage-service.js";
import { MediaLibraryService } from "./media/library-service.js";
import { WorkAvailabilityService } from "./media/availability-service.js";
import { DownloadWorker } from "./downloads/worker.js";
import { CleanupService } from "./cleanup/service.js";
import { BackupService } from "./backup/service.js";
import { HealthService } from "./health/service.js";
import { Scheduler } from "./scheduler.js";
import type { ApiDeps } from "./api/deps.js";

export interface AppContext extends ApiDeps {
  paths: Paths;
  scheduler: Scheduler;
  close: () => Promise<void>;
}

export async function createContext(config: AppConfig): Promise<AppContext> {
  const paths = buildPaths(config);
  ensureDataScaffold(config, paths);
  const logger = createLogger(config);
  const opened = createDatabase(paths.dbFile);
  const db: VaultDatabase = opened.db;
  const sqlite: BetterSqlite3.Database = opened.sqlite;
  const bus = new EventBus();

  const settings = new SettingsService(db, bus, logger);
  const adminAuth = new AdminAuthService(db, config, paths, logger);
  adminAuth.initialize();
  const auth = new AuthService(db, config, paths, bus, logger);
  const groups = new GroupService(db, bus);
  const mediaCache = new MediaUrlCache();
  const ingest = new MessageIngestService(db, settings, groups, auth, bus, mediaCache, logger);
  const groupSync = new GroupSyncService(db, auth, groups, ingest, bus, logger);
  const storage = new StorageService(paths);
  const library = new MediaLibraryService(db, sqlite, paths, settings, storage, bus, logger);
  const availability = new WorkAvailabilityService(sqlite, auth, logger);
  const worker = new DownloadWorker(
    db,
    sqlite,
    config,
    paths,
    settings,
    storage,
    library,
    ingest,
    mediaCache,
    bus,
    logger,
  );
  worker.setWorkMediaResolver(async (workId, platformGroupId) => {
    const source = auth.sourceRef;
    return source.resolveWorkMedia?.(workId, platformGroupId) ?? null;
  });
  library.setCancelHandler((videoId) => worker.cancel(videoId));
  library.recoverIncompleteDeletions();
  ingest.setOnEnqueued(() => worker.wake());
  const cleanup = new CleanupService(
    db,
    sqlite,
    paths,
    settings,
    storage,
    library,
    worker,
    bus,
    logger,
  );
  const backup = new BackupService(sqlite, paths, settings, logger);
  const health = new HealthService(sqlite, db, config, auth, settings, storage, worker, logger);
  const scheduler = new Scheduler(auth, groupSync, cleanup, backup, health, settings, bus, logger);

  auth.setHooks({
    onMessage: async (message) => {
      await ingest.ingest(message);
    },
    onConnected: async () => {
      logger.info({ adapter: config.imAdapter }, "IM 已连接，开始同步群列表");
      try {
        await groupSync.refreshGroupList();
      } catch (error) {
        logger.warn({ error }, "群列表同步失败");
        return;
      }
      void groupSync.syncAllEnabled("reconnect", 2).catch((error) => {
        logger.warn({ error }, "连接后的历史补拉失败");
      });
    },
  });

  await auth.initialize();

  const close = async (): Promise<void> => {
    await scheduler.stop();
    await worker.stop();
    await auth.disconnect();
    opened.close();
  };

  return {
    config,
    paths,
    db,
    sqlite,
    logger,
    bus,
    adminAuth,
    auth,
    groups,
    groupSync,
    ingest,
    mediaCache,
    library,
    availability,
    worker,
    settings,
    cleanup,
    backup,
    health,
    storage,
    scheduler,
    close,
  };
}
