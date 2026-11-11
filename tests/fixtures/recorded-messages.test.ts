import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyMessage, isValidWorkId, type NormalizedMessage } from "@vault/core";

const fixtures = JSON.parse(
  readFileSync("tests/fixtures/normalized-messages.json", "utf8"),
) as NormalizedMessage[];

describe("recorded IM fixtures", () => {
  it("keeps all platform identifiers as strings", () => {
    for (const message of fixtures) {
      expect(typeof message.messageId).toBe("string");
      expect(typeof message.groupId).toBe("string");
      if (message.workId) expect(typeof message.workId).toBe("string");
    }
  });

  it("classifies the work-card fixture as a shared work", () => {
    const message = fixtures[0]!;
    const result = classifyMessage({
      workId: message.workId,
      text: message.title,
    });
    expect(result.type).toBe("shared_work");
    expect(isValidWorkId(result.workId)).toBe(true);
  });

  it("keeps an unresolved work card as a diagnostic, not a fake video", () => {
    const message = fixtures[2]!;
    expect(message.type).toBe("unknown");
    expect(message.diagnostic).toContain("UNRESOLVED");
  });

  it("does not misclassify a short link as a known work id", () => {
    const message = fixtures[1]!;
    const result = classifyMessage({ text: message.shareUrl });
    expect(result.type).toBe("text_with_url");
    expect(result.workId).toBeUndefined();
  });
});
