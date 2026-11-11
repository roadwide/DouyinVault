import { Badge } from "./ui";
import type { AccountStatus, GroupStatus, JobStatus, VideoStatus } from "../api/types";

const accountMap: Record<AccountStatus, { label: string; tone: "success" | "warning" | "danger" | "info" | "muted" }> = {
  UNCONFIGURED: { label: "未配置", tone: "muted" },
  LOGIN_REQUIRED: { label: "需要登录", tone: "warning" },
  AUTHENTICATING: { label: "登录中", tone: "info" },
  CONNECTED: { label: "监听中", tone: "success" },
  DISCONNECTED: { label: "已断开", tone: "danger" },
  RECONNECTING: { label: "重连中", tone: "warning" },
  VERIFY_REQUIRED: { label: "待验证", tone: "warning" },
  LOGGED_OUT: { label: "已退出", tone: "muted" },
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const item = accountMap[status] ?? { label: status, tone: "muted" as const };
  return (
    <Badge tone={item.tone} dot>
      {item.label}
    </Badge>
  );
}

const groupMap: Record<GroupStatus, { label: string; tone: "success" | "warning" | "danger" | "muted" }> = {
  active: { label: "监听正常", tone: "success" },
  paused: { label: "已暂停", tone: "muted" },
  error: { label: "同步异常", tone: "danger" },
  verify_required: { label: "待验证", tone: "warning" },
};

export function GroupStatusBadge({ status }: { status: GroupStatus }) {
  const item = groupMap[status] ?? { label: status, tone: "muted" as const };
  return (
    <Badge tone={item.tone} dot>
      {item.label}
    </Badge>
  );
}

const jobMap: Record<JobStatus, { label: string; tone: "success" | "warning" | "danger" | "info" | "muted" | "brand" }> = {
  PENDING: { label: "等待中", tone: "muted" },
  RESOLVING: { label: "解析中", tone: "info" },
  DOWNLOADING: { label: "下载中", tone: "brand" },
  VERIFYING: { label: "校验中", tone: "info" },
  COMPLETED: { label: "已完成", tone: "success" },
  RETRY_WAIT: { label: "等待重试", tone: "warning" },
  FAILED: { label: "下载失败", tone: "danger" },
  PAUSED: { label: "已暂停", tone: "warning" },
  CANCELED: { label: "已取消", tone: "muted" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const item = jobMap[status] ?? { label: status, tone: "muted" as const };
  return (
    <Badge tone={item.tone} dot={status === "DOWNLOADING" || status === "RESOLVING"}>
      {item.label}
    </Badge>
  );
}

const videoMap: Record<VideoStatus, { label: string; tone: "success" | "warning" | "danger" | "muted" }> = {
  pending: { label: "缓存中", tone: "warning" },
  ready: { label: "已缓存", tone: "success" },
  failed: { label: "缓存失败", tone: "danger" },
  deleted: { label: "已删除", tone: "muted" },
  deleting: { label: "删除中", tone: "muted" },
};

export function VideoStatusBadge({ status }: { status: VideoStatus }) {
  const item = videoMap[status] ?? { label: status, tone: "muted" as const };
  return (
    <Badge tone={item.tone} dot>
      {item.label}
    </Badge>
  );
}
