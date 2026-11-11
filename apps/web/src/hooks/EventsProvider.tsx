import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { VaultEvent } from "../api/types";
import { useVaultEvents } from "./useVaultEvents";

type Listener = (event: VaultEvent) => void;

interface EventsContextValue {
  connected: boolean;
  subscribe: (listener: Listener) => () => void;
}

const EventsContext = createContext<EventsContextValue | null>(null);

export function EventsProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const dispatch = useCallback((event: VaultEvent) => {
    for (const listener of listeners.current) {
      try {
        listener(event);
      } catch {
        // A page listener must not break the shared event stream.
      }
    }
  }, []);

  const { connected: sseConnected } = useVaultEvents(dispatch, true, () => {
    // After a reconnect, pages re-fetch complete state instead of trusting
    // only the incremental events that arrived while disconnected.
    dispatch({ type: "system.status_changed", at: Date.now(), data: { reconnect: true } });
  });

  useEffect(() => {
    setConnected(sseConnected);
  }, [sseConnected]);

  return (
    <EventsContext.Provider value={{ connected, subscribe }}>{children}</EventsContext.Provider>
  );
}

export function useVaultEvent(handler: Listener, types?: VaultEvent["type"][]): void {
  const context = useContext(EventsContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!context) return;
    return context.subscribe((event) => {
      if (types && !types.includes(event.type)) return;
      handlerRef.current(event);
    });
  }, [context, types?.join("|")]);
}

export function useEventsConnected(): boolean {
  return useContext(EventsContext)?.connected ?? false;
}
