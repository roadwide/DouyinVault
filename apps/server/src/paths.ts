import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig, Paths } from "./config.js";

export function ensureDirectories(paths: Paths): void {
  for (const directory of [
    paths.dataDir,
    paths.dbDir,
    paths.sessionsDir,
    paths.mediaDir,
    paths.videosDir,
    paths.coversDir,
    paths.tempDir,
    paths.logsDir,
    paths.backupsDir,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
  }
}

export function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
}

export function ensureDataScaffold(config: AppConfig, paths: Paths): void {
  ensureDirectories(paths);
  const readmePath = resolve(paths.dataDir, "README.txt");
  if (!existsSync(readmePath)) {
    writePrivateFile(
      readmePath,
      [
        "This directory contains private Douyin Vault state.",
        "",
        "db/        SQLite business database (0600)",
        "sessions/  Douyin IM sessions and login state (do not back up or share)",
        "media/     downloaded videos and covers",
        "temp/      in-progress downloads",
        "logs/      application logs",
        "backups/   database backups",
        "",
        "Never expose this directory through a static web server.",
        `Adapter: ${config.imAdapter}`,
      ].join("\n"),
    );
  }
}
