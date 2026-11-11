import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  CheckSquare,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api, buildQuery } from "../api/client";
import type { GroupListResponse, VideoListResponse, VideoView } from "../api/types";
import { useVaultEvent } from "../hooks/EventsProvider";
import { VideoCard } from "../components/VideoCard";
import {
  AlertBanner,
  Button,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
} from "../components/ui";
import { useToast } from "../components/Toast";
import { cn, errorMessage } from "../lib/utils";

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "unwatched", label: "未观看" },
  { value: "watched", label: "已观看" },
  { value: "favorites", label: "收藏" },
  { value: "failed", label: "失败" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

export function LibraryPage() {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [groupId, setGroupId] = useState("");
  const [sort, setSort] = useState("latest");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [items, setItems] = useState<VideoView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupListResponse["items"]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const refreshTimer = useRef(0);
  const { toast } = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (reset: boolean, refreshAvailability = false) => {
      const offset = reset ? 0 : items.length;
      if (reset) {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const query = buildQuery({
          filter,
          groupId: groupId || undefined,
          q: debouncedSearch || undefined,
          sort,
          limit: 24,
          offset,
          refresh: refreshAvailability ? 1 : undefined,
        });
        const result = await api.get<VideoListResponse>(
          `/api/v1/videos${query}`,
          reset ? abortRef.current?.signal : undefined,
        );
        setItems((current) => (reset ? result.items : [...current, ...result.items]));
        setTotal(result.total);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(errorMessage(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [debouncedSearch, filter, groupId, items.length, sort],
  );

  // Manual refresh rechecks source availability; background reloads use the
  // short-lived server cache so filters and SSE events stay fast.
  const reload = useCallback(() => void load(true, true), [load]);

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, groupId, sort, debouncedSearch]);

  useEffect(() => {
    api
      .get<GroupListResponse>("/api/v1/groups")
      .then((result) => setGroups(result.items))
      .catch(() => undefined);
  }, []);

  useVaultEvent(
    (event) => {
      if (
        event.type === "download.completed" ||
        event.type === "video.deleted" ||
        event.type === "message.detected" ||
        event.type === "system.status_changed"
      ) {
        const now = Date.now();
        if (now - refreshTimer.current > 1500) {
          refreshTimer.current = now;
          void load(true);
        }
      }
    },
    ["download.completed", "video.deleted", "message.detected", "system.status_changed"],
  );

  // Keep the source-availability tags fresh while the library stays open
  // without resetting the list, scroll position, or pagination.
  const refreshAvailability = useCallback(async () => {
    if (items.length === 0 || document.visibilityState !== "visible") return;
    try {
      const query = buildQuery({
        filter,
        groupId: groupId || undefined,
        q: debouncedSearch || undefined,
        sort,
        limit: Math.min(items.length, 60),
        offset: 0,
        refresh: 1,
      });
      const result = await api.get<VideoListResponse>(`/api/v1/videos${query}`);
      const availability = new Map(result.items.map((item) => [item.id, item.availability]));
      setItems((current) =>
        current.map((item) => {
          const next = availability.get(item.id);
          return next ? { ...item, availability: next } : item;
        }),
      );
    } catch {
      // Keep the previous tags; the next manual or timed refresh can recover.
    }
  }, [debouncedSearch, filter, groupId, items.length, sort]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshAvailability(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshAvailability]);

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelected(new Set());
  };

  const batchDelete = async () => {
    setDeleting(true);
    try {
      const result = await api.post<{ deleted: number; failed: number; freedBytes: number }>(
        "/api/v1/videos/batch-delete",
        { ids: [...selected] },
      );
      toast(
        `已删除 ${result.deleted} 个视频，释放 ${Math.round(result.freedBytes / 1024 / 1024)} MB${
          result.failed ? `，${result.failed} 个失败` : ""
        }`,
        result.failed ? "error" : "success",
      );
      exitSelection();
      setConfirmOpen(false);
      void load(true);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setDeleting(false);
    }
  };

  const activeFilter = FILTERS.find((item) => item.value === filter) ?? FILTERS[0];
  const hasMore = items.length < total;

  return (
    <div className="space-y-5">
      <PageHeader
        title="视频库"
        description="所有自动缓存与手动触发的视频都在这里。卡片只展示一次，详情页保留全部群聊来源。"
        actions={
          <>
            <Button variant="outline" icon={RefreshCw} onClick={reload} loading={loading && items.length === 0}>
              刷新
            </Button>
            {selectionMode ? (
              <Button variant="secondary" icon={X} onClick={exitSelection}>
                取消选择
              </Button>
            ) : (
              <Button
                variant="secondary"
                icon={CheckSquare}
                onClick={() => setSelectionMode(true)}
                disabled={items.length === 0}
              >
                选择
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索标题、作品 ID、分享人…"
              className="pl-10"
            />
            {search ? (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-500 hover:text-ink-200"
                aria-label="清空搜索"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Select value={groupId} onChange={(event) => setGroupId(event.target.value)} className="min-w-36">
              <option value="">全部群聊</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
            <Select value={sort} onChange={(event) => setSort(event.target.value)} className="min-w-32">
              <option value="latest">最近分享</option>
              <option value="downloaded">最近下载</option>
              <option value="oldest">最久分享</option>
              <option value="title">标题排序</option>
            </Select>
            <div className="hidden rounded-xl border border-white/[0.08] p-0.5 sm:flex">
              <button
                onClick={() => setLayout("grid")}
                className={cn(
                  "rounded-lg p-1.5 transition",
                  layout === "grid" ? "bg-white/[0.08] text-ink-100" : "text-ink-500 hover:text-ink-300",
                )}
                aria-label="网格视图"
              >
                <LayoutGrid className="size-4" />
              </button>
              <button
                onClick={() => setLayout("list")}
                className={cn(
                  "rounded-lg p-1.5 transition",
                  layout === "list" ? "bg-white/[0.08] text-ink-100" : "text-ink-500 hover:text-ink-300",
                )}
                aria-label="列表视图"
              >
                <List className="size-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                onClick={() => setFilter(item.value)}
                className={cn(
                  "shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition",
                  filter === item.value
                    ? "border-brand-500/30 bg-brand-500/10 text-brand-300"
                    : "border-white/[0.07] text-ink-400 hover:border-white/[0.14] hover:text-ink-200",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="shrink-0 pl-1 text-[11px] text-ink-500 sm:pl-0">
            {activeFilter.label} · {total} 个视频
          </p>
        </div>
      </div>

      {error ? (
        <AlertBanner tone="danger" title="加载视频库失败">
          {error}
        </AlertBanner>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="aspect-[3/4] w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={Archive}
            title={debouncedSearch ? "没有匹配的视频" : "这个分类还是空的"}
            description={
              debouncedSearch
                ? "试试更换关键词，或清除群聊筛选后再搜索。"
                : "当群友分享视频并且自动缓存成功后，它会出现在这里。未观看的视频默认保留 30 天。"
            }
            action={
              search ? (
                <Button variant="outline" onClick={() => setSearch("")}>
                  清空搜索
                </Button>
              ) : (
                <Button variant="outline" onClick={reload} icon={RefreshCw}>
                  刷新
                </Button>
              )
            }
          />
        </div>
      ) : (
        <>
          <div
            className={cn(
              layout === "grid"
                ? "grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4"
                : "flex flex-col gap-2",
            )}
          >
            {items.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                layout={layout}
                selectionMode={selectionMode}
                selected={selected.has(video.id)}
                onSelect={toggleSelect}
              />
            ))}
          </div>

          <div className="flex items-center justify-center pt-2">
            {hasMore ? (
              <Button
                variant="outline"
                onClick={() => void load(false)}
                loading={loadingMore}
                icon={Loader2}
              >
                加载更多（{items.length} / {total}）
              </Button>
            ) : (
              <p className="text-[11px] text-ink-600">已显示全部 {total} 个视频</p>
            )}
          </div>
        </>
      )}

      {selectionMode ? (
        <div className="fixed inset-x-0 bottom-20 z-50 px-4 lg:bottom-6 lg:left-auto lg:right-8 lg:w-auto">
          <div className="mx-auto flex max-w-lg items-center justify-between gap-3 rounded-2xl border border-white/[0.1] bg-ink-800/95 px-4 py-3 shadow-2xl backdrop-blur-xl lg:min-w-[380px]">
            <div>
              <p className="text-xs font-medium text-ink-100">已选择 {selected.size} 个视频</p>
              <p className="mt-0.5 text-[10px] text-ink-500">删除后媒体文件与引用将一并移除</p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={exitSelection}>
                取消
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={Trash2}
                disabled={selected.size === 0}
                onClick={() => setConfirmOpen(true)}
              >
                删除
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`删除 ${selected.size} 个视频？`}
        description="这会删除本地媒体文件。原始群聊消息不会被修改，已分享到多个群的同一作品只会在你明确删除时移除。"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              保留
            </Button>
            <Button variant="danger" onClick={() => void batchDelete()} loading={deleting}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-xs leading-relaxed text-ink-400">
          删除后无法从本地恢复。若原作品仍在线，可以在详情页重新下载。收藏状态也会随视频记录一起删除。
        </p>
      </Modal>
    </div>
  );
}
