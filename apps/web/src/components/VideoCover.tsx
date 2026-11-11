import { Film, Play } from "lucide-react";
import { cn, formatDuration } from "../lib/utils";

export function VideoCover({
  coverUrl,
  title,
  duration,
  className,
  rounded = "rounded-xl",
}: {
  coverUrl: string | null;
  title: string | null;
  duration?: number | null;
  className?: string;
  rounded?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-gradient-to-br from-ink-800 via-ink-850 to-ink-900",
        rounded,
        className,
      )}
    >
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          className="absolute inset-0 size-full object-cover transition duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_30%_20%,rgba(254,44,85,0.18),transparent_55%),radial-gradient(circle_at_75%_80%,rgba(37,244,238,0.1),transparent_50%)]">
          <Film className="size-7 text-white/20" />
          <span className="max-w-[80%] truncate text-[10px] text-white/25">{title ?? "等待封面"}</span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent" />
      {duration ? (
        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/90 backdrop-blur">
          {formatDuration(duration)}
        </span>
      ) : null}
      <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
        <span className="flex size-10 items-center justify-center rounded-full border border-white/20 bg-black/50 backdrop-blur">
          <Play className="ml-0.5 size-4 fill-white text-white" />
        </span>
      </div>
    </div>
  );
}
