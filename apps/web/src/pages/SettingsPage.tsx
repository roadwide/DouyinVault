import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArchiveX,
  CheckCircle2,
  DatabaseBackup,
  HardDrive,
  KeyRound,
  LogOut,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { api } from "../api/client";
import type {
  CleanupLog,
  CleanupResult,
  SettingsResponse,
  SystemSnapshot,
  UnresolvedItem,
  VaultSettings,
} from "../api/types";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../components/Toast";
import {
  AlertBanner,
  Badge,
  Button,
  Card,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Switch,
} from "../components/ui";
import {
  cn,
  errorMessage,
  formatBytes,
  formatDate,
  formatRelative,
  truncate,
} from "../lib/utils";

function cleanupLogSummary(log: CleanupLog): string {
  if (log.detail) {
    try {
      const detail = JSON.parse(log.detail) as Record<string, unknown>;
      if (log.reason === "run_summary") {
        const trigger = detail.trigger === "startup" ? "启动检查" : detail.trigger === "scheduled" ? "定时清理" : "手动清理";
        return `${trigger} · 删除 ${Number(detail.deletedVideos ?? 0)} 个视频 · 失败记录 ${Number(detail.failedRecordsDeleted ?? 0)} 条 · 临时文件 ${Number(detail.staleTempDeleted ?? 0)} 个`;
      }
      if (typeof detail.title === "string") return detail.title;
      if (typeof detail.count === "number") return `${detail.count} 个无引用文件`;
    } catch {
      // Fall back to the raw reference below.
    }
  }
  return log.videoRef ? `视频 ${log.videoRef}` : "—";
}

const REASON_LABELS: Record<string, string> = {
  expired_watched: "已观看超过保留期",
  expired_unwatched: "未观看超过保留期",
  capacity_watched: "容量清理（已观看）",
  capacity_unwatched: "容量清理（未观看）",
  manual: "手动删除",
  failed_record_expired: "失败记录过期",
  orphan_file: "无引用文件",
  stale_temp: "过期临时文件",
  missing_file: "媒体文件缺失",
  run_summary: "清理任务汇总",
  duplicate_media: "重复媒体合并",
};

