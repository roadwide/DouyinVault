import { Link } from "react-router-dom";
import { Check, Heart, Eye, EyeOff, Clock3, AlertTriangle } from "lucide-react";
import type { VideoView } from "../api/types";
import { cn, formatRelative, truncate } from "../lib/utils";
import { VideoCover } from "./VideoCover";
import { Badge } from "./ui";
import { VideoStatusBadge } from "./StatusBadge";

export function VideoCard({
  video,
  selectionMode = false,
  selected = false,
  onSelect,
  layout = "grid",
}: {
  video: VideoView;
  selectionMode?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
  layout?: "grid" | "list";
}) {
  const content = (
    <>
      <div className={cn("relative shrink-0 overflow-hidden", layout === "grid" ? "aspect-[4/5]" : "w-28 self-stretch sm:w-32")}>
        <VideoCover
          coverUrl={video.coverUrl}
          title={video.title}
          duration={video.durationSeconds}
          rounded="rounded-none"
          className="absolute inset-0 size-full"
        />
        <div className="absolute left-2 top-2 flex max-w-[calc(100%-1rem)] flex-wrap gap-1">
          {video.status === "ready" && video.availability?.state === "unavailable" ? (
            <span
              title="平台返回该作品已删除、私密或不可访问"
              className="flex items-center gap-1 rounded-full bg-red-500/85 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur"
            >
              <AlertTriangle className="size-3" /> 平台不可访问
            </span>
          ) : null}
          {video.isWatched ? (
            <span className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-emerald-300 backdrop-blur">
              <Eye className="size-3" /> 已看
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur">
              <EyeOff className="size-3" /> 未看
            </span>
          )}
        </div>
        {video.isFavorite ? (
          <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-black/55 backdrop-blur">
            <Heart className="size-3.5 fill-brand-500 text-brand-500" />
          </span>
        ) : null}
        {selectionMode ? (
          <span
            className={cn(
              "absolute bottom-2 right-2 flex size-6 items-center justify-center rounded-full border transition",
              selected
                ? "border-brand-400 bg-brand-500 text-white"
                : "border-white/40 bg-black/40 text-transparent backdrop-blur",
            )}
          >
            <Check className="size-3.5" />
          </span>
        ) : null}
      </div>

      <div className={cn("flex min-w-0 flex-1 flex-col", layout === "grid" ? "gap-1.5 p-3.5" : "gap-2 py-3 pr-3")}>
        <div className="flex items-start gap-2">
          <h3
            className={cn(
              "flex-1 font-medium leading-snug text-ink-100",
              layout === "grid" ? "line-clamp-2 min-h-[2.5rem] text-[13px]" : "text-sm",
            )}
          >
            {video.title?.trim() || "未命名视频"}
          </h3>
          {video.status !== "ready" ? <VideoStatusBadge status={video.status} /> : null}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-500">
          {video.latestGroup ? (
            <span className="max-w-[10rem] truncate text-ink-400">{video.latestGroup.name}</span>
          ) : (
            <span>未知来源</span>
          )}
          {video.latestSender ? (
            <>
              <span className="size-0.5 rounded-full bg-ink-600" />
              <span className="max-w-[6rem] truncate">{video.latestSender}</span>
            </>
          ) : null}
          <span className="size-0.5 rounded-full bg-ink-600" />
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3" />
            {formatRelative(video.latestSharedAt)}
          </span>
          {video.shareCount > 1 ? (
            <Badge tone="muted" className="ml-auto px-1.5 py-0 text-[10px]">
              {video.shareCount} 次分享
            </Badge>
          ) : null}
        </div>
        {video.status === "failed" && video.lastError ? (
          <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-red-300/80">
            <AlertTriangle className="size-3 shrink-0" />
            <span className="line-clamp-1">{truncate(video.lastError.message, 80)}</span>
          </p>
        ) : null}
      </div>
    </>
  );

  const className = cn(
    "group panel panel-hover relative overflow-hidden",
    layout === "grid" ? "flex flex-col" : "flex flex-row",
    selected && "border-brand-500/40 ring-1 ring-brand-500/30",
    selectionMode && "cursor-pointer",
  );

  if (selectionMode) {
    return (
      <button
        type="button"
        onClick={() => onSelect?.(video.id)}
        className={cn(className, "text-left")}
        aria-pressed={selected}
      >
        {content}
      </button>
    );
  }

  return (
    <Link to={`/videos/${video.id}`} className={className}>
      {content}
    </Link>
  );
}
