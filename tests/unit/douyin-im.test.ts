import { describe, expect, it } from "vitest";
import { extractWorkMediaFromDetail, summarizeWorkAvailability } from "@vault/im-adapters";

function detail(overrides: Record<string, unknown> = {}) {
  return {
    workId: "7412345678901234567",
    filtered: false,
    detail: {
      desc: "海边日落的 30 秒",
      video_control: { allow_download: true },
      aweme_control: { can_share: true },
      video: {
        download_addr: {
          url_list: [
            "https://v26.douyinvod.com/video/tos/download.mp4",
            "https://v27.douyinvod.com/video/tos/download.mp4",
          ],
        },
        play_addr: {
          url_list: ["https://v26.douyinvod.com/video/tos/play.mp4"],
        },
        cover: {
          url_list: ["https://p3.douyinpic.com/cover.jpeg"],
        },
      },
      author: { nickname: "林小满" },
    },
    ...overrides,
  };
}

describe("shared work availability", () => {
  it("marks filtered and missing works unavailable", () => {
    const result = summarizeWorkAvailability(
      [
        { workId: "7412345678901234567", filtered: false, detail: {} },
        { workId: "7412345678901234568", filtered: true, reason: { type: 1 } },
      ],
      ["7412345678901234567", "7412345678901234568", "7412345678901234569"],
    );
    expect(result).toEqual([
      { workId: "7412345678901234567", state: "available" },
      { workId: "7412345678901234568", state: "unavailable", reason: "filtered" },
      { workId: "7412345678901234569", state: "unavailable", reason: "missing" },
    ]);
  });
});

describe("shared work media extraction", () => {
  it("uses the authorized download address and metadata", () => {
    const result = extractWorkMediaFromDetail(detail());
    expect(result).toEqual({
      url: "https://v26.douyinvod.com/video/tos/download.mp4",
      title: "海边日落的 30 秒",
      coverUrl: "https://p3.douyinpic.com/cover.jpeg",
      authorName: "林小满",
    });
  });

  it("uses the play stream when the download button is disabled", () => {
    const value = detail();
    (value.detail.video_control as { allow_download: boolean }).allow_download = false;
    expect(extractWorkMediaFromDetail(value)?.url).toBe(
      "https://v26.douyinvod.com/video/tos/play.mp4",
    );
  });

  it("falls back to the play stream when no download address is present", () => {
    const value = detail();
    (value.detail.video as { download_addr?: unknown }).download_addr = undefined;
    expect(extractWorkMediaFromDetail(value)?.url).toBe(
      "https://v26.douyinvod.com/video/tos/play.mp4",
    );
  });

  it("ignores a filtered work", () => {
    const value = detail({ filtered: true, reason: { type: 1 } });
    expect(extractWorkMediaFromDetail(value)).toBeNull();
  });

  it("returns null when neither download nor play addresses are present", () => {
    const value = detail();
    const video = value.detail.video as { download_addr?: unknown; play_addr?: unknown };
    video.download_addr = undefined;
    video.play_addr = undefined;
    expect(extractWorkMediaFromDetail(value)).toBeNull();
  });

  it("skips non-http entries in url_list", () => {
    const value = detail();
    (value.detail.video.download_addr as { url_list: string[] }).url_list = [
      "",
      "data:video/mp4;base64,AAAA",
      "https://v26.douyinvod.com/video/tos/download.mp4",
    ];
    expect(extractWorkMediaFromDetail(value)?.url).toBe(
      "https://v26.douyinvod.com/video/tos/download.mp4",
    );
  });

  it("prefers an MP4 stream over an HLS playlist", () => {
    const value = detail();
    (value.detail.video.play_addr as { url_list: string[] }).url_list = [
      "https://v26.douyinvod.com/video/tos/playlist.m3u8",
      "https://v27.douyinvod.com/video/tos/stream.mp4?mime_type=video_mp4",
    ];
    (value.detail.video as { download_addr?: unknown }).download_addr = undefined;
    expect(extractWorkMediaFromDetail(value)?.url).toContain("stream.mp4");
  });
});
