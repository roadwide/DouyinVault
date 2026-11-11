import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  Loader2,
  PauseCircle,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { api } from "../api/client";
import type { DownloadItem, DownloadListResponse, JobStatus } from "../api/types";
import { useVaultEvent } from "../hooks/EventsProvider";
import { JobStatusBadge } from "../components/StatusBadge";
import { useToast } from "../components/Toast";
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
import { cn, errorMessage, formatBytes, formatDate, formatRelative, formatWhen, truncate } from "../lib/utils";

type Tab = "queue" | "failed" | "completed" | "all";

const TABS: { value: Tab; label: string }[] = [
  { value: "queue", label: "队列" },
  { value: "failed", label: "失败" },
  { value: "completed", label: "已完成" },
  { value: "all", label: "全部" },
];

const QUEUE_STATUSES: JobStatus[] = ["PENDING", "RESOLVING", "DOWNLOADING", "VERIFYING", "RETRY_WAIT", "PAUSED"];
const ACTIVE_STATUSES: JobStatus[] = ["RESOLVING", "DOWNLOADING", "VERIFYING"];

const sourceLabels: Record<string, string> = {
  realtime: "实时消息",
  history: "历史补拉",
  manual: "手动重试",
  repair: "自动修复",
};

function pausedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  const map: Record<string, string> = {
    disk_space: "磁盘剩余空间低于安全预留，下载已暂停",
    storage_capacity: "缓存占用超过容量上限，下载已暂停",
    downloads_disabled: "自动下载已在设置中关闭",
    rate_limited: "平台触发限流，下载队列已冷却暂停",
  };
  return reason
    .split(",")
    .map((item) => map[item] ?? item)
    .join("；");
}

