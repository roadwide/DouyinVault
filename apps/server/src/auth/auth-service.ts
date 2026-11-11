import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import type {
  AccountStatus,
  LoginChallenge,
  MessageSource,
  NormalizedMessage,
  SourceStatus,
} from "@vault/core";
import { accounts, groups, type schema } from "@vault/db";
import { now, safeErrorMessage } from "@vault/shared";
import {
  DouyinImSource,
  MockMessageSource,
  PlaywrightMessageSource,
  resolveMockSessionPath,
} from "@vault/im-adapters";
import type { AppConfig, Paths } from "../config.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";

interface AuthHooks {
  onMessage?: (message: NormalizedMessage) => Promise<void>;
  onConnected?: () => Promise<void>;
}

export interface AuthStatusPayload {
  accountId: string;
  adapter: string;
  status: AccountStatus;
  platformUid: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastError: string | null;
  challenge: LoginChallenge | null;
  setupRequired: boolean;
}

export class AuthService {
  private source: MessageSource | null = null;
  private hooks: AuthHooks = {};
  private challenge: LoginChallenge | null = null;
  private connectedHandled = false;
  private lastPersisted: AccountStatus | null = null;
  accountId = "";

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly config: AppConfig,
    private readonly paths: Paths,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {
  }

  private createSource(): MessageSource {
    const accountId = this.accountId || "pending";
    switch (this.config.imAdapter) {
      case "mock":
        return new MockMessageSource({
          sessionPath: resolveMockSessionPath(this.paths.dataDir),
          accountId,
        });
      case "douyin-im":
        return new DouyinImSource({
          dataDir: `${this.paths.sessionsDir}/douyin-im`,
          accountId,
        });
      case "playwright":
        return new PlaywrightMessageSource({
          accountId,
          profileDir: this.config.playwrightProfileDir,
          headless: this.config.playwrightHeadless,
        });
    }
  }

  get adapterName(): string {
    return this.config.imAdapter;
  }

  get sourceRef(): MessageSource {
    return this.requireSource();
  }

  private requireSource(): MessageSource {
    if (!this.source) throw new Error("IM source is not initialized");
    return this.source;
  }

