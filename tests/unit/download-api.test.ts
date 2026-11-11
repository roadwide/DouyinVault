import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMediaFromApiPayload } from "@vault/downloader-adapters";

const v5 = JSON.parse(readFileSync("tests/fixtures/douyin-api-v5.json", "utf8"));

describe("download API media extraction", () => {
  it("extracts the video stream, not the cover image", () => {
    const result = extractMediaFromApiPayload(v5);
    expect(result?.url).toContain("douyinvod.com");
    expect(result?.url).toContain("mime_type=video_mp4");
    expect(result?.url).not.toContain("cover");
    expect(result?.title).toBe("海边日落的 30 秒");
    expect(result?.authorName).toBe("林小满");
    expect(result?.coverUrl).toContain("douyinpic.com");
    expect(result?.durationSeconds).toBe(12.5);
  });

  it("handles v4-style nested play_addr.url_list", () => {
    const payload = {
      code: 200,
      data: {
        desc: "v4 video",
        video: {
          play_addr: {
            url_list: ["https://v26.douyinvod.com/video/tos/v4"],
          },
          cover: {
            url_list: ["https://p3.douyinpic.com/cover.jpeg"],
          },
        },
      },
    };
    const result = extractMediaFromApiPayload(payload);
    expect(result?.url).toBe("https://v26.douyinvod.com/video/tos/v4");
  });

  it("prefers mp4 over HLS playlists", () => {
    const payload = {
      data: {
        video: {
          play_addr: {
            url_list: [
              "https://v3.douyinvod.com/video/tos/playlist.m3u8",
              "https://v3.douyinvod.com/video/tos/file.mp4",
            ],
          },
        },
      },
    };
    expect(extractMediaFromApiPayload(payload)?.url).toContain(".mp4");
  });

  it("returns null when only covers or avatars exist", () => {
    const payload = {
      data: {
        cover: { url_list: ["https://p3.douyinpic.com/cover.jpeg"] },
        author: { avatar: { url_list: ["https://p3.douyinpic.com/avatar.jpeg"] } },
      },
    };
    expect(extractMediaFromApiPayload(payload)).toBeNull();
  });

  it("does not pick up arbitrary non-media URLs", () => {
    const payload = {
      data: {
        share_url: "https://www.douyin.com/video/7412345678901234567",
        author: { profile: "https://www.douyin.com/user/abc" },
      },
    };
    expect(extractMediaFromApiPayload(payload)).toBeNull();
  });
});
