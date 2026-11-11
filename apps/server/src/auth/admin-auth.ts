import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import "@fastify/cookie";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, lt } from "drizzle-orm";
import { ulid } from "ulid";
import { adminSessions, settings, type schema } from "@vault/db";
import { now } from "@vault/shared";
import type { AppConfig, Paths } from "../config.js";
import type { Logger } from "../logger.js";
import { writePrivateFile } from "../paths.js";

export const SESSION_COOKIE = "dv_session";
const PASSWORD_KEY = "auth.password_hash";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

export interface AdminSession {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

export interface AuthSessionInfo {
  setupRequired: boolean;
  authenticated: boolean;
  csrfToken: string | null;
}

export function createPasswordHash(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, salt, digest] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !digest) return false;
    const expected = Buffer.from(digest, "base64");
    const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

class AttemptLimiter {
  private attempts = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const current = now();
    const recent = (this.attempts.get(key) ?? []).filter((time) => current - time < this.windowMs);
    this.attempts.set(key, recent);
    if (recent.length >= this.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((this.windowMs - (current - (recent[0] as number))) / 1000),
      };
    }
    recent.push(current);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

export class AdminAuthService {
  private readonly limiter = new AttemptLimiter(6, 5 * 60_000);
  private setupTokenPath: string;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly config: AppConfig,
    private readonly paths: Paths,
    private readonly logger: Logger,
  ) {
    this.setupTokenPath = `${paths.sessionsDir}/setup-token.txt`;
  }

  initialize(): void {
    const existing = this.getSetting(PASSWORD_KEY);
    if (!existing) {
      if (this.config.adminPassword) {
        if (this.config.adminPassword.length < 10) {
          throw new Error("ADMIN_PASSWORD 至少需要 10 个字符");
        }
        this.setSetting(PASSWORD_KEY, createPasswordHash(this.config.adminPassword));
        this.logger.info("管理员密码已从 ADMIN_PASSWORD 初始化。");
      } else {
        this.ensureSetupToken();
      }
    } else if (existsSync(this.setupTokenPath)) {
      rmSync(this.setupTokenPath, { force: true });
    }
    this.db.delete(adminSessions).where(lt(adminSessions.expiresAt, now())).run();
  }

  private getSetting(key: string): string | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    const timestamp = now();
    this.db
      .insert(settings)
      .values({ key, value, updatedAt: timestamp })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: timestamp } })
      .run();
  }

  private ensureSetupToken(): string {
    if (existsSync(this.setupTokenPath)) {
      const existing = readFileSync(this.setupTokenPath, "utf8").trim();
      if (existing) return existing;
    }
    const token = randomBytes(24).toString("base64url");
    writePrivateFile(
      this.setupTokenPath,
      `${token}\n\nDouyin Vault first-run setup token.\nRun "pnpm setup-token" to print it again.\nThis file is deleted after the admin password is set.\n`,
    );
    this.logger.warn(
      { path: this.setupTokenPath },
      "尚未设置管理员密码。已生成一次性安装令牌；请在运行服务的机器上执行 pnpm setup-token。",
    );
    return token;
  }

  get setupRequired(): boolean {
    return !this.getSetting(PASSWORD_KEY);
  }

  getSetupTokenPath(): string {
    return this.setupTokenPath;
  }

  sessionInfo(req: FastifyRequest): AuthSessionInfo {
    if (this.setupRequired) {
      return { setupRequired: true, authenticated: false, csrfToken: null };
    }
    const session = this.readSession(req);
    return {
      setupRequired: false,
      authenticated: Boolean(session),
      csrfToken: session?.csrfToken ?? null,
    };
  }

  completeSetup(input: { token: string; password: string }, ip: string): AdminSession {
    if (!this.setupRequired) throw Object.assign(new Error("管理员密码已经设置"), { statusCode: 409 });
    const limited = this.limiter.check(`setup:${ip}`);
    if (!limited.allowed) {
      throw Object.assign(new Error("尝试次数过多，请稍后再试"), {
        statusCode: 429,
        retryAfter: limited.retryAfterSeconds,
      });
    }
    if (input.password.length < 10) {
      throw Object.assign(new Error("密码至少需要 10 个字符"), { statusCode: 400 });
    }
    const path = this.setupTokenPath;
    if (!existsSync(path)) {
      throw Object.assign(new Error("安装令牌不存在，请重启服务或执行 pnpm setup-token"), {
        statusCode: 400,
      });
    }
    const expected = readFileSync(path, "utf8").split("\n")[0]?.trim() ?? "";
    const actual = input.token.trim();
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    const valid =
      expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
    if (!valid) {
      throw Object.assign(new Error("安装令牌不正确"), { statusCode: 401 });
    }
    this.setSetting(PASSWORD_KEY, createPasswordHash(input.password));
    rmSync(path, { force: true });
    this.limiter.reset(`setup:${ip}`);
    this.logger.info("管理员密码设置完成，安装令牌已删除。");
    return this.createSession("initial-setup");
  }

  login(password: string, ip: string, userAgent?: string): AdminSession {
    const limited = this.limiter.check(`login:${ip}`);
    if (!limited.allowed) {
      throw Object.assign(new Error("登录尝试过多，请 5 分钟后再试"), {
        statusCode: 429,
        retryAfter: limited.retryAfterSeconds,
      });
    }
    const stored = this.getSetting(PASSWORD_KEY);
    if (!stored || !verifyPassword(password, stored)) {
      throw Object.assign(new Error("密码不正确"), { statusCode: 401 });
    }
    this.limiter.reset(`login:${ip}`);
    return this.createSession(userAgent);
  }

  private createSession(userAgent?: string): AdminSession {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const id = ulid();
    const timestamp = now();
    const expiresAt = timestamp + this.config.sessionDays * 86_400_000;
    this.db
      .insert(adminSessions)
      .values({
        id,
        tokenHash: tokenHash(token),
        csrfToken,
        createdAt: timestamp,
        expiresAt,
        lastSeenAt: timestamp,
        userAgent: userAgent?.slice(0, 200) ?? null,
      })
      .run();
    return { id, csrfToken, expiresAt, ...{ token } } as AdminSession & { token: string };
  }

  readSession(req: FastifyRequest): (AdminSession & { token: string }) | null {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const row = this.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.tokenHash, tokenHash(token)))
      .get();
    if (!row) return null;
    if (row.expiresAt <= now()) {
      this.db.delete(adminSessions).where(eq(adminSessions.id, row.id)).run();
      return null;
    }
    if (now() - row.lastSeenAt > 60_000) {
      this.db
        .update(adminSessions)
        .set({ lastSeenAt: now() })
        .where(eq(adminSessions.id, row.id))
        .run();
    }
    return { id: row.id, csrfToken: row.csrfToken, expiresAt: row.expiresAt, token };
  }

  setSessionCookie(reply: FastifyReply, session: AdminSession, request?: FastifyRequest): void {
    const token = (session as AdminSession & { token?: string }).token;
    if (!token) throw new Error("Session token is only available at creation time");
    const forwarded = request?.headers["x-forwarded-proto"];
    const https = request?.protocol === "https" ||
      (typeof forwarded === "string" && forwarded.split(",")[0]?.trim() === "https");
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Keep local HTTP debugging usable while still marking the cookie Secure
      // when the request actually arrived over HTTPS (directly or via Tunnel).
      secure: this.config.secureCookies && Boolean(https),
      maxAge: this.config.sessionDays * 86_400,
    });
  }

  clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  logout(req: FastifyRequest, reply: FastifyReply): void {
    const session = this.readSession(req);
    if (session) this.db.delete(adminSessions).where(eq(adminSessions.id, session.id)).run();
    this.clearSessionCookie(reply);
  }

  verifyCsrf(req: FastifyRequest, session: AdminSession): boolean {
    const provided = req.headers["x-csrf-token"];
    if (typeof provided !== "string" || provided.length < 16) return false;
    const expected = Buffer.from(session.csrfToken);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  isOriginAllowed(req: FastifyRequest): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      const allowed = new Set<string>();
      if (this.config.publicOrigin) allowed.add(new URL(this.config.publicOrigin).origin);
      if (this.config.nodeEnv !== "production") {
        allowed.add("http://localhost:5173");
        allowed.add("http://127.0.0.1:5173");
      }
      const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
      if (host) {
        const proto =
          (req.headers["x-forwarded-proto"] as string | undefined) ??
          (req.protocol || "http");
        allowed.add(`${proto.split(",")[0]?.trim()}://${host.split(",")[0]?.trim()}`);
      }
      return allowed.has(parsed.origin);
    } catch {
      return false;
    }
  }
}