  setHooks(hooks: AuthHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  private ensureAccount(): void {
    let row = this.db.select().from(accounts).limit(1).get();
    if (!row) {
      const id = ulid();
      this.db
        .insert(accounts)
        .values({
          id,
          platform: "douyin",
          status: "LOGIN_REQUIRED",
          adapter: this.config.imAdapter,
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
      row = this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    }
    if (!row) throw new Error("无法创建账号记录");
    this.accountId = row.id;
    if (row.adapter !== this.config.imAdapter) {
      this.db
        .update(accounts)
        .set({
          adapter: this.config.imAdapter,
          status: "LOGIN_REQUIRED",
          lastError: null,
          updatedAt: now(),
        })
        .where(eq(accounts.id, row.id))
        .run();
    }
  }

  async initialize(): Promise<void> {
    this.ensureAccount();
    this.source = this.createSource();
    await this.source.subscribe(async (message) => {
      if (this.hooks.onMessage) await this.hooks.onMessage(message);
    });
    this.lastPersisted = this.accountRow()?.status as AccountStatus;
    const savedStatus = this.lastPersisted;
    const canAutoConnect =
      savedStatus === "CONNECTED" ||
      savedStatus === "DISCONNECTED" ||
      savedStatus === "RECONNECTING" ||
      (this.config.imAdapter === "mock" && (this.requireSource() as MockMessageSource).demoConnected);
    if (canAutoConnect) {
      void this.connectInBackground();
    } else {
      this.pauseEnabledGroups();
      this.refresh();
    }
  }

  private pauseEnabledGroups(): void {
    if (!this.accountId) return;
    this.db
      .update(groups)
      .set({ status: "paused", lastError: "等待抖音账号连接", updatedAt: now() })
      .where(and(eq(groups.accountId, this.accountId), eq(groups.enabled, true)))
      .run();
  }

  private async connectInBackground(): Promise<void> {
    try {
      this.updateStatus("RECONNECTING", null);
      await this.requireSource().connect();
      await this.refresh(true);
    } catch (error) {
      this.updateStatus("LOGIN_REQUIRED", safeErrorMessage(error));
    }
  }

  private accountRow() {
    if (!this.accountId) return null;
    return this.db.select().from(accounts).where(eq(accounts.id, this.accountId)).get() ?? null;
  }

  private updateStatus(status: AccountStatus, error: string | null): void {
    if (!this.accountId) return;
    const timestamp = now();
    const row = this.accountRow();
    const updates: Record<string, unknown> = {
      status,
      lastError: error,
      updatedAt: timestamp,
    };
    if (status === "CONNECTED") {
      updates.lastConnectedAt = row?.lastConnectedAt ?? timestamp;
      const profile = (this.requireSource() as { profile?: { platformUid?: string | null; displayName?: string | null; avatarUrl?: string | null } }).profile;
      if (profile?.platformUid) updates.platformUid = profile.platformUid;
      if (profile?.displayName) updates.displayName = profile.displayName;
      if (profile?.avatarUrl) updates.avatarUrl = profile.avatarUrl;
    }
    this.db.update(accounts).set(updates).where(eq(accounts.id, this.accountId)).run();
    if (status !== "CONNECTED") {
      this.pauseEnabledGroups();
    }
    if (this.lastPersisted !== status) {
      this.lastPersisted = status;
      this.bus.publish("auth.status_changed", { status });
    }
  }

  async refresh(force = false): Promise<void> {
    const row = this.accountRow();
    if (!row) return;
    const sourceStatus = this.requireSource().getStatus();
    const profile = (this.requireSource() as { profile?: { platformUid?: string | null; displayName?: string | null; avatarUrl?: string | null } }).profile;
    if (profile) {
      const updates: Record<string, unknown> = {};
      if (profile.platformUid && profile.platformUid !== row.platformUid) updates.platformUid = profile.platformUid;
      if (profile.displayName && profile.displayName !== row.displayName) updates.displayName = profile.displayName;
      if (profile.avatarUrl && profile.avatarUrl !== row.avatarUrl) updates.avatarUrl = profile.avatarUrl;
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = now();
        this.db.update(accounts).set(updates).where(eq(accounts.id, this.accountId)).run();
      }
    }
    const sourceChallenge = (this.requireSource() as { currentChallenge?: LoginChallenge | null }).currentChallenge;
    if (sourceChallenge) this.challenge = sourceChallenge;
    if (sourceStatus.connected) {
      this.challenge = null;
      if (row.status !== "CONNECTED") {
        this.updateStatus("CONNECTED", null);
        this.bus.publish("auth.status_changed", { status: "CONNECTED" });
      }
      if (!this.connectedHandled || force) {
        this.connectedHandled = true;
        try {
          await this.hooks.onConnected?.();
        } catch (error) {
          this.logger.error({ error: safeErrorMessage(error) }, "连接后同步失败");
        }
      }
      return;
    }
    this.connectedHandled = false;
    const status = sourceStatus.state === "UNCONFIGURED" ? "LOGIN_REQUIRED" : sourceStatus.state;
    if (status !== row.status) {
      this.updateStatus(status, sourceStatus.lastError);
    }
    if (sourceStatus.lastError && sourceStatus.lastError !== row.lastError) {
      this.db
        .update(accounts)
        .set({ lastError: sourceStatus.lastError, updatedAt: now() })
        .where(eq(accounts.id, this.accountId))
        .run();
    }
  }

  markMessageReceived(sentAt: number): void {
    if (!this.accountId) return;
    this.db
      .update(accounts)
      .set({ lastMessageAt: sentAt, status: "CONNECTED", lastError: null, updatedAt: now() })
      .where(eq(accounts.id, this.accountId))
      .run();
  }

  markSyncSucceeded(at = now()): void {
    if (!this.accountId) return;
    this.db
      .update(accounts)
      .set({ lastSuccessfulSyncAt: at, updatedAt: at })
      .where(eq(accounts.id, this.accountId))
      .run();
  }

  async startLogin(): Promise<LoginChallenge> {
    this.updateStatus("AUTHENTICATING", null);
    this.challenge = await this.requireSource().startLogin();
    if (this.challenge.kind === "none") {
      await this.refresh(true);
    } else {
      this.updateStatus(
        this.challenge.kind === "verification" ? "VERIFY_REQUIRED" : "AUTHENTICATING",
        null,
      );
    }
    this.bus.publish("auth.status_changed", { status: this.requireSource().getStatus().state });
    return this.challenge;
  }

  /** Demo only: the mock adapter simulates a successful mobile scan. */
  async completeDemoLogin(displayName?: string): Promise<void> {
    if (!(this.requireSource() instanceof MockMessageSource)) {
      throw Object.assign(new Error("当前适配器不支持模拟扫码"), { statusCode: 400 });
    }
    if (!this.config.demoMode) {
      throw Object.assign(new Error("演示模式已关闭"), { statusCode: 403 });
    }
    await (this.requireSource() as MockMessageSource).completeDemoLogin(displayName);
    this.challenge = null;
    await this.refresh(true);
    this.bus.publish("auth.status_changed", { status: "CONNECTED" });
  }

  async logout(): Promise<void> {
    await this.requireSource().logout();
    this.challenge = null;
    this.connectedHandled = false;
    this.updateStatus("LOGGED_OUT", null);
    this.db
      .update(groups)
      .set({ status: "paused", updatedAt: now() })
      .where(eq(groups.accountId, this.accountId))
      .run();
    this.bus.publish("auth.status_changed", { status: "LOGGED_OUT" });
    this.bus.publish("group.status_changed", { reason: "logged_out" });
  }

  async disconnect(): Promise<void> {
    await this.requireSource().disconnect();
  }

  getStatus(setupRequired: boolean): AuthStatusPayload {
    const row = this.accountRow();
    const sourceStatus: SourceStatus = this.requireSource().getStatus();
    return {
      accountId: this.accountId,
      adapter: this.config.imAdapter,
      status: (row?.status as AccountStatus) ?? sourceStatus.state,
      platformUid: row?.platformUid ?? null,
      displayName: row?.displayName ?? null,
      avatarUrl: row?.avatarUrl ?? null,
      lastConnectedAt: row?.lastConnectedAt ?? null,
      lastMessageAt: row?.lastMessageAt ?? null,
      lastSuccessfulSyncAt: row?.lastSuccessfulSyncAt ?? null,
      lastError: row?.lastError ?? sourceStatus.lastError ?? null,
      challenge: this.challenge,
      setupRequired,
    };
  }

  get currentChallenge(): LoginChallenge | null {
    return this.challenge;
  }

  async syncHistory(groupId: string, cursor?: string) {
    return this.requireSource().syncHistory(groupId, cursor);
  }

  async listGroups() {
    return this.requireSource().listGroups();
  }
}