export function DownloadsPage() {
  const [searchParams] = useSearchParams();
  const initial = searchParams.get("status") === "FAILED" ? "failed" : "all";
  const [tab, setTab] = useState<Tab>(initial);
  const [data, setData] = useState<DownloadListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const refreshTimer = useRef(0);
  const { toast } = useToast();

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const result = await api.get<DownloadListResponse>("/api/v1/downloads?limit=100");
      setData(result);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useVaultEvent(
    (event) => {
      if (event.type === "download.progress" && data) {
        const jobId = String(event.data.jobId ?? "");
        if (!jobId) return;
        setData((current) => {
          if (!current) return current;
          return {
            ...current,
            items: current.items.map((item) =>
              item.id === jobId
                ? {
                    ...item,
                    status: "DOWNLOADING",
                    progress: Number(event.data.progress ?? item.progress),
                    downloadedBytes: event.data.downloadedBytes as number | null,
                    totalBytes: event.data.totalBytes as number | null,
                    speedBps: event.data.speedBps as number | null,
                  }
                : item,
            ),
          };
        });
        return;
      }
      if (event.type === "download.completed" || event.type === "download.failed" || event.type === "system.status_changed") {
        const now = Date.now();
        if (now - refreshTimer.current > 1200) {
          refreshTimer.current = now;
          void load(true);
        }
      }
    },
    ["download.progress", "download.completed", "download.failed", "system.status_changed"],
  );

  const retry = async (item: DownloadItem) => {
    setRetrying(item.id);
    try {
      await api.post(`/api/v1/downloads/${item.id}/retry`);
      toast("已重新加入下载队列", "success");
      window.setTimeout(() => void load(true), 500);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setRetrying(null);
    }
  };

  const retryAll = async () => {
    setRetryingAll(true);
    try {
      const result = await api.post<{ count: number }>("/api/v1/downloads/retry-failed");
      toast(result.count > 0 ? `已重新加入 ${result.count} 个失败任务` : "没有可重试的失败任务", "success");
      window.setTimeout(() => void load(true), 500);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setRetryingAll(false);
    }
  };

  const items = data?.items ?? [];
  const filtered = items.filter((item) => {
    if (tab === "all") return true;
    if (tab === "queue") return QUEUE_STATUSES.includes(item.status);
    if (tab === "failed") return item.status === "FAILED" || item.status === "CANCELED";
    return item.status === "COMPLETED";
  });
  const counts = {
    queue: items.filter((item) => QUEUE_STATUSES.includes(item.status)).length,
    failed: items.filter((item) => item.status === "FAILED" || item.status === "CANCELED").length,
    completed: items.filter((item) => item.status === "COMPLETED").length,
    all: items.length,
  };
  const active = items.filter((item) => ACTIVE_STATUSES.includes(item.status));
  const paused = pausedReasonLabel(data?.pausedReason ?? null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="下载任务"
        description="任务先写入 SQLite 再开始下载。失败不会被静默吞掉，服务重启后未完成任务会自动恢复。"
        actions={
          <div className="flex items-center gap-2">
            {counts.failed > 0 ? (
              <Button
                variant="outline"
                icon={RotateCcw}
                onClick={() => void retryAll()}
                loading={retryingAll}
              >
                批量重新排队
              </Button>
            ) : null}
            <Button variant="outline" icon={RefreshCw} onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </div>
        }
      />

      {error ? <AlertBanner tone="danger" title="加载下载队列失败">{error}</AlertBanner> : null}

      {paused ? (
        <AlertBanner tone="warning" title={paused}>
          新任务会保持等待状态，不会无限重试。请在设置中调整容量或执行清理后恢复。
        </AlertBanner>
      ) : null}

      {active.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
            <div className="flex items-center gap-2 text-xs font-medium text-ink-200">
              <Loader2 className="size-4 animate-spin text-brand-400" />
              {active.length} 个任务正在处理
            </div>
            <span className="text-[11px] text-ink-500">
              当前活动 {data?.worker?.activeCount ?? 0}
            </span>
          </div>
          <div className="divide-y divide-white/[0.05]">
            {active.map((item) => (
              <div key={item.id} className="flex items-center gap-4 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm text-ink-100">{item.title || "未命名视频"}</p>
                    <span className="text-[11px] tabular-nums text-ink-400">
                      {Math.round(item.progress * 100)}%
                    </span>
                  </div>
                  <Progress value={item.progress * 100} tone="brand" className="mt-2 h-1.5" />
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-500">
                    <JobStatusBadge status={item.status} />
                    <span>{formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)}</span>
                    {item.speedBps ? <span>{formatBytes(item.speedBps)}/s</span> : null}
                    <span>{sourceLabels[item.source] ?? item.source}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        {TABS.map((item) => (
          <button
            key={item.value}
            onClick={() => setTab(item.value)}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition",
              tab === item.value
                ? "border-brand-500/30 bg-brand-500/10 text-brand-300"
                : "border-white/[0.07] text-ink-400 hover:border-white/[0.14] hover:text-ink-200",
            )}
          >
            {item.label}
            <span className={cn("ml-1.5 tabular-nums", tab === item.value ? "text-brand-400/70" : "text-ink-600")}>
              {counts[item.value]}
            </span>
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={tab === "failed" ? CheckCircle2 : Download}
            title={
              tab === "queue"
                ? "队列是空的"
                : tab === "failed"
                  ? "没有失败的任务"
                  : tab === "completed"
                    ? "还没有完成记录"
                    : "暂无下载记录"
            }
            description={
              tab === "queue"
                ? "新发现的视频会按优先级进入队列。实时消息优先于历史补拉。"
                : tab === "failed"
                  ? "所有尝试过的任务都成功或仍在重试。"
                  : "当系统缓存第一条视频后，任务记录会保留在这里。"
            }
          />
        </Card>
      ) : (
        <Card className="divide-y divide-white/[0.05] overflow-hidden">
          {filtered.map((item) => {
            const terminal = item.status === "COMPLETED";
            const failed = item.status === "FAILED" || item.status === "CANCELED";
            return (
              <div key={item.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    {failed ? (
                      <XCircle className="size-4 text-red-400" />
                    ) : terminal ? (
                      <CheckCircle2 className="size-4 text-emerald-400" />
                    ) : item.status === "RETRY_WAIT" ? (
                      <Clock3 className="size-4 text-amber-400" />
                    ) : item.status === "PAUSED" ? (
                      <PauseCircle className="size-4 text-amber-400" />
                    ) : (
                      <Download className="size-4 text-ink-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/videos/${item.videoId}`}
                        className="truncate text-sm font-medium text-ink-100 transition hover:text-brand-300"
                      >
                        {item.title || "未命名视频"}
                      </Link>
                      <JobStatusBadge status={item.status} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-500">
                      <span>{sourceLabels[item.source] ?? item.source}</span>
                      <span>尝试 {item.attempts}/{item.maxAttempts}</span>
                      <span>创建 {formatRelative(item.createdAt)}</span>
                      {item.finishedAt ? <span>{failed ? "结束" : "完成"} {formatDate(item.finishedAt)}</span> : null}
                      {item.nextRetryAt && item.status === "RETRY_WAIT" ? (
                        <span className="text-amber-400/80">下次重试 {formatWhen(item.nextRetryAt)}</span>
                      ) : null}
                    </div>
                    {item.errorMessage ? (
                      <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-red-300/80">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                        <span className="line-clamp-2">
                          {item.errorCode ? <code className="mr-1.5 text-red-300/60">{item.errorCode}</code> : null}
                          {truncate(item.errorMessage, 200)}
                        </span>
                      </p>
                    ) : null}
                    {!terminal && !failed && item.progress > 0 ? (
                      <Progress value={item.progress * 100} className="mt-2 max-w-xs" />
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 pl-13 sm:pl-0">
                  <Link to={`/videos/${item.videoId}`}>
                    <Button size="sm" variant="ghost">详情</Button>
                  </Link>
                  {failed || item.status === "RETRY_WAIT" || item.status === "PAUSED" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={RotateCcw}
                      onClick={() => void retry(item)}
                      loading={retrying === item.id}
                    >
                      重试
                    </Button>
                  ) : null}
                  {terminal ? (
                    <Badge tone="success">已保存</Badge>
                  ) : null}
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {data && data.total > items.length ? (
        <p className="text-center text-[11px] text-ink-600">
          当前显示最近 {items.length} 条任务，共 {data.total} 条。
        </p>
      ) : null}
    </div>
  );
}
