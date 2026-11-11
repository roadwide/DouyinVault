import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../../apps/server/src/config.js";
import { createContext, type AppContext } from "../../apps/server/src/context.js";

export interface TestVault {
  context: AppContext;
  config: AppConfig;
  dataDir: string;
  dispose: () => Promise<void>;
}

export async function createTestVault(
  options: { adminPassword?: string | null; dataDir?: string } = {},
): Promise<TestVault> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "douyin-vault-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "18760",
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: options.adminPassword === null ? "" : (options.adminPassword ?? "test-password-123"),
    IM_ADAPTER: "mock",
    DEMO_MODE: "true",
    LOG_LEVEL: "silent",
    LOG_PRETTY: "false",
    SECURE_COOKIES: "false",
    PUBLIC_ORIGIN: "",
    FFMPEG_PATH: "/nonexistent/ffmpeg-for-tests",
    FFPROBE_PATH: process.env.FFPROBE_PATH ?? "ffprobe",
    YTDLP_PATH: "/nonexistent/yt-dlp-for-tests",
    DTK_BASE_URL: "",
    DTK_API_KEY: "",
    MEDIA_ALLOWED_HOSTS: "",
  });
  const context = await createContext(config);
  context.settings.update({
    storage: { capacityGb: 1, safetyReserveGb: 0 },
    download: {
      enabled: true,
      concurrency: 1,
      verifyWithFfprobe: false,
      maxAttempts: 2,
      retryDelaysSeconds: [5, 5],
      timeoutSeconds: 30,
    },
    cleanup: { enabled: true, runHourLocal: 3 },
  });
  return {
    context,
    config,
    dataDir,
    dispose: async () => {
      await context.close();
      if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function fakeMp4(size = 4096): Buffer {
  const buffer = Buffer.alloc(size, 0x21);
  buffer.writeUInt32BE(24, 0);
  buffer.write("ftypisom", 4, "ascii");
  buffer.writeUInt32BE(0x69736f6d, 8);
  buffer.write("isomiso2avc1mp41", 12, "ascii");
  return buffer;
}
