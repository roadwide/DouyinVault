import type { Millis } from "@vault/shared";

export type VaultEventType =
  | "system.status_changed"
  | "auth.status_changed"
  | "group.status_changed"
  | "message.detected"
  | "download.progress"
  | "download.completed"
  | "download.failed"
  | "video.deleted"
  | "cleanup.completed";

export interface VaultEvent {
  type: VaultEventType;
  at: Millis;
  data: Record<string, unknown>;
}

type Listener = (event: VaultEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private sseClosers = new Set<() => void>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(type: VaultEventType, data: Record<string, unknown> = {}): void {
    const event: VaultEvent = { type, at: Date.now(), data };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE client must not break ingestion or downloads.
      }
    }
  }

  registerSse(closer: () => void): () => void {
    this.sseClosers.add(closer);
    return () => this.sseClosers.delete(closer);
  }

  closeAllSse(): void {
    for (const close of [...this.sseClosers]) {
      try {
        close();
      } catch {
        // Ignore already-closed clients.
      }
    }
    this.sseClosers.clear();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
