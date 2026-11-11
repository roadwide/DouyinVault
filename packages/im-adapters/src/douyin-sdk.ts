import {
  buildShareUrl,
  classifyMessage,
  isValidWorkId,
  type GroupInfo,
  type HistorySyncResult,
  type LoginChallenge,
  type MessageSource,
  type NormalizedMessage,
  type SourceStatus,
  type WorkAvailabilityResult,
  type WorkMediaLink,
} from "@vault/core";
import {
  asNumber,
  asString,
  isRecord,
  now,
  redactUrl,
  safeErrorMessage,
  truncate,
  withTimeout,
} from "@vault/shared";

type AnyRecord = Record<string, any>;

const LOGIN_WAIT_MS = 25_000;
const HISTORY_PAGE_SIZE = 50;
const HISTORY_MAX_PAGES = 6;

function normalizeTimestamp(value: unknown): number {
  const raw = asNumber(value);
  if (raw == null || raw <= 0) return now();
  return raw < 1_000_000_000_000 ? raw * 1000 : raw;
}

function coverFromCard(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["content_thumb", "cover_url", "cover"]) {
    const cover = value[key];
    if (isRecord(cover)) {
      const list = cover["url_list"];
      if (Array.isArray(list) && typeof list[0] === "string") return list[0];
    }
  }
  return undefined;
}

function authorFromCard(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return asString(value["content_name"]) ?? asString(value["author_name"]) ?? undefined;
}

function firstUrlFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const list = value["url_list"];
  if (!Array.isArray(list)) return null;
  const urls = list.filter(
    (item): item is string => typeof item === "string" && /^https?:\/\//i.test(item),
  );
  if (urls.length === 0) return null;
  // Prefer direct MP4 streams over HLS playlists: the Direct downloader does
  // not merge segments, and Douyin usually lists both for the same work.
  const score = (url: string) => {
    let value = 0;
    if (/\.mp4(\?|$)/i.test(url)) value += 4;
    if (/mime_type=video_mp4/i.test(url)) value += 4;
    if (/\/video\/tos\//i.test(url)) value += 1;
    if (/\.m3u8(\?|$)/i.test(url)) value -= 6;
    return value;
  };
  return [...urls].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * Extract the best authorized media address from a shared-work detail payload.
 * Prefer the official download address; when the author disabled the download
 * button, fall back to the same `play_addr` stream the desktop client uses to
 * play a work that was explicitly shared into the chat. Filtered works (no
 * access) never yield a URL.
 */
export function extractWorkMediaFromDetail(value: unknown): WorkMediaLink | null {
  if (!isRecord(value) || value["filtered"] === true) return null;
  const detail = isRecord(value["detail"]) ? value["detail"] : null;
  if (!detail) return null;
  const video = isRecord(detail["video"]) ? detail["video"] : null;
  const control = isRecord(detail["video_control"]) ? detail["video_control"] : null;
  const allowDownload = control?.["allow_download"] === true;
  // Respect the author's download switch; playback remains available in the
  // conversation, so use the same play stream the desktop client uses.
  const url = allowDownload
    ? firstUrlFrom(video?.["download_addr"]) ?? firstUrlFrom(video?.["play_addr"])
    : firstUrlFrom(video?.["play_addr"]) ?? firstUrlFrom(video?.["download_addr"]);
  if (!url) return null;
  const author = isRecord(detail["author"]) ? detail["author"] : null;
  const cover = firstUrlFrom(video?.["cover"]) ?? firstUrlFrom(detail["cover"]);
  return {
    url,
    title: asString(detail["desc"]) ?? asString(detail["title"]),
    coverUrl: cover,
    authorName: asString(author?.["nickname"]),
  };
}

/**
 * Turn a `getSharedWorkDetails` batch into per-work availability results.
 * A work missing from a non-empty response was not returned by the platform
 * and is treated as unavailable; an entirely empty response is handled by the
 * caller as an unknown state to avoid false positives on transient failures.
 */
export function summarizeWorkAvailability(
  details: readonly AnyRecord[],
  workIds: readonly string[],
): WorkAvailabilityResult[] {
  const byId = new Map<string, AnyRecord>();
  for (const item of details) {
    if (item && typeof item.workId === "string") byId.set(item.workId, item);
  }
  return workIds.map((workId) => {
    const item = byId.get(workId);
    if (!item) return { workId, state: "unavailable", reason: "missing" };
    if (item.filtered === true) return { workId, state: "unavailable", reason: "filtered" };
    return { workId, state: "available" };
  });
}

/**
 * Primary IM path, backed by the optional `douyin-im` package.
 *
 * The package is intentionally loaded dynamically: the service must boot and
 * offer mock/demo mode even when the SDK is not installed. Treat this adapter
 * as unverified until the Phase 0 live checklist passes (see docs/acceptance.md).
 */
export class DouyinImSource implements MessageSource {
  readonly name = "douyin-im";
  private client: AnyRecord | null = null;
  private account: AnyRecord | null = null;
  private parser: ((content: string, messageType?: number) => AnyRecord) | null = null;
  private onMessage: ((message: NormalizedMessage) => Promise<void>) | null = null;
  private groups = new Map<string, AnyRecord>();

  private state: SourceStatus = {
    state: "LOGIN_REQUIRED",
    connected: false,
    lastConnectedAt: null,
    lastMessageAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    reconnectAttempts: 0,
  };
  private challenge: LoginChallenge | null = null;
  private challengeResolver: ((challenge: LoginChallenge) => void) | null = null;
  private loginStarted = false;
  private displayName: string | null = null;
  private avatarUrl: string | null = null;

  constructor(
    private readonly options: {
      dataDir: string;
      accountId: string;
      localState?: boolean;
    },
  ) {}

  get profile(): { platformUid: string | null; displayName: string | null; avatarUrl: string | null } {
    return {
      platformUid: this.account?.uid ? String(this.account.uid) : null,
      displayName: this.displayName,
      avatarUrl: this.avatarUrl,
    };
  }

  get currentChallenge(): LoginChallenge | null {
    return this.challenge;
  }

  private async ensureClient(): Promise<AnyRecord> {
    if (this.client) return this.client;
    let mod: AnyRecord;
    try {
      const specifier = "douyin-im";
      mod = (await import(specifier)) as AnyRecord;
    } catch (error) {
      throw new Error(
        `douyin-im 未安装。请在仓库根目录执行 pnpm --filter @vault/im-adapters add douyin-im@1.1.0。原始错误：${safeErrorMessage(error)}`,
      );
    }
    const protocolSpecifier = "douyin-im/protocol";
    const protocol = (await import(protocolSpecifier)) as AnyRecord;
    this.parser = protocol.parseMessageContent as typeof this.parser;
    const client = mod.createClient({
      dataDir: this.options.dataDir,
      autoLoad: true,
      ...(this.options.localState === false ? { localState: false } : {}),
    }) as AnyRecord;
    this.client = client;
    this.bindEvents(client);
    return client;
  }

  private bindEvents(client: AnyRecord): void {
    client.on("system.login.qrcode", async ({ account, qrcodeBase64 }: AnyRecord) => {
      this.account = account;
      this.state.state = "AUTHENTICATING";
      this.state.lastError = null;
      const challenge: LoginChallenge = {
        kind: "qr",
        qrDataUrl: `data:image/png;base64,${String(qrcodeBase64)}`,
        expiresAt: now() + 5 * 60_000,
        hint: "请使用抖音 App 扫码，并在手机上确认登录。二维码仅本次有效。",
      };
      this.challenge = challenge;
      this.challengeResolver?.(challenge);
      this.challengeResolver = null;
      try {
        await account.continueLogin();
      } catch (error) {
        this.state.lastError = safeErrorMessage(error);
      }
    });

    client.on("system.login.verification", async ({ account, verification }: AnyRecord) => {
      this.account = account ?? this.account;
      this.state.state = "VERIFY_REQUIRED";
      this.state.lastError = "抖音要求登录二次验证，请在受信任的设备上完成官方验证。";
      try {
        if (typeof verification?.openUrl === "function") {
          const url = await verification.openUrl({ openBrowser: false });
          this.challenge = {
            kind: "verification",
            verificationUrl: String(url),
            expiresAt: now() + 10 * 60_000,
            hint: "验证链接只绑定本机回环地址，请在运行服务的设备上打开。",
          };
        } else {
          this.challenge = {
            kind: "verification",
            hint: "请在运行服务的设备上完成抖音官方验证。",
          };
        }
      } catch (error) {
        this.state.lastError = safeErrorMessage(error);
      }
      this.challengeResolver?.(this.challenge ?? { kind: "none" });
      this.challengeResolver = null;
    });

    client.on("system.login.error", (payload: AnyRecord) => {
      const error = payload?.error ?? payload;
      this.state.state = "LOGIN_REQUIRED";
      this.state.lastError = safeErrorMessage(error);
      this.state.connected = false;
      this.challenge = null;
      this.challengeResolver?.({ kind: "none", hint: this.state.lastError });
      this.challengeResolver = null;
    });

    client.on("system.online", ({ account }: AnyRecord) => {
      this.account = account;
      this.state = {
        ...this.state,
        state: "CONNECTED",
        connected: true,
        lastConnectedAt: now(),
        lastError: null,
        reconnectAttempts: 0,
      };
      this.challenge = null;
      this.displayName = account?.nickname ? String(account.nickname) : this.displayName;
      this.avatarUrl = account?.avatar ? String(account.avatar) : this.avatarUrl;
      this.challengeResolver?.({ kind: "none", hint: "已连接" });
      this.challengeResolver = null;
    });

    client.on("system.reconnecting", (payload: AnyRecord) => {
      this.state.state = "RECONNECTING";
      this.state.connected = false;
      this.state.reconnectAttempts += 1;
      this.state.lastError = payload?.reason ? truncate(String(payload.reason), 200) : null;
    });

    client.on("system.offline", () => {
      this.state.state = "DISCONNECTED";
      this.state.connected = false;
    });

    client.on("message", async (event: AnyRecord) => {
      try {
        if (!this.onMessage) return;
        if (event?.type !== "message.group" && event?.conversationType !== 2) return;
        const message = await this.normalizeRealtime(event);
        if (!message) return;
        this.state.lastMessageAt = message.receivedAt;
        await this.onMessage(message);
      } catch (error) {
        this.state.lastError = safeErrorMessage(error);
      }
    });
  }

  private async normalizeRealtime(event: AnyRecord): Promise<NormalizedMessage | null> {
    const groupId = String(event.threadId ?? event.group?.groupId ?? "");
    if (!groupId) return null;
    const sentAt = normalizeTimestamp(event.createTime);
    const work = event.work as AnyRecord | undefined;
    let workId: string | undefined = work?.id ? String(work.id) : undefined;
    let title = work?.title ? String(work.title) : undefined;
    let coverUrl: string | undefined;
    let authorName: string | undefined;
    let shareUrl = buildShareUrl(workId) ?? undefined;
    let mediaUrl: string | undefined;

    if (work) {
      try {
        const access = await Promise.race([
          work.getAccess?.(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("获取作品权限超时")), 10_000)),
        ]) as AnyRecord | undefined;
        const media = Array.isArray(access?.media) ? access.media : [];
        const video = media.find((item: AnyRecord) => item?.kind === "video" && typeof item.url === "string");
        if (video?.url) mediaUrl = String(video.url);
        const detail = await Promise.race([
          work.getDetail?.(),
          new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
        ]) as AnyRecord | undefined;
        if (detail?.detail) {
          authorName = asString(detail.detail?.author?.nickname) ?? authorName;
          coverUrl = coverFromCard(detail.detail) ?? coverUrl;
          if (!title) title = asString(detail.detail?.desc) ?? undefined;
        }
      } catch {
        // Permission/access lookup is best effort. The download queue will use
        // the API/yt-dlp fallback while preserving this message.
      }
    }

    const content = event.content as AnyRecord | undefined;
    let text = event.text ? String(event.text) : "";
    if (!work && content?.kind === "link") {
      shareUrl = asString(content.link?.url) ?? shareUrl;
      title ??= asString(content.link?.title) ?? undefined;
    }
    if (!work && content?.kind === "share") {
      workId = asString(content.share?.itemId) ?? workId;
      title ??= asString(content.share?.title) ?? undefined;
      shareUrl = buildShareUrl(workId) ?? shareUrl;
    }
    if (content?.kind === "text") text = String(content.text ?? text);
    if (content?.kind === "video") {
      return {
        accountId: this.options.accountId,
        groupId,
        groupName: event.group?.name ? String(event.group.name) : undefined,
        messageId: String(event.serverMessageId ?? event.clientMessageId ?? `${groupId}-${sentAt}`),
        senderId: event.senderUid ? String(event.senderUid) : undefined,
        senderName: event.member?.nickname ? String(event.member.nickname) : undefined,
        sentAt,
        receivedAt: now(),
        type: "chat_video",
        title: "聊天内视频（适配器预留）",
        source: "realtime",
        diagnostic: "群内直接发送的视频文件首版不自动下载，已保存消息元数据。",
      };
    }

    const classified = classifyMessage({ workId, mediaUrl, text });
    if (classified.type === "unknown" && content?.kind === "image") {
      return {
        accountId: this.options.accountId,
        groupId,
        groupName: event.group?.name ? String(event.group.name) : undefined,
        messageId: String(event.serverMessageId ?? event.clientMessageId ?? `${groupId}-${sentAt}`),
        senderId: event.senderUid ? String(event.senderUid) : undefined,
        senderName: event.member?.nickname ? String(event.member.nickname) : undefined,
        sentAt,
        receivedAt: now(),
        type: "image",
        source: "realtime",
      };
    }
    return {
      accountId: this.options.accountId,
      groupId,
      groupName: event.group?.name ? String(event.group.name) : undefined,
      messageId: String(event.serverMessageId ?? event.clientMessageId ?? `${groupId}-${sentAt}`),
      senderId: event.senderUid ? String(event.senderUid) : undefined,
      senderName: event.member?.nickname ? String(event.member.nickname) : undefined,
      sentAt,
      receivedAt: now(),
      type: classified.type,
      workId: classified.workId ?? workId,
      shareUrl: classified.shareUrl ?? shareUrl,
      mediaUrl,
      title: title ?? classified.title,
      coverUrl,
      authorName,
      source: "realtime",
      diagnostic: classified.diagnostic,
    };
  }

  async disconnect(): Promise<void> {
    this.state.state = "DISCONNECTED";
    this.state.connected = false;
    this.onMessage = null;
  }

  async connect(): Promise<void> {
    try {
      await this.ensureClient();
      if (this.state.connected) return;
      this.beginLogin();
      await this.waitForChallengeOrOnline();
    } catch (error) {
      this.state.state = "LOGIN_REQUIRED";
      this.state.lastError = safeErrorMessage(error);
    }
  }

  async startLogin(): Promise<LoginChallenge> {
    try {
      await this.ensureClient();
      if (this.state.connected) return { kind: "none", hint: "账号已连接" };
      this.beginLogin();
      return await this.waitForChallengeOrOnline();
    } catch (error) {
      this.state.state = "LOGIN_REQUIRED";
      this.state.lastError = safeErrorMessage(error);
      return { kind: "none", hint: this.state.lastError };
    }
  }

  private beginLogin(): void {
    if (this.loginStarted) return;
    this.loginStarted = true;
    this.state.state = "AUTHENTICATING";
    const client = this.client;
    if (!client) return;
    void Promise.resolve(client.login())
      .catch((error: unknown) => {
        this.state.state = "LOGIN_REQUIRED";
        this.state.connected = false;
        this.state.lastError = safeErrorMessage(error);
        this.challengeResolver?.({ kind: "none", hint: this.state.lastError });
        this.challengeResolver = null;
      })
      .finally(() => {
        this.loginStarted = false;
      });
  }

  private waitForChallengeOrOnline(timeoutMs = LOGIN_WAIT_MS): Promise<LoginChallenge> {
    if (this.state.connected) return Promise.resolve({ kind: "none", hint: "账号已连接" });
    if (this.challenge) return Promise.resolve(this.challenge);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (challenge: LoginChallenge) => {
        if (settled) return;
        settled = true;
        this.challengeResolver = null;
        resolve(challenge);
      };
      this.challengeResolver = finish;
      setTimeout(() => {
        finish({
          kind: "none",
          hint:
            this.state.lastError ??
            "等待抖音登录二维码超时。请检查网络后重试；详细状态见服务日志。",
        });
      }, timeoutMs).unref?.();
    });
  }

  async cancelLogin(): Promise<void> {
    this.challenge = null;
  }

  async logout(): Promise<void> {
    try {
      await this.client?.logout?.();
    } finally {
      this.state.state = "LOGGED_OUT";
      this.state.connected = false;
      this.challenge = null;
      this.loginStarted = false;
    }
  }

  async listGroups(): Promise<GroupInfo[]> {
    await this.ensureClient();
    const account = this.requireAccount();
    const groups = (await account.getGroupList(true)) as AnyRecord[];
    this.groups = new Map(groups.map((group) => [String(group.groupId), group]));
    return groups.map((group) => ({
      platformGroupId: String(group.groupId),
      name: String(group.name ?? "未命名群聊"),
      avatarUrl: group.avatar ? String(group.avatar) : undefined,
      memberCount: typeof group.memberCount === "number" ? group.memberCount : undefined,
    }));
  }

  async subscribe(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
  }

  private async findGroup(platformGroupId: string | null): Promise<AnyRecord | null> {
    if (!platformGroupId) return null;
    const cached = this.groups.get(platformGroupId);
    if (cached) return cached;
    const account = this.requireAccount();
    const groups = (await withTimeout(
      Promise.resolve(account.getGroupList(true)),
      10_000,
      "获取群列表超时",
    )) as AnyRecord[];
    this.groups = new Map(groups.map((group) => [String(group.groupId), group]));
    return this.groups.get(platformGroupId) ?? null;
  }

  private async fetchWorkDetails(
    workIds: readonly string[],
    platformGroupId: string,
  ): Promise<AnyRecord[]> {
    await this.ensureClient();
    const group = await this.findGroup(platformGroupId);
    if (!group) throw new Error("来源群不在当前 IM 会话中");
    if (typeof group.getSharedWorkDetails !== "function") {
      throw new Error("当前 IM 群对象不支持作品详情接口");
    }
    const details = (await withTimeout(
      Promise.resolve(group.getSharedWorkDetails(workIds)),
      10_000,
      "获取作品详情超时",
    )) as AnyRecord[];
    if (!Array.isArray(details) || details.length === 0) {
      throw new Error("IM 未返回作品详情");
    }
    return details;
  }

  /**
   * Ask the signed-in desktop IM session for a fresh download address. History
   * messages only carry a work id, so the worker uses this instead of falling
   * straight to yt-dlp (which needs separate browser cookies).
   */
  async resolveWorkMedia(
    workId: string,
    platformGroupId: string | null,
  ): Promise<WorkMediaLink | null> {
    if (!isValidWorkId(workId)) return null;
    if (!platformGroupId) throw new Error("缺少来源群 ID，无法向 IM 请求作品详情");
    const details = await this.fetchWorkDetails([workId], platformGroupId);
    const detail = details.find((item) => String(item?.workId ?? "") === workId);
    if (!detail) throw new Error("IM 作品详情中没有该作品");
    if (detail.filtered === true) throw new Error("平台过滤了该作品的详情");
    const media = extractWorkMediaFromDetail(detail);
    if (media) return media;
    const payload = isRecord(detail.detail) ? detail.detail : null;
    const video = payload && isRecord(payload["video"]) ? payload["video"] : null;
    throw new Error(
      `作品详情没有可用的媒体地址（play_addr=${video?.["play_addr"] ? "有" : "无"}）`,
    );
  }

  async checkWorkAvailability(
    workIds: readonly string[],
    platformGroupId: string | null,
  ): Promise<readonly WorkAvailabilityResult[]> {
    const ids = [...new Set(workIds.filter((workId) => isValidWorkId(workId)))];
    if (ids.length === 0) return [];
    if (!platformGroupId) throw new Error("缺少来源群 ID，无法检查作品可访问性");
    const details = await this.fetchWorkDetails(ids, platformGroupId);
    return summarizeWorkAvailability(details, ids);
  }

  async syncHistory(groupId: string, cursor?: string): Promise<HistorySyncResult> {
    await this.ensureClient();
    const account = this.requireAccount();
    let group = this.groups.get(groupId) as AnyRecord | undefined;
    if (!group) {
      const groups = (await account.getGroupList(true)) as AnyRecord[];
      this.groups = new Map(groups.map((item) => [String(item.groupId), item]));
      group = this.groups.get(groupId);
    }
    if (!group) throw new Error("群聊不存在或已退出");
    // A two-minute overlap protects against clock skew and equal timestamps;
    // the message unique constraint removes duplicates.
    const since = cursor ? Number(cursor) - 120_000 : null;
    const collected: { sentAt: number; message: NormalizedMessage }[] = [];
    let pageCursor: string | number | undefined;
    let hasMore = false;
    let pages = 0;
    let reachedBoundary = since === null;
    let oldestSeen: number | null = null;

    while (pages < HISTORY_MAX_PAGES) {
      const page = await group.getHistory({
        count: HISTORY_PAGE_SIZE,
        direction: "older",
        includeCurrent: true,
        ...(pageCursor != null ? { cursor: pageCursor } : {}),
      });
      pages += 1;
      const rawMessages = Array.isArray(page.messages) ? page.messages : [];
      for (const raw of rawMessages) {
        const sentAt = normalizeTimestamp(raw.createTime);
        oldestSeen = oldestSeen === null ? sentAt : Math.min(oldestSeen, sentAt);
        if (since !== null && sentAt <= since) {
          reachedBoundary = true;
          continue;
        }
        const normalized = this.normalizeHistoryMessage(groupId, group, raw, sentAt);
        if (normalized) collected.push({ sentAt, message: normalized });
      }
      hasMore = Boolean(page.hasMore);
      pageCursor = page.cursor;
      if (!hasMore) break;
      // First sync is intentionally shallow: cache the latest page only, then
      // use its newest timestamp as the cursor. This avoids silently
      // downloading a large historical backlog when a user first enables a group.
      if (since === null) break;
      if (since !== null && oldestSeen !== null && oldestSeen <= since) break;
    }

    collected.sort((a, b) => a.sentAt - b.sentAt);
    const maxSentAt = collected.reduce((max, item) => Math.max(max, item.sentAt), since ?? 0);
    const truncated = hasMore && !reachedBoundary;
    const retentionGap =
      since !== null && !hasMore && !reachedBoundary && oldestSeen !== null && pages > 0;
    const gap = truncated || retentionGap;
    const nextCursor = maxSentAt > 0 ? String(maxSentAt) : cursor;
    this.state.lastSuccessfulSyncAt = now();
    return {
      messages: collected.map((item) => item.message),
      nextCursor,
      hasMore,
      gap,
      gapReason: truncated
        ? `历史补拉达到 ${HISTORY_MAX_PAGES} 页上限，仍有更早消息未覆盖。`
        : retentionGap
          ? "上次同步位置早于平台保留的历史窗口，无法确认中间没有遗漏。"
          : undefined,
    };
  }

  private normalizeHistoryMessage(
    groupId: string,
    group: AnyRecord,
    raw: AnyRecord,
    sentAt: number,
  ): NormalizedMessage | null {
    const content = this.parser
      ? (this.parser(String(raw.content ?? ""), Number(raw.msgType ?? 0)) as AnyRecord)
      : { kind: "unknown" };
    const messageId = String(raw.msgId ?? raw.clientMessageId ?? `${groupId}-${sentAt}-${raw.indexInConversation ?? ""}`);
    const base = {
      accountId: this.options.accountId,
      groupId,
      groupName: group.name ? String(group.name) : undefined,
      messageId,
      senderId: raw.senderUid ? String(raw.senderUid) : undefined,
      senderName: group.pickMember?.(raw.senderUid)?.nickname
        ? String(group.pickMember(raw.senderUid).nickname)
        : undefined,
      sentAt,
      receivedAt: now(),
      source: "history" as const,
    };
    if (content.kind === "share") {
      return {
        ...base,
        type: "shared_work",
        workId: String(content.share?.itemId ?? ""),
        shareUrl: buildShareUrl(String(content.share?.itemId ?? "")) ?? undefined,
        title: String(content.share?.title ?? "") || undefined,
        coverUrl: coverFromCard(content.value),
        authorName: authorFromCard(content.value),
      };
    }
    if (content.kind === "image") {
      return { ...base, type: "image" };
    }
    if (content.kind === "video") {
      return {
        ...base,
        type: "chat_video",
        title: "聊天内视频（适配器预留）",
        diagnostic: "历史聊天视频暂不支持直接下载。",
      };
    }
    if (content.kind === "link") {
      const url = asString(content.link?.url) ?? "";
      const classified = classifyMessage({ text: url });
      return {
        ...base,
        type: classified.type,
        workId: classified.workId,
        shareUrl: classified.shareUrl ?? url,
        title: asString(content.link?.title) ?? classified.title,
        coverUrl: asString(content.link?.coverUrl) ?? undefined,
        diagnostic: classified.diagnostic,
      };
    }
    const text = String(content.text ?? "");
    const classified = classifyMessage({ text });
    return {
      ...base,
      type: classified.type,
      workId: classified.workId,
      shareUrl: classified.shareUrl,
      title: classified.title,
      diagnostic: classified.diagnostic ?? (classified.type === "unknown" ? truncate(`未识别消息：${redactUrl(text) ?? ""}`, 240) : undefined),
    };
  }

  private requireAccount(): AnyRecord {
    if (!this.account) {
      const accounts = (this.client?.accounts ?? []) as AnyRecord[];
      this.account = accounts[0] ?? null;
    }
    if (!this.account) throw new Error("抖音账号尚未登录");
    return this.account;
  }

  getStatus(): SourceStatus {
    return { ...this.state };
  }
}
