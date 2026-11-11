import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  Archive,
  ChevronRight,
  Download,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Settings,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useAuth } from "../hooks/useAuth";
import { useEventsConnected } from "../hooks/EventsProvider";
import { Badge } from "./ui";

const navigation = [
  { to: "/", label: "仪表盘", icon: LayoutDashboard },
  { to: "/videos", label: "视频库", icon: Archive },
  { to: "/groups", label: "群聊", icon: MessageSquare },
  { to: "/downloads", label: "下载", icon: Download },
  { to: "/settings", label: "设置", icon: Settings },
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-ink-850">
        <span className="text-[15px] font-bold tracking-tighter text-ink-50">DV</span>
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-brand-500" />
        <span className="absolute -bottom-1 -left-1 size-2 rounded-full bg-aqua-400/80" />
      </div>
      {!compact && (
        <div className="leading-none">
          <p className="text-sm font-semibold tracking-tight text-ink-50">Douyin Vault</p>
          <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
            Time Capsule
          </p>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { logout } = useAuth();
  const connected = useEventsConnected();
  const location = useLocation();
  const current = navigation.find((item) =>
    item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to),
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="relative hidden border-r border-white/[0.06] bg-ink-925/60 lg:flex lg:h-dvh lg:flex-col lg:sticky lg:top-0">
        <div className="px-6 pb-5 pt-7">
          <Brand />
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                  isActive
                    ? "bg-white/[0.07] text-ink-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                    : "text-ink-400 hover:bg-white/[0.04] hover:text-ink-200",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn("size-[18px]", isActive ? "text-brand-400" : "text-ink-500")} />
                  <span className="flex-1">{item.label}</span>
                  {isActive && <ChevronRight className="size-3.5 text-ink-500" />}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/[0.06] p-4">
          <div className="mb-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              {connected ? (
                <Wifi className="size-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="size-3.5 text-ink-500" />
              )}
              <span className="text-ink-300">{connected ? "实时连接" : "正在重连"}</span>
            </div>
            <span
              className={cn(
                "size-1.5 rounded-full",
                connected ? "bg-emerald-400" : "animate-pulse bg-amber-400",
              )}
            />
          </div>
          <button
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-ink-500 transition hover:bg-white/[0.04] hover:text-ink-200"
          >
            <LogOut className="size-3.5" />
            退出管理后台
          </button>
          <div className="mt-2 flex items-center gap-1.5 px-2 text-[10px] text-ink-600">
            <ShieldCheck className="size-3" />
            本地优先 · 凭据不离开本机
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-white/[0.06] bg-ink-950/80 px-4 backdrop-blur-xl lg:hidden">
          <button onClick={() => (window.location.href = "/")} className="flex items-center">
            <Brand />
          </button>
          <div className="flex items-center gap-2">
            <Badge tone={connected ? "success" : "warning"} dot>
              {connected ? "在线" : "重连"}
            </Badge>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-28 pt-6 sm:px-6 lg:px-10 lg:pb-12 lg:pt-9">
          <div className="mb-8 hidden items-center justify-between lg:flex">
            <div className="flex items-center gap-2 text-xs text-ink-500">
              <Activity className="size-3.5" />
              <span>{current?.label ?? "Douyin Vault"}</span>
              <ChevronRight className="size-3" />
              <span className="text-ink-400">本地时光仓</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-ink-500">
              <span>v0.1.0</span>
              <span className="size-1 rounded-full bg-ink-600" />
              <span>仅限授权群聊</span>
            </div>
          </div>
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-white/[0.07] bg-ink-925/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
        <div className="grid grid-cols-5">
          {navigation.map((item) => {
            const active =
              item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={cn(
                  "flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition",
                  active ? "text-brand-400" : "text-ink-500",
                )}
              >
                <item.icon className="size-5" />
                {item.label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
