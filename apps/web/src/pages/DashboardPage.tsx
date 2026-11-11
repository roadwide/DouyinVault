import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Download,
  EyeOff,
  HardDrive,
  Heart,
  Loader2,
  MessageSquare,
  Radio,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import { api } from "../api/client";
import type {
  DownloadItem,
  DownloadListResponse,
  SystemSnapshot,
  VideoListResponse,
  VideoView,
} from "../api/types";
import { useVaultEvent } from "../hooks/EventsProvider";
import { ConnectDouyinDialog } from "../components/ConnectDouyinDialog";
import { VideoCard } from "../components/VideoCard";
import { AccountStatusBadge, JobStatusBadge } from "../components/StatusBadge";
import {
  AlertBanner,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Progress,
  Skeleton,
} from "../components/ui";
import {
  cn,
  formatBytes,
  formatDate,
  formatRelative,
  formatTime,
  percent,
  truncate,
} from "../lib/utils";

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent = "default",
}: {
  icon: typeof Archive;
  label: string;
  value: string;
  hint: string;
  accent?: "default" | "brand" | "aqua" | "amber";
}) {
  return (
    <Card className="group relative overflow-hidden p-4 sm:p-5" hover>
      <div
        className={cn(
          "pointer-events-none absolute -right-8 -top-10 size-28 rounded-full blur-2xl transition-opacity duration-500 group-hover:opacity-100",
          accent === "brand" && "bg-brand-500/10",
          accent === "aqua" && "bg-aqua-400/[0.07]",
          accent === "amber" && "bg-amber-400/[0.06]",
          accent === "default" && "bg-white/[0.035]",
        )}
      />
      <div className="relative flex items-start justify-between">
        <div className="flex size-9 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.03]">
          <Icon
            className={cn(
              "size-4",
              accent === "brand" && "text-brand-400",
              accent === "aqua" && "text-aqua-400",
              accent === "amber" && "text-amber-300",
              accent === "default" && "text-ink-300",
            )}
          />
        </div>
        <ArrowUpRight className="size-3.5 text-ink-600 transition group-hover:text-ink-400" />
      </div>
      <p className="relative mt-3 text-xl font-semibold tracking-tight tabular-nums text-ink-50 sm:mt-5 sm:text-2xl">
        {value}
      </p>
      <div className="relative mt-1 space-y-0.5">
        <p className="text-[11px] font-medium text-ink-400 sm:text-xs">{label}</p>
        <p className="truncate text-[10px] text-ink-600">{hint}</p>
      </div>
    </Card>
  );
}

