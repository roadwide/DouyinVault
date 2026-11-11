import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Users,
  Video,
  Wifi,
  WifiOff,
} from "lucide-react";
import { api } from "../api/client";
import type { AuthStatus, GroupListResponse, GroupSyncResult, GroupView } from "../api/types";
import { useVaultEvent } from "../hooks/EventsProvider";
import { ConnectDouyinDialog } from "../components/ConnectDouyinDialog";
import { AccountStatusBadge, GroupStatusBadge } from "../components/StatusBadge";
import { useToast } from "../components/Toast";
import {
  AlertBanner,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Switch,
} from "../components/ui";
import { errorMessage, formatRelative, initials, truncate } from "../lib/utils";

export function GroupsPage() {
  const [data, setData] = useState<GroupListResponse | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const refreshTimer = useRef(0);
  const { toast } = useToast();

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const [groups, authStatus] = await Promise.all([
        api.get<GroupListResponse>("/api/v1/groups"),
        api.get<AuthStatus>("/api/v1/auth/status"),
      ]);
      setData(groups);
      setAuth(authStatus);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useVaultEvent(
    (event) => {
      if (
        event.type === "group.status_changed" ||
        event.type === "auth.status_changed" ||
        event.type === "system.status_changed" ||
        event.type === "download.completed"
      ) {
        const now = Date.now();
        if (now - refreshTimer.current > 1200) {
          refreshTimer.current = now;
          void load(true);
        }
      }
    },
    ["group.status_changed", "auth.status_changed", "system.status_changed", "download.completed"],
  );

  const openConnect = useCallback(() => setConnectOpen(true), []);
  const closeConnect = useCallback(() => setConnectOpen(false), []);
  const connected = useCallback(() => void load(), [load]);

  const toggleGroup = async (group: GroupView) => {
    setTogglingId(group.id);
    try {
      await api.patch(`/api/v1/groups/${group.id}`, { enabled: !group.enabled });
      toast(
        group.enabled
          ? `已暂停监听「${group.name}」`
          : `已启用「${group.name}」，正在补拉最近消息`,
        "success",
      );
      window.setTimeout(() => void load(true), 800);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setTogglingId(null);
    }
  };

  const syncGroup = async (group: GroupView) => {
    setSyncingId(group.id);
    try {
      const result = await api.post<{ result: GroupSyncResult }>(`/api/v1/groups/${group.id}/sync`);
      if (result.result.ok) {
        toast(
          result.result.gap
            ? `同步完成，但存在历史缺口：${result.result.gapReason ?? "未能覆盖完整窗口"}`
            : `同步完成：发现 ${result.result.messagesFound} 条消息，其中 ${result.result.messagesNew} 条新增`,
          result.result.gap ? "error" : "success",
        );
      } else {
        toast(result.result.error ?? "同步失败", "error");
      }
      await load(true);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSyncingId(null);
    }
  };

  const refreshList = async () => {
    setRefreshing(true);
    try {
      const result = await api.post<{ syncedGroups: number }>("/api/v1/groups/refresh");
      toast(`已刷新 ${result.syncedGroups} 个群聊`, "success");
      await load(true);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const connectedNow = data?.auth.connected ?? false;
  const groups = data?.items ?? [];
  const enabled = groups.filter((group) => group.enabled);

  return (
    <div className="space-y-5">
      <PageHeader
        title="群聊监听"
        description="默认全部关闭。只有你主动启用的群会被处理，后续加入的新群不会自动开启。"
        actions={
          <>
            <Button variant="outline" icon={RefreshCw} onClick={() => void refreshList()} loading={refreshing}>
              刷新群列表
            </Button>
            {!connectedNow ? (
              <Button variant="primary" icon={Wifi} onClick={openConnect}>
                连接抖音
              </Button>
            ) : (
              <Badge tone="success" dot className="h-9 px-3">
                账号已连接
              </Badge>
            )}
          </>
        }
      />

      {error ? (
        <AlertBanner tone="danger" title="加载群聊失败">{error}</AlertBanner>
      ) : null}

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03]">
              {connectedNow ? (
                <Wifi className="size-4 text-emerald-400" />
              ) : (
                <WifiOff className="size-4 text-amber-400" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-ink-100">
                  {auth?.displayName || (connectedNow ? "抖音账号" : "账号尚未连接")}
                </p>
                <AccountStatusBadge status={auth?.status ?? "LOGIN_REQUIRED"} />
              </div>
              <p className="mt-1 text-[11px] text-ink-500">
                {auth?.lastSuccessfulSyncAt
                  ? `最近成功同步 ${formatRelative(auth.lastSuccessfulSyncAt)}`
                  : "尚无成功同步记录"}
                {auth?.lastError ? ` · ${truncate(auth.lastError, 60)}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-ink-400">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-emerald-400" />
              <span>{enabled.length} 个已启用</span>
            </div>
            <div className="flex items-center gap-1.5">
              <MessageSquare className="size-3.5 text-ink-500" />
              <span>{groups.length} 个群聊</span>
            </div>
            {!connectedNow ? (
              <Button size="sm" variant="outline" onClick={openConnect}>登录</Button>
            ) : null}
          </div>
        </div>
      </Card>

      {loading && groups.length === 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-52" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={MessageSquare}
            title="还没有群聊数据"
            description={
              connectedNow
                ? "点击右上角「刷新群列表」从抖音读取你已加入的群。首次同步只读取群名与成员数，不会自动开启监听。"
                : "先连接抖音账号，成功上线后即可读取群列表。"
            }
            action={
              connectedNow ? (
                <Button variant="outline" icon={RefreshCw} onClick={() => void refreshList()} loading={refreshing}>
                  刷新群列表
                </Button>
              ) : (
                <Button variant="primary" onClick={openConnect}>连接抖音</Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <Card key={group.id} className="relative overflow-hidden p-5" hover>
              <div className="pointer-events-none absolute -right-10 -top-12 size-32 rounded-full bg-brand-500/[0.04] blur-2xl" />
              <div className="relative flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-gradient-to-br from-ink-700 to-ink-850 text-sm font-semibold text-ink-200">
                    {initials(group.name)}
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-ink-100">{group.name}</h3>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-500">
                      {group.memberCount ? (
                        <span className="inline-flex items-center gap-1">
                          <Users className="size-3" /> {group.memberCount} 人
                        </span>
                      ) : null}
                      <span className="font-mono">ID {truncate(group.platformGroupId, 12)}</span>
                    </div>
                  </div>
                </div>
                <Switch
                  checked={group.enabled}
                  onChange={() => void toggleGroup(group)}
                  disabled={togglingId === group.id}
                  label={`${group.enabled ? "暂停" : "启用"}监听 ${group.name}`}
                />
              </div>

              <div className="relative mt-4 flex items-center gap-2">
                <GroupStatusBadge status={group.status} />
                {group.lastSyncGapAt ? (
                  <Badge tone="warning">
                    <AlertTriangle className="size-3" /> 历史缺口
                  </Badge>
                ) : null}
                {group.enabled && !group.lastSuccessfulSyncAt ? (
                  <Badge tone="muted">待首次同步</Badge>
                ) : null}
              </div>

              <dl className="relative mt-4 grid grid-cols-3 gap-2 rounded-xl border border-white/[0.05] bg-white/[0.02] p-3 text-center">
                <div>
                  <dt className="text-[10px] text-ink-600">缓存视频</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink-200">{group.cachedVideoCount}</dd>
                </div>
                <div>
                  <dt className="text-[10px] text-ink-600">最近消息</dt>
                  <dd className="mt-0.5 text-[11px] font-medium text-ink-300">{formatRelative(group.lastMessageAt)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] text-ink-600">最近同步</dt>
                  <dd className="mt-0.5 text-[11px] font-medium text-ink-300">{formatRelative(group.lastSuccessfulSyncAt)}</dd>
                </div>
              </dl>

              {group.lastError ? (
                <p className="relative mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/80">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {truncate(group.lastError, 120)}
                </p>
              ) : group.lastSyncGapAt ? (
                <p className="relative mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/80">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  {group.lastSyncGapReason ?? "上次补拉未能确认完整覆盖，缺口已记录。"}
                </p>
              ) : null}

              <div className="relative mt-4 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-[10px] text-ink-600">
                  <Clock3 className="size-3" />
                  {group.enabled ? "监听实时消息" : "未监听，不保存任何消息"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  icon={RefreshCw}
                  onClick={() => void syncGroup(group)}
                  loading={syncingId === group.id}
                  disabled={!connectedNow || !group.enabled}
                >
                  补拉
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
            <div>
              <h3 className="text-sm font-medium text-ink-100">不会替你把群消息标为已读</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                系统只读取已授权群聊中的分享卡片，不调用主动已读接口。缓存视频不应改变你在抖音中的未读状态。
              </p>
            </div>
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <Video className="mt-0.5 size-4 shrink-0 text-brand-400" />
            <div>
              <h3 className="text-sm font-medium text-ink-100">只缓存视频分享</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                普通文本、图片与表情不会被保存。无法解析的视频卡片会留下诊断记录，方便更换适配器后重新处理。
              </p>
            </div>
          </div>
        </Card>
      </div>

      <ConnectDouyinDialog open={connectOpen} onClose={closeConnect} onConnected={connected} />
    </div>
  );
}
