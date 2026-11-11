import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setCsrfToken } from "../api/client";
import type { SessionInfo } from "../api/types";

interface AuthContextValue {
  loading: boolean;
  session: SessionInfo | null;
  login: (password: string) => Promise<void>;
  setup: (token: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<SessionInfo | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchSession(): Promise<SessionInfo> {
  return api.get<SessionInfo>("/api/v1/session");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);

  const applySession = useCallback((info: SessionInfo) => {
    setSession(info);
    setCsrfToken(info.csrfToken);
    return info;
  }, []);

  const refresh = useCallback(async () => {
    const info = await fetchSession();
    return applySession(info);
  }, [applySession]);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((info) => {
        if (!cancelled) applySession(info);
      })
      .catch(() => {
        if (!cancelled) {
          setSession({ setupRequired: false, authenticated: false, csrfToken: null });
          setCsrfToken(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const onUnauthorized = () => {
      setSession((current) =>
        current ? { ...current, authenticated: false, csrfToken: null } : current,
      );
      setCsrfToken(null);
    };
    window.addEventListener("vault:unauthorized", onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener("vault:unauthorized", onUnauthorized);
    };
  }, [applySession]);

  const login = useCallback(
    async (password: string) => {
      const result = await api.post<{ csrfToken: string }>("/api/v1/session/login", { password });
      setCsrfToken(result.csrfToken);
      await refresh();
    },
    [refresh],
  );

  const setup = useCallback(
    async (token: string, password: string) => {
      const result = await api.post<{ csrfToken: string }>("/api/v1/session/setup", {
        token,
        password,
      });
      setCsrfToken(result.csrfToken);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/api/v1/session/logout");
    } finally {
      setCsrfToken(null);
      setSession({ setupRequired: false, authenticated: false, csrfToken: null });
    }
  }, []);

  const value = useMemo(
    () => ({ loading, session, login, setup, logout, refresh }),
    [loading, session, login, setup, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
