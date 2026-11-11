import { readdirSync, statSync, statfsSync } from "node:fs";
import { resolve } from "node:path";
import type { Paths } from "../config.js";

export interface StorageUsage {
  videosBytes: number;
  coversBytes: number;
  totalBytes: number;
  freeBytes: number;
  diskTotalBytes: number;
  checkedAt: number;
}

function directorySize(directory: string): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      try {
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) total += statSync(path).size;
      } catch {
        // Ignore files removed while scanning.
      }
    }
  };
  walk(directory);
  return total;
}

export class StorageService {
  private cached: StorageUsage | null = null;
  private cacheTime = 0;

  constructor(private readonly paths: Paths) {}

  get(): StorageUsage {
    const timestamp = Date.now();
    if (this.cached && timestamp - this.cacheTime < 60_000) return this.cached;
    const videosBytes = directorySize(this.paths.videosDir);
    const coversBytes = directorySize(this.paths.coversDir);
    let freeBytes = 0;
    let diskTotalBytes = 0;
    try {
      const stats = statfsSync(this.paths.dataDir);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
      diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
    } catch {
      freeBytes = 0;
    }
    this.cached = {
      videosBytes,
      coversBytes,
      totalBytes: videosBytes + coversBytes,
      freeBytes,
      diskTotalBytes,
      checkedAt: timestamp,
    };
    this.cacheTime = timestamp;
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
