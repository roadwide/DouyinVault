import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { MIGRATIONS } from "./migrations.js";
import { schema } from "./schema.js";

export type VaultDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  /** Create parent directory and enforce 0700/0600 permissions. Default true. */
  securePermissions?: boolean;
  readOnly?: boolean;
}

export interface OpenedDatabase {
  sqlite: BetterSqliteDatabase;
  db: VaultDatabase;
  close: () => void;
}

export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const secure = options.securePermissions ?? true;
  if (options.path !== ":memory:") {
    const absolute = resolve(options.path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    if (secure && existsSync(dirname(absolute))) {
      try {
        chmodSync(dirname(absolute), 0o700);
      } catch {
        // Best effort on filesystems that do not support POSIX modes.
      }
    }
    options = { ...options, path: absolute };
  }

  const sqlite = new Database(options.path, {
    readonly: options.readOnly ?? false,
    fileMustExist: options.readOnly ?? false,
  });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (!options.readOnly) {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("temp_store = MEMORY");
    sqlite.pragma("wal_autocheckpoint = 1000");
    if (options.path !== ":memory:" && secure) {
      try {
        chmodSync(resolve(options.path), 0o600);
      } catch {
        // Best effort.
      }
    }
  }

  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}

export function migrate(sqlite: BetterSqliteDatabase): string[] {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    sqlite.prepare("SELECT id FROM schema_migrations").all().map((row) => String((row as { id: string }).id)),
  );
  const recorded: string[] = [];
  const insert = sqlite.prepare(
    "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      insert.run(migration.id, migration.name, Date.now());
    });
    run();
    recorded.push(migration.id);
  }
  return recorded;
}

export function getSchemaVersion(sqlite: BetterSqliteDatabase): string | null {
  try {
    const row = sqlite
      .prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** Open + migrate in one call. Tests and scripts should prefer this. */
export function createDatabase(path: string): OpenedDatabase & { appliedMigrations: string[] } {
  const opened = openDatabase({ path });
  const appliedMigrations = migrate(opened.sqlite);
  return { ...opened, appliedMigrations };
}

export { schema };
export * from "./schema.js";
export { MIGRATIONS } from "./migrations.js";
