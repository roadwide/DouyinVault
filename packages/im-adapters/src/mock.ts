import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  classifyMessage,
  type GroupInfo,
  type HistorySyncResult,
  type LoginChallenge,
  type MessageSource,
  type NormalizedMessage,
  type SourceStatus,
  type WorkAvailabilityResult,
} from "@vault/core";
import { now } from "@vault/shared";

interface MockSession {
  displayName: string;
  uid: string;
  connectedAt: number;
}

const GROUPS: GroupInfo[] = [
  { platformGroupId: "7000000000000000001", name: "周一摸鱼研究所", memberCount: 42 },
  { platformGroupId: "7000000000000000002", name: "视频收藏夹（私密）", memberCount: 3 },
  { platformGroupId: "7000000000000000003", name: "家人群", memberCount: 9 },
];

const SAMPLE_WORKS = [
  "7412345678901234567",
  "7412345678901234568",
  "7412345678901234569",
  "7412345678901234570",
];

function qrSvg(): string {
  const cells = 25;
  const size = 8;
  let rects = "";
  const seed = createHash("sha256").update("douyin-vault-demo-qr").digest();
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const corner =
        (x < 7 && y < 7) || (x >= cells - 7 && y < 7) || (x < 7 && y >= cells - 7);
      const on = corner
        ? x % 6 === 0 || y % 6 === 0 || (x > 1 && x < 5 && y > 1 && y < 5)
        : ((seed[(x + y * cells) % seed.length] as number) >> (x % 8)) & 1;
      if (on) rects += `<rect x="${x * size}" y="${y * size}" width="${size}" height="${size}" fill="#0b0b0d"/>`;
    }
  }
  const total = cells * size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}"><rect width="100%" height="100%" fill="#fff"/>${rects}<rect x="${total * 0.3}" y="${total * 0.43}" width="${total * 0.4}" height="${total * 0.14}" rx="8" fill="#fe2c55"/><text x="50%" y="${total * 0.53}" font-family="system-ui,sans-serif" font-size="${total * 0.07}" font-weight="700" fill="#fff" text-anchor="middle">DEMO</text></svg>`;
}

