import { createHash } from "node:crypto";
import {
  buildShareUrl,
  classifyMessage,
  type GroupInfo,
  type HistorySyncResult,
  type LoginChallenge,
  type MessageSource,
  type NormalizedMessage,
  type SourceStatus,
} from "@vault/core";
import { now, safeErrorMessage, truncate } from "@vault/shared";

type AnyRecord = Record<string, any>;

const SELECTORS = {
  loggedIn: '[data-e2e="chat-list"], [data-e2e="conversation-list"], [class*="conversation-list"]',
  groupItems:
    '[data-e2e="chat-list"] a[href*="conversation"], [data-e2e="conversation-list"] a[href], [class*="conversation-list"] a[href]',
  messageItems:
    '[data-e2e="chat-message-item"], [data-e2e="message-item"], [class*="message-item"]',
};

/**
 * Experimental Playwright fallback. It watches the web chat DOM rather than
 * speaking the IM protocol. Selectors and group-id extraction require live
 * validation; history backfill is not claimed. Only enable when the primary
 * `douyin-im` path cannot satisfy Phase 0.
 */
export class PlaywrightMessageSource implements MessageSource {
  readonly name = "playwright";
  private context: AnyRecord | null = null;
  private page: AnyRecord | null = null;
  private browserType: AnyRecord | null = null;
  private onMessage: ((message: NormalizedMessage) => Promise<void>) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private status: SourceStatus = {
    state: "LOGIN_REQUIRED",
    connected: false,
    lastConnectedAt: null,
    lastMessageAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    reconnectAttempts: 0,
  };
  private currentGroup: GroupInfo | null = null;

  constructor(
    private readonly options: {
      accountId: string;
      profileDir: string;
      headless: boolean;
      chatUrl?: string;
    },
  ) {}

