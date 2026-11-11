import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  Copy,
  DownloadCloud,
  Eye,
  EyeOff,
  FileVideo2,
  Gauge,
  HardDrive,
  Heart,
  Maximize,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Share2,
  Trash2,
  UserRound,
  Wifi,
} from "lucide-react";
import { api } from "../api/client";
import type { VideoDetail } from "../api/types";
import { useVaultEvent } from "../hooks/EventsProvider";
import { JobStatusBadge, VideoStatusBadge } from "../components/StatusBadge";
import { VideoCover } from "../components/VideoCover";
import { useToast } from "../components/Toast";
import {
  AlertBanner,
  Badge,
  Button,
  Card,
  Modal,
  Skeleton,
} from "../components/ui";
import {
  errorMessage,
  formatBytes,
  formatDate,
  formatDuration,
  formatRelative,
  formatWhen,
  truncate,
} from "../lib/utils";

export function VideoDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detailRef = useRef<VideoDetail | null>(null);
  detailRef.current = detail;
  const saveTimer = useRef(0);
  const lastSavedPosition = useRef(0);
  const currentPosition = useRef(0);
  const currentDuration = useRef<number | null>(null);

  const load = useCallback(async (refreshAvailability = false) => {
    try {
      const result = await api.get<{ item: VideoDetail }>(
        `/api/v1/videos/${id}${refreshAvailability ? "?refresh=1" : ""}`,
      );
      setDetail(result.item);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    // Opening a video is an explicit view: check the source right away rather
    // than relying on the list's short-lived cache.
    void load(true);
  }, [load]);

  useVaultEvent(
    (event) => {
      if (event.type === "download.completed" && event.data.videoId === id) {
        void load();
      }
      if (event.type === "download.failed" && event.data.videoId === id) {
        void load();
      }
      if (event.type === "system.status_changed" && detail?.status === "pending") {
        void load();
      }
    },
    ["download.completed", "download.failed", "system.status_changed"],
  );

  const saveProgress = useCallback(
    (force = false) => {
      const currentDetail = detailRef.current;
      if (!currentDetail || currentDetail.status !== "ready") return;
      const position = currentPosition.current;
      if (!position || position < 0.5) return;
      const timestamp = Date.now();
      if (!force && timestamp - saveTimer.current < 5000) return;
      if (!force && Math.abs(position - lastSavedPosition.current) < 2) return;
      saveTimer.current = timestamp;
      lastSavedPosition.current = position;
      void api
        .post<{ progress: { isWatched: boolean; watchedAt: number | null } }>(
          `/api/v1/videos/${id}/progress`,
          {
            positionSeconds: position,
            durationSeconds: currentDuration.current,
          },
        )
        .then((result) => {
          if (result.progress.isWatched) {
            setDetail((current) =>
              current
                ? { ...current, isWatched: true, watchedAt: result.progress.watchedAt, positionSeconds: position }
                : current,
            );
          }
        })
        .catch(() => undefined);
    },
    [id],
  );

  useEffect(() => {
    return () => {
      saveProgress(true);
    };
  }, [saveProgress]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveProgress(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [saveProgress]);

  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video || !detail) return;
    currentDuration.current = Number.isFinite(video.duration) ? video.duration : detail.durationSeconds;
    if (detail.positionSeconds > 3 && (!video.duration || detail.positionSeconds < video.duration - 5)) {
      video.currentTime = detail.positionSeconds;
      setResumedFrom(detail.positionSeconds);
      window.setTimeout(() => setResumedFrom(null), 3500);
    }
  };

  const toggleFavorite = async () => {
    if (!detail) return;
    try {
      const result = await api.patch<{ item: VideoDetail }>(`/api/v1/videos/${id}`, {
        isFavorite: !detail.isFavorite,
      });
      setDetail(result.item);
      toast(result.item.isFavorite ? "已加入收藏，自动清理会跳过它" : "已取消收藏", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const toggleWatched = async () => {
    if (!detail) return;
    try {
      const result = await api.patch<{ item: VideoDetail }>(`/api/v1/videos/${id}`, {
        isWatched: !detail.isWatched,
      });
      setDetail(result.item);
      toast(result.item.isWatched ? "已标记为已观看" : "已标记为未观看", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const retry = async () => {
    if (!detail?.job) return;
    setRetrying(true);
    try {
      await api.post(`/api/v1/downloads/${detail.job.id}/retry`);
      toast("已重新加入下载队列", "success");
      window.setTimeout(() => void load(), 500);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setRetrying(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.delete(`/api/v1/videos/${id}`);
      toast("视频已从本地删除", "success");
      navigate("/videos", { replace: true });
    } catch (err) {
      toast(errorMessage(err), "error");
      setDeleting(false);
    }
  };

  const copyLink = async () => {
    const link = detail?.shares.find((share) => share.shareUrl)?.shareUrl;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("原始链接已复制", "success");
    } catch {
      toast("复制失败，请手动选择链接", "error");
    }
  };

  const fullscreen = () => {
    void videoRef.current?.requestFullscreen?.();
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-40" />
        <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
          <Skeleton className="aspect-[9/13] max-h-[70dvh]" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-5">
        <Link to="/videos" className="inline-flex items-center gap-2 text-xs text-ink-400 hover:text-ink-200">
          <ArrowLeft className="size-3.5" /> 返回视频库
        </Link>
        <AlertBanner tone="danger" title="无法打开视频">
          {error ?? "视频不存在或已删除"}
        </AlertBanner>
      </div>
    );
  }

  const shareLink = detail.shares.find((share) => share.shareUrl)?.shareUrl ?? null;
  const ready = detail.status === "ready" && detail.streamUrl;
  const progressPercent =
    detail.durationSeconds && detail.positionSeconds
      ? Math.min(100, (detail.positionSeconds / detail.durationSeconds) * 100)
      : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Link
          to="/videos"
          className="inline-flex items-center gap-2 text-xs text-ink-400 transition hover:text-ink-200"
        >
          <ArrowLeft className="size-3.5" /> 返回视频库
        </Link>
        <div className="flex items-center gap-2">
          <VideoStatusBadge status={detail.status} />
          {detail.status === "ready" && detail.availability?.state === "unavailable" ? (
            <Badge tone="danger">
              <AlertTriangle className="size-3" /> 平台不可访问
            </Badge>
          ) : null}
          {detail.isFavorite ? (
            <Badge tone="brand">
              <Heart className="size-3 fill-current" /> 收藏
            </Badge>
          ) : null}
        </div>
      </div>

      {detail.status === "ready" && detail.availability?.state === "unavailable" ? (
        <AlertBanner tone="warning" title="原作品当前不可访问">
          平台返回该作品已删除、私密或不可访问。本地缓存仍可正常播放；删除后将无法再从平台重新下载。
        </AlertBanner>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <div className="space-y-4">
          <Card className="overflow-hidden p-0">
            <div className="relative flex max-h-[72dvh] min-h-[320px] items-center justify-center bg-black">
              {ready ? (
                <video
                  ref={videoRef}
                  src={detail.streamUrl ?? undefined}
                  poster={detail.coverUrl ?? undefined}
                  controls
                  playsInline
                  preload="metadata"
                  className="max-h-[72dvh] w-full object-contain"
                  onLoadedMetadata={onLoadedMetadata}
                  onTimeUpdate={(event) => {
                    currentPosition.current = event.currentTarget.currentTime;
                    saveProgress(false);
                  }}
                  onPause={() => saveProgress(true)}
                  onEnded={() => {
                    currentPosition.current = currentDuration.current ?? 0;
                    saveProgress(true);
                  }}
                  onError={() => setPlayerError("浏览器无法播放该文件，请检查媒体完整性或重新下载。")}
                  onRateChange={(event) => setPlaybackRate(event.currentTarget.playbackRate)}
                />
              ) : (
                <div className="relative w-full max-w-md">
                  <VideoCover
                    coverUrl={detail.coverUrl}
                    title={detail.title}
                    className="aspect-[9/13] w-full"
                  />
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/45 p-6 text-center backdrop-blur-[2px]">
                    {detail.status === "failed" ? (
                      <AlertTriangle className="size-7 text-red-400" />
                    ) : (
                      <RefreshCw className="size-7 animate-spin text-ink-300" style={{ animationDuration: "3s" }} />
                    )}
                    <div>
                      <p className="text-sm font-medium text-white">
                        {detail.status === "failed" ? "缓存失败" : "正在缓存"}
                      </p>
                      <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-white/60">
                        {detail.lastError?.message ?? "下载完成后即可在本地播放。"}
                      </p>
                    </div>
                    {detail.job && ["failed", "pending"].includes(detail.status) ? (
                      <Button size="sm" variant="primary" icon={RotateCcw} onClick={() => void retry()} loading={retrying}>
                        重新下载
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
              {resumedFrom ? (
                <div className="absolute bottom-3 left-3 rounded-lg border border-white/10 bg-black/70 px-3 py-1.5 text-[11px] text-white/80 backdrop-blur">
                  已从上次位置 {formatDuration(resumedFrom)} 继续
                </div>
              ) : null}
              {playerError ? (
                <div className="absolute inset-x-4 top-4">
                  <AlertBanner tone="danger" title="播放失败">{playerError}</AlertBanner>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-3">
              <div className="flex items-center gap-2 text-[11px] text-ink-500">
                <Gauge className="size-3.5" />
                <span>播放速度</span>
                <select
                  value={playbackRate}
                  onChange={(event) => {
                    const rate = Number(event.target.value);
                    setPlaybackRate(rate);
                    if (videoRef.current) videoRef.current.playbackRate = rate;
                  }}
                  className="rounded-md border border-white/[0.08] bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-300"
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" icon={Maximize} onClick={fullscreen} disabled={!ready}>
                  全屏
                </Button>
                <Button
                  size="sm"
                  variant={detail.isFavorite ? "primary" : "outline"}
                  icon={Heart}
                  onClick={() => void toggleFavorite()}
                >
                  {detail.isFavorite ? "已收藏" : "收藏"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  icon={detail.isWatched ? EyeOff : Eye}
                  onClick={() => void toggleWatched()}
                >
                  {detail.isWatched ? "标记未看" : "标记已看"}
                </Button>
              </div>
            </div>
            {detail.status === "ready" && detail.durationSeconds ? (
              <div className="border-t border-white/[0.06] px-4 py-2.5">
                <div className="flex items-center gap-3 text-[10px] text-ink-500">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="h-full rounded-full bg-brand-500/70" style={{ width: `${progressPercent}%` }} />
                  </div>
                  <span className="tabular-nums">
                    {formatDuration(detail.positionSeconds)} / {formatDuration(detail.durationSeconds)}
                  </span>
                </div>
              </div>
            ) : null}
          </Card>

          <div>
            <h1 className="text-balance text-xl font-semibold leading-snug tracking-tight text-ink-50 sm:text-2xl">
              {detail.title?.trim() || "未命名视频"}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-500">
              {detail.authorName ? (
                <span className="inline-flex items-center gap-1.5">
                  <UserRound className="size-3.5" /> {detail.authorName}
                </span>
              ) : null}
              {detail.workId ? (
                <>
                  <span className="size-0.5 rounded-full bg-ink-600" />
                  <span className="font-mono text-[10px]">作品 {detail.workId}</span>
                </>
              ) : null}
              <span className="size-0.5 rounded-full bg-ink-600" />
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock className="size-3.5" /> {formatRelative(detail.latestSharedAt)}分享
              </span>
              {detail.isWatched ? (
                <Badge tone="success" className="ml-auto">已观看</Badge>
              ) : (
                <Badge tone="neutral" className="ml-auto">未观看</Badge>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={Copy}
              onClick={() => void copyLink()}
              disabled={!shareLink}
            >
              复制原始链接
            </Button>
            {detail.job && detail.job.status !== "COMPLETED" ? (
              <Button
                variant="outline"
                size="sm"
                icon={RotateCcw}
                onClick={() => void retry()}
                loading={retrying}
                disabled={detail.job.status === "DOWNLOADING" || detail.job.status === "RESOLVING"}
              >
                重新下载
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              className="text-red-300 hover:bg-red-500/10 hover:text-red-200"
              onClick={() => setConfirmDelete(true)}
            >
              删除视频
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-100">缓存信息</h2>
            <dl className="mt-4 space-y-3 text-xs">
              <div className="flex items-center justify-between gap-4">
                <dt className="flex items-center gap-2 text-ink-500"><HardDrive className="size-3.5" /> 文件大小</dt>
                <dd className="text-ink-300">{formatBytes(detail.fileSize)}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="flex items-center gap-2 text-ink-500"><FileVideo2 className="size-3.5" /> 时长</dt>
                <dd className="text-ink-300">{formatDuration(detail.durationSeconds)}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-500">分辨率</dt>
                <dd className="text-ink-300">
                  {detail.width && detail.height ? `${detail.width} × ${detail.height}` : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-500">保存时间</dt>
                <dd className="text-right text-ink-300">{formatDate(detail.downloadedAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-500">分享来源</dt>
                <dd className="text-ink-300">{detail.shareCount} 次</dd>
              </div>
              {detail.sha256 ? (
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-ink-500">SHA-256</dt>
                  <dd className="font-mono text-[10px] text-ink-500">{truncate(detail.sha256, 20)}</dd>
                </div>
              ) : null}
            </dl>
          </Card>

          {detail.job ? (
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink-100">下载任务</h2>
                <JobStatusBadge status={detail.job.status as never} />
              </div>
              <dl className="mt-4 space-y-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <dt className="text-ink-500">尝试次数</dt>
                  <dd className="text-ink-300">{detail.job.attempts} / {detail.job.maxAttempts}</dd>
                </div>
                {detail.job.nextRetryAt ? (
                  <div className="flex items-center justify-between">
                    <dt className="text-ink-500">下次重试</dt>
                    <dd className="text-ink-300">{formatWhen(detail.job.nextRetryAt)}</dd>
                  </div>
                ) : null}
                {detail.job.errorCode ? (
                  <div className="rounded-lg border border-red-500/15 bg-red-500/[0.06] p-2.5">
                    <p className="font-mono text-[10px] text-red-300/80">{detail.job.errorCode}</p>
                    <p className="mt-1 leading-relaxed text-red-200/80">{detail.job.errorMessage}</p>
                  </div>
                ) : null}
              </dl>
            </Card>
          ) : null}

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <h2 className="text-sm font-semibold text-ink-100">全部群聊来源</h2>
              <Badge tone="muted">{detail.shares.length}</Badge>
            </div>
            <div className="max-h-80 divide-y divide-white/[0.05] overflow-y-auto">
              {detail.shares.map((share) => (
                <div key={share.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-ink-200">
                      <MessageSquare className="size-3.5 shrink-0 text-ink-500" />
                      <span className="truncate">{share.groupName}</span>
                    </p>
                    <span className="shrink-0 text-[10px] text-ink-500">{formatDate(share.sharedAt)}</span>
                  </div>
                  <p className="mt-1.5 pl-5 text-[11px] text-ink-500">
                    {share.senderName || "未知分享人"}
                    {share.shareUrl ? (
                      <span className="ml-2 inline-flex items-center gap-1 text-ink-600">
                        <Wifi className="size-3" /> 来源在线
                      </span>
                    ) : null}
                  </p>
                </div>
              ))}
            </div>
          </Card>

          <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 text-[11px] text-ink-500">
            <span className="inline-flex items-center gap-1.5">
              <Share2 className="size-3.5" /> 同一作品只保存一份文件
            </span>
            <span>{detail.shareCount > 1 ? `${detail.shareCount} 个来源已合并` : "单一来源"}</span>
          </div>
        </div>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="从本地删除这个视频？"
        description="媒体文件与全部来源引用会一并删除，群聊消息本身不会受到影响。"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              保留
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={deleting}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-xs leading-relaxed text-ink-400">
          如果作品仍在平台可访问，你之后可以通过下载队列手动重新缓存。已收藏的视频同样会被删除。
        </p>
      </Modal>
    </div>
  );
}
