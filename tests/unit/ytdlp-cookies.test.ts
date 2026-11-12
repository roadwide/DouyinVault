import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { YtDlpDownloader } from "@vault/downloader-adapters";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "douyin-vault-ytdlp-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const input = {
  videoId: "video-1",
  workId: "7412345678901234567",
  shareUrl: null,
  mediaUrl: null,
  title: "cookie test",
  coverUrl: null,
};

describe("yt-dlp cookies", () => {
  it("rejects a configured but missing cookie file before spawning", async () => {
    const downloader = new YtDlpDownloader({
      binaryPath: "/bin/true",
      cookiesPath: join(tempDir(), "missing-cookies.txt"),
    });
    const media = await downloader.resolve(input);
    await expect(
      downloader.download(media, join(tempDir(), "unused.part"), () => undefined),
    ).rejects.toMatchObject({
      code: "CONFIG",
      message: expect.stringContaining("YTDLP_COOKIES_PATH"),
    });
  });

  it("passes the cookie file to yt-dlp", async () => {
    const directory = tempDir();
    const argsFile = join(directory, "args.json");
    const cookiesPath = join(directory, "cookies.txt");
    const outputPath = join(directory, "video.mp4");
    const fakeBinary = join(directory, "fake-yt-dlp.mjs");
    writeFileSync(cookiesPath, "# Netscape HTTP Cookie File\n", { mode: 0o600 });
    writeFileSync(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'writeFileSync(process.env.YTDLP_ARGS_FILE, JSON.stringify(args));',
        'writeFileSync(args[args.indexOf("-o") + 1], Buffer.from("fake-media"));',
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(fakeBinary, 0o700);

    const previous = process.env.YTDLP_ARGS_FILE;
    process.env.YTDLP_ARGS_FILE = argsFile;
    try {
      const downloader = new YtDlpDownloader({
        binaryPath: fakeBinary,
        cookiesPath,
      });
      const media = await downloader.resolve(input);
      const result = await downloader.download(media, outputPath, () => undefined);
      const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      const cookieIndex = args.indexOf("--cookies");
      expect(cookieIndex).toBeGreaterThanOrEqual(0);
      expect(args[cookieIndex + 1]).toBe(cookiesPath);
      expect(result.filePath).toBe(outputPath);
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.YTDLP_ARGS_FILE;
      else process.env.YTDLP_ARGS_FILE = previous;
    }
  });
});
