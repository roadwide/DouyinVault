/**
 * Signed media URLs are deliberately not persisted: they expire quickly and
 * putting them in backups is unnecessary. They live only in memory long enough
 * for the P0 download worker to claim the job. After a restart the queue falls
 * back to the API/yt-dlp resolver, and if neither exists the job fails visibly.
 */
export class MediaUrlCache {
  private entries = new Map<string, { url: string; expiresAt: number }>();
  private readonly ttlMs = 15 * 60_000;
  private readonly maxEntries = 500;

  set(messageId: string, url: string): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(messageId, { url, expiresAt: Date.now() + this.ttlMs });
  }

  get(messageId: string): string | null {
    const entry = this.entries.get(messageId);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(messageId);
      return null;
    }
    return entry.url;
  }

  setForVideo(videoId: string, url: string): void {
    this.set(`video:${videoId}`, url);
  }

  getForVideo(videoId: string): string | null {
    return this.get(`video:${videoId}`);
  }

  deleteForVideo(videoId: string): void {
    this.entries.delete(`video:${videoId}`);
  }

  delete(messageId: string): void {
    this.entries.delete(messageId);
  }

  prune(): void {
    const timestamp = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < timestamp) this.entries.delete(key);
    }
  }
}