function SettingRow({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-200">{title}</p>
        {description && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const { logout: logoutAdmin } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [form, setForm] = useState<VaultSettings | null>(null);
  const [retryDelaysText, setRetryDelaysText] = useState("30, 120, 600");
  const [logs, setLogs] = useState<CleanupLog[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [settings, status, cleanupLogs, unresolvedList] = await Promise.all([
        api.get<SettingsResponse>("/api/v1/settings"),
        api.get<SystemSnapshot>("/api/v1/system/status"),
        api.get<{ items: CleanupLog[] }>("/api/v1/system/cleanup-logs?limit=20"),
        api.get<{ items: UnresolvedItem[] }>("/api/v1/system/unresolved"),
      ]);
      setData(settings);
      setSnapshot(status);
      setForm(settings.settings);
      setRetryDelaysText(settings.settings.download.retryDelaysSeconds.join(", "));
      setLogs(cleanupLogs.items);
      setUnresolved(unresolvedList.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof VaultSettings>(key: K, value: VaultSettings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async () => {
    if (!form) return;
    const delays = retryDelaysText
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item) && item >= 5);
    if (delays.length === 0) {
      toast("重试间隔至少需要一个不少于 5 秒的数值", "error");
      return;
    }
    setSaving(true);
    try {
      const result = await api.patch<{ settings: VaultSettings }>("/api/v1/settings", {
        ...form,
        download: { ...form.download, retryDelaysSeconds: delays },
      });
      setForm(result.settings);
      toast("设置已保存", "success");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const runCleanup = async () => {
    setBusy("cleanup");
    try {
      const result = await api.post<{ result: CleanupResult }>("/api/v1/cleanup/run");
      setCleanupResult(result.result);
      toast(
        `清理完成：删除 ${result.result.deletedVideos} 个视频，释放 ${formatBytes(result.result.freedBytes)}`,
        "success",
      );
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const runBackup = async () => {
    setBusy("backup");
    try {
      const result = await api.post<{ bytes: number }>("/api/v1/backup/run");
      toast(`数据库备份完成（${formatBytes(result.bytes)}）`, "success");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const logoutDouyin = async () => {
    setBusy("logout");
    try {
      await api.post("/api/v1/auth/logout");
      toast("抖音账号已退出，监听已暂停", "success");
      setLogoutOpen(false);
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  if (loading || !data || !form) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);

  return (
    <div className="space-y-5">
      <PageHeader
        title="设置"
        description="容量、保留期与下载策略保存在本地数据库中，修改后立即影响后台调度。"
        actions={
          <>
            {dirty ? <Badge tone="warning">有未保存修改</Badge> : null}
            <Button variant="primary" icon={Save} onClick={() => void save()} loading={saving}>
              保存设置
            </Button>
          </>
        }
      />

      {error ? <AlertBanner tone="danger" title="加载设置失败">{error}</AlertBanner> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <Play className="size-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-ink-100">下载行为</h2>
          </div>
          <div className="mt-2 divide-y divide-white/[0.05]">
            <SettingRow title="自动下载" description="关闭后新任务只排队不下载，已有任务也不继续。">
              <Switch
                checked={form.download.enabled}
                onChange={(next) => set("download", { ...form.download, enabled: next })}
              />
            </SettingRow>
            <SettingRow title="并行下载数" description="单机建议 2；过高可能触发平台限流。">
              <Input
                type="number"
                min={1}
                max={8}
                value={form.download.concurrency}
                onChange={(event) =>
                  set("download", { ...form.download, concurrency: Number(event.target.value) })
                }
                className="w-24 text-center"
              />
            </SettingRow>
            <SettingRow title="首选清晰度" description="下载适配器会根据可用资源尽量匹配。">
              <Select
                value={form.download.preferredQuality}
                onChange={(event) =>
                  set("download", {
                    ...form.download,
                    preferredQuality: event.target.value as VaultSettings["download"]["preferredQuality"],
                  })
                }
                className="w-28"
              >
                <option value="540p">540p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="best">最佳</option>
              </Select>
            </SettingRow>
            <SettingRow title="最大尝试次数" description="永久性失败不会无限重试。">
              <Input
                type="number"
                min={1}
                max={10}
                value={form.download.maxAttempts}
                onChange={(event) =>
                  set("download", { ...form.download, maxAttempts: Number(event.target.value) })
                }
                className="w-24 text-center"
              />
            </SettingRow>
            <SettingRow title="重试间隔（秒）" description="逗号分隔，依次使用；超过列表长度后使用最后一个。">
              <Input
                value={retryDelaysText}
                onChange={(event) => setRetryDelaysText(event.target.value)}
                className="w-44"
                placeholder="30, 120, 600"
              />
            </SettingRow>
            <SettingRow title="单任务超时（秒）" description="超时后有限重试；支持 Range 时保留临时文件续传。">
              <Input
                type="number"
                min={10}
                max={3600}
                value={form.download.timeoutSeconds}
                onChange={(event) =>
                  set("download", { ...form.download, timeoutSeconds: Number(event.target.value) })
                }
                className="w-24 text-center"
              />
            </SettingRow>
            <SettingRow
              title="使用 ffprobe 校验"
              description="在写入视频库前检查视频轨道、时长与分辨率；建议保持开启。"
            >
              <Switch
                checked={form.download.verifyWithFfprobe}
                onChange={(next) => set("download", { ...form.download, verifyWithFfprobe: next })}
              />
            </SettingRow>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <ArchiveX className="size-4 text-aqua-400" />
            <h2 className="text-sm font-semibold text-ink-100">保留与观看</h2>
          </div>
          <div className="mt-2 divide-y divide-white/[0.05]">
            <SettingRow title="未观看保留天数" description="从缓存成功起算。未到期且未超容量时不会被清理。">
              <Input
                type="number"
                min={1}
                max={3650}
                value={form.retention.unwatchedDays}
                onChange={(event) =>
                  set("retention", { ...form.retention, unwatchedDays: Number(event.target.value) })
                }
                className="w-24 text-center"
              />
            </SettingRow>
            <SettingRow title="已观看保留天数" description="从标记已观看的时间起算，先于未观看视频被清理。">
              <Input
                type="number"
                min={0}
                max={3650}
                value={form.retention.watchedDays}
                onChange={(event) =>
                  set("retention", { ...form.retention, watchedDays: Number(event.target.value) })
                }
                className="w-24 text-center"
              />
            </SettingRow>
            <SettingRow title="失败记录保留天数" description="只清理失败记录与任务，不影响成功视频。">
              <Input
                type="number"
                min={1}
                max={365}
                value={form.retention.failedDays}
                onChange={(event) =>
                  set("retention", { ...form.retention, failedDays: Number(event.target.value) })
                }
                className="w-24 text-center"
              />
            </SettingRow>
            <SettingRow title="临时文件保留小时" description="超过时限且无活动任务的 .part 文件会被清理。">
              <Input
                type="number"
                min={1}
                max={720}
                value={form.retention.tempHours}
                onChange={(event) =>
                  set("retention", { ...form.retention, tempHours: Number(event.target.value) })
                }
                className="w-24 text-center"
              />
            </SettingRow>
            <SettingRow title="自动标记已观看" description="播放超过该比例后标记已观看，并开始计算已观看保留期。">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={50}
                  max={100}
                  value={Math.round(form.watchedThreshold * 100)}
                  onChange={(event) =>
                    set("watchedThreshold", Math.max(0.5, Math.min(1, Number(event.target.value) / 100)))
                  }
                  className="w-20 text-center"
                />
                <span className="text-xs text-ink-500">%</span>
              </div>
            </SettingRow>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <HardDrive className="size-4 text-amber-300" />
            <h2 className="text-sm font-semibold text-ink-100">容量与磁盘</h2>
          </div>
          <div className="mt-2 divide-y divide-white/[0.05]">
            <SettingRow title="缓存容量上限（GB）" description="软配额。超限时暂停新增下载，不强制删除受保护视频。">
              <Input
                type="number"
                min={1}
                max={10000}
                value={form.storage.capacityGb}
                onChange={(event) =>
                  set("storage", { ...form.storage, capacityGb: Number(event.target.value) })
                }
                className="w-28 text-center"
              />
            </SettingRow>
            <SettingRow title="磁盘安全预留（GB）" description="剩余空间低于该值时立即暂停下载，优先级高于容量上限。">
              <Input
                type="number"
                min={0}
                max={1000}
                value={form.storage.safetyReserveGb}
                onChange={(event) =>
                  set("storage", { ...form.storage, safetyReserveGb: Number(event.target.value) })
                }
                className="w-28 text-center"
              />
            </SettingRow>
          </div>
          <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-500">当前缓存占用</span>
              <span className="tabular-nums text-ink-200">
                {formatBytes(snapshot?.storage.usedBytes)} / {formatBytes(snapshot?.storage.capacityBytes)}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-400"
                style={{ width: `${Math.min(100, snapshot?.storage.percent ?? 0)}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-ink-600">
              <span>磁盘剩余 {formatBytes(snapshot?.storage.freeBytes)}</span>
              <span>安全预留 {formatBytes(snapshot?.storage.safetyReserveBytes)}</span>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-ink-100">自动清理</h2>
          </div>
          <div className="mt-2 divide-y divide-white/[0.05]">
            <SettingRow title="启用定期清理" description="每天执行一次，启动时先做文件一致性检查。">
              <Switch
                checked={form.cleanup.enabled}
                onChange={(next) => set("cleanup", { ...form.cleanup, enabled: next })}
              />
            </SettingRow>
            <SettingRow title="执行时刻（本地时间）" description="运行服务的 Mac 时区，建议设置在凌晨。">
              <Select
                value={String(form.cleanup.runHourLocal)}
                onChange={(event) =>
                  set("cleanup", { ...form.cleanup, runHourLocal: Number(event.target.value) })
                }
                className="w-24"
              >
                {Array.from({ length: 24 }).map((_, hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </SettingRow>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
            <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-2.5">
              <dt className="text-ink-600">上次清理</dt>
              <dd className="mt-0.5 text-ink-300">{formatRelative(data.cleanup.lastRunAt)}</dd>
            </div>
            <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-2.5">
              <dt className="text-ink-600">下次计划</dt>
              <dd className="mt-0.5 text-ink-300">{formatDate(data.cleanup.nextRunAt)}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              icon={Trash2}
              onClick={() => void runCleanup()}
              loading={busy === "cleanup"}
            >
              立即清理
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={DatabaseBackup}
              onClick={() => void runBackup()}
              loading={busy === "backup"}
            >
              备份数据库
            </Button>
          </div>
          {cleanupResult ? (
            <div className="mt-4 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.05] p-3.5 text-[11px] leading-relaxed text-emerald-100/80">
              <p className="flex items-center gap-1.5 font-medium text-emerald-200">
                <CheckCircle2 className="size-3.5" /> 清理完成
              </p>
              <p className="mt-1">
                删除视频 {cleanupResult.deletedVideos} 个 · 失败记录 {cleanupResult.failedRecordsDeleted} 条 · 临时文件{" "}
                {cleanupResult.staleTempDeleted} 个 · 孤儿文件 {cleanupResult.orphanFilesDeleted} 个 · 释放{" "}
                {formatBytes(cleanupResult.freedBytes)}
              </p>
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-100">最近清理审计</h2>
              <p className="mt-0.5 text-[11px] text-ink-500">收藏视频永不自动删除</p>
            </div>
            <Badge tone="muted">{logs.length}</Badge>
          </div>
          <div className="max-h-72 divide-y divide-white/[0.05] overflow-y-auto">
            {logs.length === 0 ? (
              <p className="px-5 py-8 text-center text-xs text-ink-500">还没有清理记录</p>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex items-center justify-between gap-4 px-5 py-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium text-ink-300">
                      {REASON_LABELS[log.reason] ?? log.reason}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-ink-600">
                      {cleanupLogSummary(log)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular-nums text-ink-400">{formatBytes(log.freedBytes)}</p>
                    <p className="mt-0.5 text-[10px] text-ink-600">{formatDate(log.createdAt)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-100">诊断与限制</h2>
            <Button size="sm" variant="ghost" onClick={() => setDiagnosticsOpen(true)}>
              查看详情
            </Button>
          </div>
          <div className="mt-3 space-y-2.5 text-[11px] leading-relaxed text-ink-400">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
              <span>{unresolved.length} 条视频卡片暂未解析，已保留脱敏诊断信息。</span>
            </div>
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
              <span>管理会话 Cookie、抖音 Session 与签名媒体地址不会出现在 API 响应或日志中。</span>
            </div>
            <dl className="mt-3 space-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[10px]">
              <div className="flex justify-between gap-4"><dt className="text-ink-600">IM 适配器</dt><dd className="text-ink-300">{data.environment.adapter}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-600">下载 API</dt><dd className="text-ink-300">{data.environment.dtkConfigured ? `已配置（${data.environment.dtkMode}）` : "未配置"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-600">yt-dlp</dt><dd className="truncate font-mono text-ink-300">{data.environment.ytdlpPath}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-600">ffprobe</dt><dd className="truncate font-mono text-ink-300">{data.environment.ffprobePath}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-600">运行环境</dt><dd className="text-ink-300">{data.environment.nodeEnv}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-600">上次备份</dt><dd className="text-ink-300">{formatRelative(data.backup.lastRunAt)}</dd></div>
            </dl>
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink-100">账号与安全</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
              退出抖音会暂停所有群监听，但不删除已缓存视频。管理后台会话与抖音 Session 相互独立。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" icon={KeyRound} onClick={() => setLogoutOpen(true)}>
              退出抖音账号
            </Button>
            <Button
              variant="ghost"
              icon={LogOut}
              className="text-red-300 hover:bg-red-500/10"
              onClick={() => void logoutAdmin()}
            >
              退出管理后台
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-[10px] text-ink-600">
        <span className="inline-flex items-center gap-1.5"><TerminalSquare className="size-3.5" /> 配置文件与数据库位于 data/，请将备份视为敏感数据</span>
        <span>v{snapshot?.version ?? "0.1.0"}</span>
      </div>

      <Modal
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        title="退出抖音账号？"
        description="所有群聊将暂停监听。已缓存的视频与观看记录不会受影响。"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setLogoutOpen(false)}>取消</Button>
            <Button variant="danger" onClick={() => void logoutDouyin()} loading={busy === "logout"}>
              退出并暂停监听
            </Button>
          </>
        }
      >
        <p className="text-xs leading-relaxed text-ink-400">
          重新登录后需要再次确认需要监听的群。新加入的群不会自动启用。
        </p>
      </Modal>

      <Modal
        open={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        title="未解析的视频卡片"
        description="这些消息没有可靠的作品 ID。系统保留消息元数据，方便后续更换适配器后重新处理。"
        size="lg"
      >
        {unresolved.length === 0 ? (
          <p className="py-8 text-center text-xs text-ink-500">没有未解析记录。</p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {unresolved.map((item) => (
              <div key={item.id} className="py-3 first:pt-0">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-ink-200">{item.group.name}</span>
                  <Badge tone="muted">{item.type}</Badge>
                  <span className="text-ink-500">{formatDate(item.sentAt)}</span>
                  {item.senderName ? <span className="text-ink-500">· {item.senderName}</span> : null}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
                  {item.diagnostic || "适配器没有返回可解析的作品标识。"}
                </p>
                {item.workId ? <p className="mt-1 font-mono text-[10px] text-ink-600">作品 {item.workId}</p> : null}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