function QueueRow({ item }: { item: DownloadItem }) {
  const active = ["RESOLVING", "DOWNLOADING", "VERIFYING"].includes(item.status);
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.03]">
        {item.coverUrl ? (
          <img src={item.coverUrl} alt="" className="size-full object-cover" />
        ) : active ? (
          <Loader2 className="size-4 animate-spin text-brand-400" />
        ) : (
          <Download className="size-4 text-ink-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-xs font-medium text-ink-200">{item.title || "未命名视频"}</p>
          <JobStatusBadge status={item.status} />
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <Progress
            value={item.status === "COMPLETED" ? 100 : Math.round(item.progress * 100)}
            tone={item.status === "FAILED" ? "warning" : item.status === "COMPLETED" ? "success" : "brand"}
            className="h-1"
          />
          <span className="shrink-0 text-[10px] tabular-nums text-ink-500">
            {item.totalBytes ? formatBytes(item.totalBytes) : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [recent, setRecent] = useState<VideoView[]>([]);
  const [queue, setQueue] = useState<DownloadListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const lastRefresh = useRef(0);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const [status, videos, downloads] = await Promise.all([
        api.get<SystemSnapshot>("/api/v1/system/status"),
        api.get<VideoListResponse>("/api/v1/videos?limit=6&sort=latest"),
        api.get<DownloadListResponse>("/api/v1/downloads?limit=5"),
      ]);
      setSnapshot(status);
      setRecent(videos.items);
      setQueue(downloads);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useVaultEvent(
    (event) => {
      if (event.type === "system.status_changed" || event.type === "auth.status_changed" || event.type === "group.status_changed") {
        void load(true);
        return;
      }
      if (event.type === "download.completed" || event.type === "download.failed" || event.type === "cleanup.completed") {
        void load(true);
        return;
      }
      if (event.type === "download.progress") {
        const now = Date.now();
        if (now - lastRefresh.current > 1800) {
          lastRefresh.current = now;
          void load(true);
        }
      }
    },
    [
      "system.status_changed",
      "auth.status_changed",
      "group.status_changed",
      "download.progress",
      "download.completed",
      "download.failed",
      "cleanup.completed",
    ],
  );

  const connect = useCallback(() => setConnectOpen(true), []);
  const closeConnect = useCallback(() => setConnectOpen(false), []);
  const connected = useCallback(() => void load(true), [load]);

  if (loading && !snapshot) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-36" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div>
        <AlertBanner tone="danger" title="无法加载仪表盘">
          {error ?? "服务没有返回状态信息"}
        </AlertBanner>
      </div>
    );
  }

  const hour = new Date().getHours();
  const greeting = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const storagePercent = percent(snapshot.storage.usedBytes, snapshot.storage.capacityBytes);
  const warnings = snapshot.issues.filter((issue) => issue.level !== "info");
  const infos = snapshot.issues.filter((issue) => issue.level === "info");
  const auth = snapshot.auth;
  const connectedNow = auth.connected;
  const activeQueue = queue?.items.filter((item) =>
    ["PENDING", "RESOLVING", "DOWNLOADING", "VERIFYING", "RETRY_WAIT"].includes(item.status),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting}，这里是你的视频收件箱`}
        description="自动监听已启用的群聊，把群友分享的视频在失效前保存到本地。"
        actions={
          <>
            <Button variant="outline" icon={RefreshCw} onClick={() => void load()} loading={loading}>
              刷新
            </Button>
            {!connectedNow ? (
              <Button variant="primary" icon={Wifi} onClick={connect}>
                连接抖音
              </Button>
            ) : (
              <Badge tone="success" dot className="h-9 px-3">
                监听运行中
              </Badge>
            )}
          </>
        }
      />

      {error ? (
        <AlertBanner tone="danger" title="刷新失败">
          {error}
        </AlertBanner>
      ) : null}

      {warnings.length > 0 ? (
        <div className="space-y-2">
          {warnings.slice(0, 3).map((issue) => (
            <AlertBanner
              key={issue.code}
              tone={issue.level === "error" ? "danger" : "warning"}
              title={issue.message}
              action={
                issue.code === "AUTH_REQUIRED" || issue.code === "IM_NOT_CONNECTED" ? (
                  <Button size="sm" variant="outline" onClick={connect}>
                    去处理
                  </Button>
                ) : issue.code === "CAPACITY_EXCEEDED" || issue.code === "DISK_SPACE" ? (
                  <Link to="/settings">
                    <Button size="sm" variant="outline">打开设置</Button>
                  </Link>
                ) : issue.code === "GROUP_SYNC_ERROR" ? (
                  <Link to="/groups">
                    <Button size="sm" variant="outline">查看群聊</Button>
                  </Link>
                ) : issue.code === "DOWNLOAD_FAILURES" ? (
                  <Link to="/downloads?status=FAILED">
                    <Button size="sm" variant="outline">查看失败任务</Button>
                  </Link>
                ) : undefined
              }
            />
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard
          icon={Archive}
          label="缓存成功视频"
          value={String(snapshot.videos.ready)}
          hint={`共 ${snapshot.videos.total} 个作品`}
          accent="brand"
        />
        <StatCard
          icon={EyeOff}
          label="尚未观看"
          value={String(snapshot.videos.unwatched)}
          hint={
            snapshot.videos.ready > 0
              ? `占缓存 ${Math.round(percent(snapshot.videos.unwatched, snapshot.videos.ready))}%`
              : "等待第一条视频"
          }
          accent="aqua"
        />
        <StatCard
          icon={HardDrive}
          label="占用空间"
          value={formatBytes(snapshot.storage.usedBytes)}
          hint={`上限 ${formatBytes(snapshot.storage.capacityBytes)}`}
          accent="amber"
        />
        <StatCard
          icon={Radio}
          label="正常监听群聊"
          value={`${snapshot.groups.healthy} / ${snapshot.groups.enabled}`}
          hint={`共 ${snapshot.groups.total} 个群聊`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-100">监听与账号</h2>
              <p className="mt-0.5 text-[11px] text-ink-500">状态来自实际消息连接与最近一次成功同步</p>
            </div>
            <AccountStatusBadge status={auth.status} />
          </div>
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <div className="space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.14em] text-ink-600">抖音账号</p>
                <div className="mt-1.5 flex items-center gap-2.5">
                  <div className="flex size-9 items-center justify-center rounded-full border border-white/[0.08] bg-ink-800 text-xs font-semibold">
                    {auth.displayName?.slice(0, 1) ?? "抖"}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-100">
                      {auth.displayName || "尚未登录"}
                    </p>
                    <p className="text-[10px] text-ink-500">
                      {auth.platformUid ? `UID ${auth.platformUid}` : `适配器 ${auth.adapter}`}
                    </p>
                  </div>
                </div>
              </div>
              <dl className="space-y-2 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-ink-500">最近收到消息</dt>
                  <dd className="text-right text-ink-300">{formatRelative(auth.lastMessageAt)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-ink-500">最近成功同步</dt>
                  <dd className="text-right text-ink-300">{formatRelative(auth.lastSuccessfulSyncAt)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-ink-500">本次连接</dt>
                  <dd className="text-right text-ink-300">{formatRelative(auth.lastConnectedAt)}</dd>
                </div>
              </dl>
            </div>
            <div className="space-y-3">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                <p className="text-[10px] uppercase tracking-[0.14em] text-ink-600">24 小时活动</p>
                <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-lg font-semibold tabular-nums">{snapshot.recent24h.detected}</p>
                    <p className="text-[10px] text-ink-500">发现视频</p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold tabular-nums text-emerald-300">
                      {snapshot.recent24h.completed}
                    </p>
                    <p className="text-[10px] text-ink-500">缓存成功</p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold tabular-nums text-red-300">
                      {snapshot.recent24h.failed}
                    </p>
                    <p className="text-[10px] text-ink-500">失败</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 text-xs">
                <span className="flex items-center gap-2 text-ink-400">
                  {connectedNow ? (
                    <Wifi className="size-3.5 text-emerald-400" />
                  ) : (
                    <WifiOff className="size-3.5 text-amber-400" />
                  )}
                  {auth.adapter === "mock" ? "离线演示适配器" : "IM 传输"}
                </span>
                <span className="text-ink-500">{auth.lastError ? truncate(auth.lastError, 28) : connectedNow ? "在线" : "未连接"}</span>
              </div>
              {!connectedNow ? (
                <Button variant="primary" className="w-full" onClick={connect}>
                  连接抖音账号
                </Button>
              ) : null}
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold text-ink-100">存储空间</h2>
              <p className="mt-0.5 text-[11px] text-ink-500">
                保留期清理与软配额共同控制
              </p>
            </div>
            <Badge tone={snapshot.storage.overCapacity ? "warning" : "muted"}>
              {Math.round(storagePercent)}%
            </Badge>
          </div>
          <div className="mt-5 flex items-end gap-2">
            <span className="text-2xl font-semibold tracking-tight tabular-nums">
              {formatBytes(snapshot.storage.usedBytes)}
            </span>
            <span className="mb-1 text-xs text-ink-500">/ {formatBytes(snapshot.storage.capacityBytes)}</span>
          </div>
          <Progress value={storagePercent} tone={storagePercent > 90 ? "warning" : "brand"} className="mt-3 h-2" />
          <dl className="mt-5 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <dt className="text-ink-500">收藏视频</dt>
              <dd className="inline-flex items-center gap-1 text-ink-300">
                <Heart className="size-3 text-brand-400" /> {snapshot.videos.favorites}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-500">磁盘剩余</dt>
              <dd className="text-ink-300">{formatBytes(snapshot.storage.freeBytes)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-500">安全预留</dt>
              <dd className="text-ink-300">{formatBytes(snapshot.storage.safetyReserveBytes)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-500">下次自动清理</dt>
              <dd className="text-ink-300">
                {snapshot.cleanup.enabled ? formatDate(snapshot.cleanup.nextRunAt) : "已关闭"}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-[11px] leading-relaxed text-ink-500">
            <Sparkles className="size-3.5 shrink-0 text-aqua-400/80" />
            收藏与未到期的未观看视频不会因容量满而被强制删除。
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-100">最近缓存</h2>
              <p className="mt-0.5 text-[11px] text-ink-500">按最近一次群内分享时间排序</p>
            </div>
            <Link to="/videos">
              <Button size="sm" variant="ghost">打开视频库</Button>
            </Link>
          </div>
          {recent.length === 0 ? (
            <EmptyState
              icon={Archive}
              title="还没有缓存视频"
              description="先连接抖音账号，在群聊页面启用需要监听的群。收到视频分享后会自动出现在这里。"
              action={
                <Link to="/groups">
                  <Button variant="outline" size="sm">前往群聊设置</Button>
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {recent.map((video, index) => (
                <div key={video.id} className={index >= 4 ? "hidden xl:block" : ""}>
                  <VideoCard video={video} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-ink-100">下载队列</h2>
                <p className="mt-0.5 text-[11px] text-ink-500">
                  {snapshot.downloads.active} 个进行中 · {snapshot.downloads.pending} 个等待
                </p>
              </div>
              <Link to="/downloads">
                <Button size="sm" variant="ghost">全部</Button>
              </Link>
            </div>
            <div className="px-5 py-2">
              {activeQueue && activeQueue.length > 0 ? (
                <div className="divide-y divide-white/[0.05]">
                  {activeQueue.slice(0, 4).map((item) => (
                    <QueueRow key={item.id} item={item} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <CheckCircle2 className="size-5 text-emerald-400/80" />
                  <p className="text-xs text-ink-400">队列为空，所有已发现视频都已处理</p>
                </div>
              )}
            </div>
            {snapshot.downloads.failed > 0 ? (
              <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
                <p className="flex items-center gap-1.5 text-[11px] text-red-300/80">
                  <AlertTriangle className="size-3.5" /> {snapshot.downloads.failed} 个任务需要处理
                </p>
                <Link to="/downloads?status=FAILED" className="text-[11px] text-ink-400 underline-offset-4 hover:underline">
                  查看
                </Link>
              </div>
            ) : null}
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-100">健康提示</h2>
              <Badge tone={snapshot.status === "ok" ? "success" : snapshot.status === "error" ? "danger" : "warning"} dot>
                {snapshot.status === "ok" ? "正常" : snapshot.status === "error" ? "异常" : "需关注"}
              </Badge>
            </div>
            <div className="mt-3 space-y-2">
              {infos.length === 0 && warnings.length === 0 ? (
                <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-400">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                  接入、数据库与存储检查未发现异常。
                </p>
              ) : (
                [...warnings, ...infos].slice(0, 4).map((issue) => (
                  <div key={issue.code} className="flex items-start gap-2 text-xs leading-relaxed">
                    {issue.level === "info" ? (
                      <Clock3 className="mt-0.5 size-3.5 shrink-0 text-sky-400/80" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                    )}
                    <span className={issue.level === "info" ? "text-ink-500" : "text-ink-300"}>{issue.message}</span>
                  </div>
                ))
              )}
            </div>
            {snapshot.unresolvedMessages > 0 ? (
              <p className="mt-3 border-t border-white/[0.06] pt-3 text-[11px] text-ink-500">
                {snapshot.unresolvedMessages} 条视频卡片暂未解析，原始消息元数据已保留。
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[10px] text-ink-600">
        <span className="inline-flex items-center gap-1.5">
          <MessageSquare className="size-3" /> 服务运行 {Math.floor(snapshot.uptimeSeconds / 3600)} 小时 {Math.floor((snapshot.uptimeSeconds % 3600) / 60)} 分
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3" /> 状态更新于 {formatTime(snapshot.generatedAt)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Wifi className="size-3" /> SSE 实时推送
        </span>
      </div>

      <ConnectDouyinDialog open={connectOpen} onClose={closeConnect} onConnected={connected} />
    </div>
  );
}
