import { describe, expect, it } from "vitest";
import { DownloadError, type VaultError } from "@vault/core";
import {
  selectDownloadError,
  type AdapterFailure,
} from "../../apps/server/src/downloads/error-selection.js";

function failure(adapter: string, error: VaultError): AdapterFailure {
  return { adapter, error };
}

const cookieError = new DownloadError(
  "RESOURCE_UNAVAILABLE",
  "yt-dlp 需要抖音登录 Cookie 才能解析该作品",
  { retryable: false },
);
const redirectError = new DownloadError(
  "RESOURCE_UNAVAILABLE",
  "重定向目标不在允许的域名范围内（edge.idouyinvod.com）",
  { retryable: false },
);

describe("download error selection", () => {
  it("prefers a retryable adapter error", () => {
    const network = new DownloadError("NETWORK", "连接重置", { retryable: true });
    expect(
      selectDownloadError({
        retryableError: network,
        specificError: null,
        lastError: cookieError,
        resolveFailure: null,
        failures: [],
      }),
    ).toBe(network);
  });

  it("prefers a concrete adapter error over a generic one", () => {
    const invalid = new DownloadError("INVALID_MEDIA", "下载结果是音频文件");
    expect(
      selectDownloadError({
        retryableError: null,
        specificError: invalid,
        lastError: cookieError,
        resolveFailure: null,
        failures: [],
      }),
    ).toBe(invalid);
  });

  it("keeps the IM resolver reason when no downloader produced a link", () => {
    const selected = selectDownloadError({
      retryableError: null,
      specificError: null,
      lastError: cookieError,
      resolveFailure: "平台过滤了该作品的详情",
      failures: [failure("yt-dlp", cookieError)],
    });
    expect(selected.code).toBe("RESOURCE_UNAVAILABLE");
    expect(selected.message).toContain("主 IM 适配器无法解析该作品");
    expect(selected.message).toContain("平台过滤了该作品的详情");
  });

  it("surfaces the primary downloader failure instead of yt-dlp's cookie message", () => {
    const selected = selectDownloadError({
      retryableError: null,
      specificError: null,
      lastError: cookieError,
      resolveFailure: null,
      failures: [
        failure("direct", redirectError),
        failure("yt-dlp", cookieError),
      ],
    });
    expect(selected).toBe(redirectError);
  });

  it("keeps yt-dlp's message when it is the only attempted adapter", () => {
    const selected = selectDownloadError({
      retryableError: null,
      specificError: null,
      lastError: cookieError,
      resolveFailure: null,
      failures: [failure("yt-dlp", cookieError)],
    });
    expect(selected).toBe(cookieError);
  });
});
