import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { EventsProvider } from "./hooks/EventsProvider";
import { ToastProvider } from "./components/Toast";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LibraryPage } from "./pages/LibraryPage";
import { VideoDetailPage } from "./pages/VideoDetailPage";
import { GroupsPage } from "./pages/GroupsPage";
import { DownloadsPage } from "./pages/DownloadsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Spinner } from "./components/ui";

function ScrollToTop() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);
  return null;
}

function NotFoundPage() {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center text-center">
      <p className="text-6xl font-bold tracking-tighter text-ink-700">404</p>
      <h1 className="mt-4 text-lg font-semibold text-ink-100">页面不存在</h1>
      <p className="mt-2 text-sm text-ink-500">它可能已经被移动，或者从未存在过。</p>
      <a href="/" className="mt-6 text-xs text-brand-400 underline-offset-4 hover:underline">
        返回仪表盘
      </a>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5">
      <div className="relative flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-ink-850">
        <span className="text-lg font-bold tracking-tighter">DV</span>
        <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-brand-500" />
        <span className="absolute -bottom-1.5 -left-1.5 size-2.5 rounded-full bg-aqua-400/80" />
      </div>
      <div className="flex items-center gap-2 text-xs text-ink-500">
        <Spinner className="size-3.5" /> 正在打开时光仓…
      </div>
    </div>
  );
}

export function App() {
  const { loading, session } = useAuth();

  if (loading) return <Splash />;
  if (!session?.authenticated) {
    return (
      <ToastProvider>
        <LoginPage />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <EventsProvider>
        <BrowserRouter>
          <ScrollToTop />
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="videos" element={<LibraryPage />} />
              <Route path="videos/:id" element={<VideoDetailPage />} />
              <Route path="groups" element={<GroupsPage />} />
              <Route path="downloads" element={<DownloadsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="login" element={<Navigate to="/" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </EventsProvider>
    </ToastProvider>
  );
}
