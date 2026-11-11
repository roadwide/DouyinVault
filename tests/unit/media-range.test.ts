import { describe, expect, it } from "vitest";
import { parseRange } from "../../apps/server/src/api/media.js";

describe("HTTP Range parser", () => {
  it("returns null when no range is requested", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199, length: 100 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999, length: 100 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999, length: 100 });
  });

  it("clamps an end beyond the file size", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999, length: 100 });
  });

  it("rejects malformed or unsatisfiable ranges", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("invalid");
    expect(parseRange("bytes=500-400", 1000)).toBe("invalid");
    expect(parseRange("bytes=abc-def", 1000)).toBe("invalid");
    expect(parseRange("bytes=-0", 1000)).toBe("invalid");
    expect(parseRange("items=0-1", 1000)).toBe("invalid");
  });

  it("serves the whole file for suffix ranges larger than the file", () => {
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999, length: 1000 });
  });
});
