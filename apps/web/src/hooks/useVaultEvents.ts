import { useEffect, useRef, useState } from "react";
import type { VaultEvent, VaultEventType } from "../api/types";

const EVENT_TYPES: VaultEventType[] = [
  "system.status_changed",
  "auth.status_changed",
  "group.status_changed",
  "message.detected",
  "download.progress",
  "download.completed",
  "download.failed",
  "video.deleted",
  "cleanup.completed",
];

export function useVaultEvents(
  onEvent: (event: VaultEvent) => void,
  enabled = true,
  onReconnect?: () => void,
): { connected: boolean } {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;
  const [connected, setConnected] = useState(false);
  const hadDisconnect = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    const connect = () => {
      source = new EventSource("/api/v1/events", { withCredentials: true });
      source.onopen = () => {
        setConnected(true);
        if (hadDisconnect.current) {
          hadDisconnect.current = false;
          reconnectRef.current?.();
        }
      };
      source.onerror = () => {
        setConnected(false);
        hadDisconnect.current = true;
        source?.close();
        source = null;
        retryTimer = window.setTimeout(connect, 5000);
      };
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (event) => {
          try {
            handlerRef.current(JSON.parse((event as MessageEvent).data) as VaultEvent);
          } catch {
            // Ignore malformed events.
          }
        });
      }
    };
    connect();
    return () => {
      if (retryTimer) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled]);

  return { connected };
}
