import { describe, expect, it } from "vitest";
import { formatBytes, mapLimit, redactUrl, resolveWithin, safeErrorMessage } from "@vault/shared";

describe("shared utilities", () => {
  it("formats bytes without negative values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(null)).toBe("—");
  });

  it("redacts signed query strings", () => {
    expect(redactUrl("https://v.douyinvod.com/video/tos/x?signature=secret&expires=1")).toBe(
      "https://v.douyinvod.com/video/tos/x?[redacted]",
    );
    expect(redactUrl("not a url")).toBeNull();
  });

  it("blocks path traversal", () => {
    expect(resolveWithin("/tmp/vault", "a/b.mp4")).toBe("/tmp/vault/a/b.mp4");
    expect(() => resolveWithin("/tmp/vault", "../outside.mp4")).toThrow();
    expect(() => resolveWithin("/tmp/vault", "a/../../outside.mp4")).toThrow();
  });

  it("bounds async concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return value * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("truncates error strings", () => {
    expect(safeErrorMessage(new Error("x".repeat(500))).length).toBe(300);
  });

  it("strips URLs from error messages before logging", () => {
    const message = safeErrorMessage(new Error("failed at https://v.douyinvod.com/x?signature=secret"));
    expect(message).toContain("[url]");
    expect(message).not.toContain("signature=secret");
  });
});