function qrDataUrl(): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg()).toString("base64")}`;
}

export interface MockMessageInput {
  groupId?: string;
  senderName?: string;
  workId?: string;
  title?: string;
  shareUrl?: string;
  mediaUrl?: string;
  source?: "realtime" | "history";
  messageId?: string;
}

/**
 * Offline adapter used by tests, the demo seed and UI development.
 * It never talks to Douyin and must not be used as evidence of live support.
 */
export class MockMessageSource implements MessageSource {
  readonly name = "mock";
  private onMessage: ((message: NormalizedMessage) => Promise<void>) | null = null;
  private session: MockSession | null = null;
  private challenge: LoginChallenge | null = null;
  private lastError: string | null = null;
  private historyCursor: string | null = null;
  private readonly unavailableWorks = new Set<string>();

  constructor(
    private readonly options: {
      sessionPath: string;
      accountId: string;
      groups?: GroupInfo[];
    },
  ) {
    if (existsSync(options.sessionPath)) {
      try {
        this.session = JSON.parse(readFileSync(options.sessionPath, "utf8")) as MockSession;
      } catch {
        this.session = null;
      }
    }
    // Demo/e2e fixtures can persist unavailable work ids across processes.
    const unavailablePath = resolve(dirname(options.sessionPath), "mock-unavailable.json");
    if (existsSync(unavailablePath)) {
      try {
        const parsed = JSON.parse(readFileSync(unavailablePath, "utf8")) as unknown;
        if (Array.isArray(parsed)) {
          for (const workId of parsed) {
            if (typeof workId === "string") this.unavailableWorks.add(workId);
          }
        }
      } catch {
        // Ignore a malformed demo fixture.
      }
    }
  }

  get demoConnected(): boolean {
    return this.session !== null;
  }

  get profile(): { platformUid: string | null; displayName: string | null; avatarUrl: string | null } {
    return {
      platformUid: this.session?.uid ?? null,
      displayName: this.session?.displayName ?? null,
      avatarUrl: null,
    };
  }

  async connect(): Promise<void> {
    if (this.session) {
      this.lastError = null;
      return;
    }
    this.lastError = "演示模式：请先连接一个模拟账号。";
  }

  async disconnect(): Promise<void> {
    this.session = null;
    this.onMessage = null;
  }

  async startLogin(): Promise<LoginChallenge> {
    this.challenge = {
      kind: "qr",
      qrDataUrl: qrDataUrl(),
      expiresAt: now() + 5 * 60_000,
      hint: "演示适配器：点击“模拟扫码成功”继续。真实账号请切换 IM_ADAPTER=douyin-im。",
    };
    return this.challenge;
  }

  /** Demo-only equivalent of a successful mobile scan. */
  async completeDemoLogin(displayName = "演示账号"): Promise<void> {
    const session: MockSession = {
      displayName,
      uid: "8000000000000000001",
      connectedAt: now(),
    };
    mkdirSync(dirname(this.options.sessionPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.sessionPath, JSON.stringify(session, null, 2), {
      mode: 0o600,
    });
    this.session = session;
    this.challenge = null;
    this.lastError = null;
  }

  async cancelLogin(): Promise<void> {
    this.challenge = null;
  }

  async logout(): Promise<void> {
    this.session = null;
    this.challenge = null;
    if (existsSync(this.options.sessionPath)) rmSync(this.options.sessionPath, { force: true });
  }

  async listGroups(): Promise<GroupInfo[]> {
    if (!this.session) throw new Error("演示账号尚未登录");
    return this.options.groups ?? GROUPS;
  }

  async subscribe(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
  }

  /** Used by tests and the demo to exercise the unavailable tag. */
  setWorkUnavailable(workId: string, unavailable = true): void {
    if (unavailable) this.unavailableWorks.add(workId);
    else this.unavailableWorks.delete(workId);
  }

  async checkWorkAvailability(
    workIds: readonly string[],
  ): Promise<readonly WorkAvailabilityResult[]> {
    return workIds.map((workId) =>
      this.unavailableWorks.has(workId)
        ? { workId, state: "unavailable" as const, reason: "filtered" }
        : { workId, state: "available" as const },
    );
  }

  async syncHistory(groupId: string, cursor?: string): Promise<HistorySyncResult> {
    if (!this.session) throw new Error("演示账号尚未登录");
    const group = (this.options.groups ?? GROUPS).find((item) => item.platformGroupId === groupId);
    if (!group) throw new Error("群聊不存在");
    const since = cursor ? Number(cursor) : 0;
    const base = now();
    const fixtures: NormalizedMessage[] = [
      {
        accountId: this.options.accountId,
        groupId,
        groupName: group.name,
        messageId: `mock-history-${groupId}-1`,
        senderId: "8000000000000000101",
        senderName: "林小满",
        sentAt: base - 3 * 3_600_000,
        receivedAt: base - 3 * 3_600_000,
        type: "shared_work",
        workId: SAMPLE_WORKS[1],
        title: "海边日落的 30 秒",
        source: "history",
      },
      {
        accountId: this.options.accountId,
        groupId,
        groupName: group.name,
        messageId: `mock-history-${groupId}-2`,
        senderId: "8000000000000000102",
        senderName: "周野",
        sentAt: base - 2 * 3_600_000,
        receivedAt: base - 2 * 3_600_000,
        type: "shared_work",
        workId: SAMPLE_WORKS[2],
        title: "凌晨四点的城市",
        source: "history",
      },
    ];
    const messages = fixtures.filter((item) => item.sentAt > since);
    const nextCursor = String(Math.max(since, ...fixtures.map((item) => item.sentAt)));
    this.historyCursor = nextCursor;
    return { messages, nextCursor, hasMore: false, gap: false };
  }

  /** Used by the demo UI + tests to simulate a realtime share. */
  async publish(input: MockMessageInput = {}): Promise<NormalizedMessage> {
    if (!this.session) throw new Error("演示账号尚未登录");
    if (!this.onMessage) throw new Error("消息订阅尚未建立");
    const groupId = input.groupId ?? (this.options.groups ?? GROUPS)[0]!.platformGroupId;
    const group = (this.options.groups ?? GROUPS).find((item) => item.platformGroupId === groupId);
    const workId = input.workId ?? SAMPLE_WORKS[Math.floor(Math.random() * SAMPLE_WORKS.length)]!;
    const classified = classifyMessage({ workId, mediaUrl: input.mediaUrl });
    const message: NormalizedMessage = {
      accountId: this.options.accountId,
      groupId,
      groupName: group?.name,
      messageId: input.messageId ?? `mock-${randomUUID()}`,
      senderId: "8000000000000000103",
      senderName: input.senderName ?? "阿哲",
      sentAt: now(),
      receivedAt: now(),
      type: input.mediaUrl ? "chat_video" : classified.type,
      workId: input.mediaUrl ? undefined : workId,
      shareUrl: input.shareUrl ?? `https://www.douyin.com/video/${workId}`,
      mediaUrl: input.mediaUrl,
      title: input.title ?? "群友刚刚分享的视频",
      coverUrl: undefined,
      source: input.source ?? "realtime",
      diagnostic: undefined,
    };
    await this.onMessage(message);
    return message;
  }

  get demoHistoryCursor(): string | null {
    return this.historyCursor;
  }

  getStatus(): SourceStatus {
    return {
      state: this.session ? "CONNECTED" : this.challenge ? "AUTHENTICATING" : "LOGIN_REQUIRED",
      connected: Boolean(this.session),
      lastConnectedAt: this.session?.connectedAt ?? null,
      lastMessageAt: null,
      lastSuccessfulSyncAt: null,
      lastError: this.lastError,
      reconnectAttempts: 0,
    };
  }

  static qrDataUrl = qrDataUrl;
}

export function resolveMockSessionPath(dataDir: string): string {
  return resolve(dataDir, "sessions", "mock-session.json");
}