  private async ensureBrowser(): Promise<void> {
    if (this.context) return;
    let playwright: AnyRecord;
    try {
      const specifier = "playwright";
      playwright = (await import(specifier)) as AnyRecord;
    } catch (error) {
      throw new Error(
        `Playwright 未安装。请执行 pnpm --filter @vault/im-adapters add playwright && pnpm exec playwright install chromium。原始错误：${safeErrorMessage(error)}`,
      );
    }
    this.browserType = playwright.chromium;
    this.context = await this.browserType!.launchPersistentContext(this.options.profileDir, {
      headless: this.options.headless,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this.page = this.context!.pages()[0] ?? (await this.context!.newPage());
    await this.page!.goto(this.options.chatUrl ?? "https://www.douyin.com/chat", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  }

  private async detectLogin(): Promise<boolean> {
    if (!this.page) return false;
    try {
      const count = await this.page.locator(SELECTORS.loggedIn).count();
      return count > 0;
    } catch {
      return false;
    }
  }

  async startLogin(): Promise<LoginChallenge> {
    try {
      await this.ensureBrowser();
      const loggedIn = await this.detectLogin();
      if (loggedIn) {
        this.status.state = "CONNECTED";
        this.status.connected = true;
        this.status.lastConnectedAt = now();
        return { kind: "none", hint: "浏览器会话已登录" };
      }
      this.status.state = "AUTHENTICATING";
      return {
        kind: "verification",
        hint: "已在运行服务的设备上打开抖音网页版。请在该浏览器窗口中扫码登录；登录完成后点击刷新状态。备用适配器为实验性方案。",
      };
    } catch (error) {
      this.status.state = "LOGIN_REQUIRED";
      this.status.lastError = safeErrorMessage(error);
      return { kind: "none", hint: this.status.lastError };
    }
  }

  async connect(): Promise<void> {
    try {
      await this.ensureBrowser();
      this.status.state = "AUTHENTICATING";
      if (await this.detectLogin()) {
        this.status.state = "CONNECTED";
        this.status.connected = true;
        this.status.lastConnectedAt = now();
        this.status.lastError = null;
        this.startPolling();
      } else {
        this.status.state = "LOGIN_REQUIRED";
        this.status.lastError = "浏览器尚未登录抖音网页版。";
      }
    } catch (error) {
      this.status.state = "LOGIN_REQUIRED";
      this.status.lastError = safeErrorMessage(error);
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    this.status.connected = false;
    this.status.state = "DISCONNECTED";
  }

  async logout(): Promise<void> {
    await this.disconnect();
    this.status.state = "LOGGED_OUT";
  }

  async listGroups(): Promise<GroupInfo[]> {
    await this.ensureBrowser();
    if (!(await this.detectLogin())) throw new Error("浏览器尚未登录抖音网页版");
    const items = await this.page!.$$eval(SELECTORS.groupItems, (nodes: Element[]) =>
      nodes
        .map((node) => {
          const anchor = node as HTMLAnchorElement;
          const name =
            node.getAttribute("aria-label") ??
            node.getAttribute("title") ??
            node.textContent?.trim().slice(0, 60) ??
            "";
          return { href: anchor.href ?? "", name };
        })
        .filter((item) => item.href && item.name),
    );
    const result: GroupInfo[] = [];
    const seen = new Set<string>();
    for (const item of items as { href: string; name: string }[]) {
      try {
        const url = new URL(item.href);
        const id =
          url.searchParams.get("conversation_id") ??
          url.searchParams.get("group_id") ??
          url.searchParams.get("thread_id");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push({ platformGroupId: id, name: item.name });
      } catch {
        // Ignore malformed links.
      }
    }
    this.status.connected = true;
    this.status.state = "CONNECTED";
    return result;
  }

  async subscribe(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollMessages();
    }, 2500);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollMessages(): Promise<void> {
    if (!this.page || !this.onMessage) return;
    try {
      if (!(await this.detectLogin())) {
        this.status.state = "VERIFY_REQUIRED";
        this.status.connected = false;
        this.status.lastError = "浏览器登录状态已失效，请在浏览器窗口中重新登录。";
        return;
      }
      this.status.state = "CONNECTED";
      this.status.connected = true;
      const current = await this.currentGroupInfo();
      if (!current) return;
      this.currentGroup = current;
      const items = await this.page.$$eval(SELECTORS.messageItems, (nodes: Element[]) =>
        nodes.slice(-80).map((node) => {
          const anchor = node.querySelector("a[href]") as HTMLAnchorElement | null;
          return {
            text: node.textContent?.trim().slice(0, 1000) ?? "",
            href: anchor?.href ?? "",
            id:
              node.getAttribute("data-id") ??
              node.getAttribute("data-message-id") ??
              node.getAttribute("data-e2e-id") ??
              "",
          };
        }),
      );
      for (const item of items as { text: string; href: string; id: string }[]) {
        const digest = createHash("sha1")
          .update(`${current.platformGroupId}|${item.id}|${item.text}|${item.href}`)
          .digest("hex");
        if (this.seen.has(digest)) continue;
        this.seen.add(digest);
        if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
        const classified = classifyMessage({ text: `${item.text} ${item.href}`.trim() });
        if (classified.type === "unknown") continue;
        if (item.id === "" && !classified.workId && !classified.shareUrl) continue;
        const message: NormalizedMessage = {
          accountId: this.options.accountId,
          groupId: current.platformGroupId,
          groupName: current.name,
          messageId: item.id || digest,
          sentAt: now(),
          receivedAt: now(),
          type: classified.type,
          workId: classified.workId,
          shareUrl: classified.shareUrl || item.href || undefined,
          title: item.text.slice(0, 120) || undefined,
          source: "realtime",
          diagnostic: classified.diagnostic,
        };
        this.status.lastMessageAt = message.receivedAt;
        await this.onMessage(message);
      }
    } catch (error) {
      this.status.lastError = truncate(safeErrorMessage(error), 240);
    }
  }

  private async currentGroupInfo(): Promise<GroupInfo | null> {
    if (!this.page) return null;
    try {
      const url = new URL(this.page.url());
      const id =
        url.searchParams.get("conversation_id") ??
        url.searchParams.get("group_id") ??
        url.searchParams.get("thread_id");
      if (!id) return this.currentGroup;
      const title = await this.page.title();
      return { platformGroupId: id, name: title.replace(/\s*-\s*抖音.*$/u, "") || "抖音群聊" };
    } catch {
      return this.currentGroup;
    }
  }

  async syncHistory(_groupId: string, cursor?: string): Promise<HistorySyncResult> {
    return {
      messages: [],
      nextCursor: cursor,
      hasMore: false,
      gap: true,
      gapReason: "Playwright 备用适配器未实现历史消息补拉，无法确认离线期间是否完整。",
    };
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }
}
