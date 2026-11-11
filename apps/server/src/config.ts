import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value == null || value === "") return fallback;
      return !["0", "false", "no", "off"].includes(value.toLowerCase());
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(18760),
  DATA_DIR: z.string().default("./data"),
  PUBLIC_ORIGIN: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  IM_ADAPTER: z.enum(["mock", "douyin-im", "playwright"]).default("mock"),
  DEMO_MODE: boolFromEnv(false),
  DTK_BASE_URL: z.string().optional(),
  DTK_API_KEY: z.string().optional(),
  DTK_MODE: z.enum(["auto", "v5", "v4"]).default("auto"),
  YTDLP_PATH: z.string().default("yt-dlp"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  MEDIA_ALLOWED_HOSTS: z.string().optional(),
  PLAYWRIGHT_HEADLESS: boolFromEnv(false),
  PLAYWRIGHT_PROFILE_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  LOG_PRETTY: boolFromEnv(false),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SECURE_COOKIES: boolFromEnv(false),
  WEB_DIST: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  publicOrigin: string | null;
  adminPassword: string | null;
  imAdapter: "mock" | "douyin-im" | "playwright";
  demoMode: boolean;
  dtkBaseUrl: string | null;
  dtkApiKey: string | null;
  dtkMode: "auto" | "v5" | "v4";
  ytdlpPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  mediaAllowedHosts: string[];
  playwrightHeadless: boolean;
  playwrightProfileDir: string;
  logLevel: string;
  logPretty: boolean;
  sessionDays: number;
  secureCookies: boolean;
  webDist: string;
}

export interface Paths {
  dataDir: string;
  dbDir: string;
  dbFile: string;
  sessionsDir: string;
  mediaDir: string;
  videosDir: string;
  coversDir: string;
  tempDir: string;
  logsDir: string;
  backupsDir: string;
  webDist: string;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const env = { ...process.env, ...overrides } as Record<string, string | undefined>;
  const parsed = EnvSchema.parse(env);
  const dataDir = resolve(parsed.DATA_DIR);
  const webDist = parsed.WEB_DIST
    ? resolve(parsed.WEB_DIST)
    : resolve(import.meta.dirname ?? process.cwd(), "../../web/dist");
  const secureCookies =
    parsed.SECURE_COOKIES || parsed.NODE_ENV === "production" || Boolean(parsed.PUBLIC_ORIGIN?.startsWith("https://"));
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir,
    publicOrigin: parsed.PUBLIC_ORIGIN ?? null,
    adminPassword: parsed.ADMIN_PASSWORD || null,
    imAdapter: parsed.IM_ADAPTER,
    demoMode: parsed.NODE_ENV === "production" ? false : parsed.DEMO_MODE,
    dtkBaseUrl: parsed.DTK_BASE_URL || null,
    dtkApiKey: parsed.DTK_API_KEY || null,
    dtkMode: parsed.DTK_MODE,
    ytdlpPath: parsed.YTDLP_PATH,
    ffmpegPath: parsed.FFMPEG_PATH,
    ffprobePath: parsed.FFPROBE_PATH,
    mediaAllowedHosts: (parsed.MEDIA_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    playwrightHeadless: parsed.PLAYWRIGHT_HEADLESS,
    playwrightProfileDir: parsed.PLAYWRIGHT_PROFILE_DIR
      ? resolve(parsed.PLAYWRIGHT_PROFILE_DIR)
      : resolve(dataDir, "browser-profile"),
    logLevel: parsed.LOG_LEVEL,
    logPretty: parsed.LOG_PRETTY,
    sessionDays: parsed.SESSION_DAYS,
    secureCookies,
    webDist,
  };
}

export function buildPaths(config: AppConfig): Paths {
  return {
    dataDir: config.dataDir,
    dbDir: resolve(config.dataDir, "db"),
    dbFile: resolve(config.dataDir, "db", "vault.sqlite"),
    sessionsDir: resolve(config.dataDir, "sessions"),
    mediaDir: resolve(config.dataDir, "media"),
    videosDir: resolve(config.dataDir, "media", "videos"),
    coversDir: resolve(config.dataDir, "media", "covers"),
    tempDir: resolve(config.dataDir, "temp"),
    logsDir: resolve(config.dataDir, "logs"),
    backupsDir: resolve(config.dataDir, "backups"),
    webDist: config.webDist,
  };
}

export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // .env is optional; environment variables still work.
  }
}
