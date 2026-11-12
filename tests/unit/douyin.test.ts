import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyMessage,
  isAllowedMediaUrl,
  isDouyinUrl,
  isValidWorkId,
  mediaKeyForMessage,
  mediaKeyForWork,
  parseDouyinShareText,
  priorityForSource,
} from "@vault/core";

describe("Douyin share parsing", () => {
  it("extracts a work id from a full video URL", () => {
    const parsed = parseDouyinShareText("看看这个 https://www.douyin.com/video/7412345678901234567 好看");
    expect(parsed.workId).toBe("7412345678901234567");
    expect(parsed.shareUrl).toBe("https://www.douyin.com/video/7412345678901234567");
  });

  it("extracts modal_id from jingxuan links", () => {
    const parsed = parseDouyinShareText("https://www.douyin.com/jingxuan?modal_id=7412345678901234568");
    expect(parsed.workId).toBe("7412345678901234568");
  });

  it("extracts a short link even without a work id", () => {
    const parsed = parseDouyinShareText(
      "2.84 nqe:/ 复制打开抖音，看看【作者的作品】 https://v.douyin.com/L4FJNR3/ 很好看",
    );
    expect(parsed.shareUrl).toBe("https://v.douyin.com/L4FJNR3/");
    expect(parsed.workId).toBeUndefined();
  });

  it("parses the recorded fixture caption", () => {
    const text = readFileSync(resolve("tests/fixtures/share-text.txt"), "utf8");
    const parsed = parseDouyinShareText(text);
    expect(parsed.workId).toBe("7412345678901234577");
    expect(parsed.shareUrl).toContain("v.douyin.com");
  });

  it("does not treat lookalike domains as Douyin", () => {
    expect(isDouyinUrl("https://douyin.com.evil.example/video/123")).toBe(false);
    expect(isDouyinUrl("https://v.douyin.com/abc")).toBe(true);
  });

  it("validates work ids as strings with sane lengths", () => {
    expect(isValidWorkId("7412345678901234567")).toBe(true);
    expect(isValidWorkId("123")).toBe(false);
    expect(isValidWorkId(7412345678901234567)).toBe(false);
    expect(isValidWorkId("741234567890123456789012345678901")).toBe(false);
  });

  it("classifies structured work cards before text heuristics", () => {
    const result = classifyMessage({
      workId: "7412345678901234567",
      mediaUrl: "https://v.douyinvod.com/abc",
      text: "unrelated",
    });
    expect(result.type).toBe("shared_work");
  });

  it("classifies chat media as chat_video", () => {
    expect(classifyMessage({ mediaUrl: "https://v.douyinvod.com/abc" }).type).toBe("chat_video");
  });

  it("marks an unusable work card unresolved instead of inventing an id", () => {
    const result = classifyMessage({ messageType: 8 });
    expect(result.type).toBe("unknown");
    expect(result.diagnostic).toContain("UNRESOLVED");
  });

  it("keeps video text with a link but no id as text_with_url", () => {
    const result = classifyMessage({ text: "https://v.douyin.com/abc/" });
    expect(result.type).toBe("text_with_url");
    expect(result.diagnostic).toBeTruthy();
  });
});

describe("media host allowlist", () => {
  it("accepts Douyin CDN subdomains over HTTPS", () => {
    expect(isAllowedMediaUrl("https://v3.douyinvod.com/video/tos/abc?mime_type=video_mp4")).toBe(true);
    expect(
      isAllowedMediaUrl(
        "https://edge.free-lbv6.idouyinvod.com/video/tos/abc?mime_type=video_mp4",
      ),
    ).toBe(true);
    expect(isAllowedMediaUrl("https://p3.douyinpic.com/cover.jpg")).toBe(true);
  });

  it("rejects lookalike, file and non-http URLs", () => {
    expect(isAllowedMediaUrl("https://douyinvod.com.evil.example/x.mp4")).toBe(false);
    expect(isAllowedMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedMediaUrl("https://evil.example/x.mp4")).toBe(false);
  });

  it("only permits loopback explicitly", () => {
    expect(isAllowedMediaUrl("http://127.0.0.1:8080/x.mp4")).toBe(false);
    expect(isAllowedMediaUrl("http://127.0.0.1:8080/x.mp4", { allowLoopback: true })).toBe(true);
  });

  it("supports extra configured hosts", () => {
    expect(isAllowedMediaUrl("https://media.example.test/v.mp4", { extraHosts: ["example.test"] })).toBe(true);
  });
});

describe("media identity", () => {
  it("uses platform work ids as the primary dedupe key", () => {
    expect(mediaKeyForWork("7412345678901234567")).toBe("douyin:work:7412345678901234567");
  });

  it("uses a stable message key when no work id exists", () => {
    expect(mediaKeyForMessage("group/message")).toBe("douyin:message:group/message");
  });

  it("maps job priorities", () => {
    expect(priorityForSource("realtime")).toBe(0);
    expect(priorityForSource("manual")).toBe(1);
    expect(priorityForSource("history")).toBe(2);
    expect(priorityForSource("repair")).toBe(3);
  });
});
