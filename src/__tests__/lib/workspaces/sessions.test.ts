import { describe, expect, it } from "vitest";
import { parseTmuxSessions } from "@/lib/workspaces/sessions";

describe("parseTmuxSessions", () => {
  it("parses a single session line", () => {
    const result = parseTmuxSessions("main:1712345678:3");

    expect(result).toEqual([{ name: "main", created: 1712345678, windows: 3 }]);
  });

  it("parses multiple session lines", () => {
    const input = "main:1712345678:3\ndev:1712345700:1\ntest:1712345800:5";
    const result = parseTmuxSessions(input);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: "main", created: 1712345678, windows: 3 });
    expect(result[1]).toEqual({ name: "dev", created: 1712345700, windows: 1 });
    expect(result[2]).toEqual({ name: "test", created: 1712345800, windows: 5 });
  });

  it("returns empty array for empty string", () => {
    expect(parseTmuxSessions("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseTmuxSessions("   \n  \n  ")).toEqual([]);
  });

  it("skips lines with fewer than 3 colon-separated fields", () => {
    const input = "main:1712345678:3\nbad-line\nalso:bad\ngood:1712345700:2";
    const result = parseTmuxSessions(input);

    expect(result).toEqual([
      { name: "main", created: 1712345678, windows: 3 },
      { name: "good", created: 1712345700, windows: 2 },
    ]);
  });

  it("skips lines with non-numeric created or windows", () => {
    const input = "main:abc:3\ndev:1712345678:xyz\ngood:1712345700:2";
    const result = parseTmuxSessions(input);

    expect(result).toEqual([{ name: "good", created: 1712345700, windows: 2 }]);
  });

  it("handles trailing newline", () => {
    const result = parseTmuxSessions("main:1712345678:3\n");

    expect(result).toEqual([{ name: "main", created: 1712345678, windows: 3 }]);
  });
});
