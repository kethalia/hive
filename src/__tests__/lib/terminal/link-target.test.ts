import { describe, expect, it } from "vitest";
import { terminalLinkTarget, terminalPathMatches } from "@/lib/terminal/link-target";
import { resolveTerminalFilePath } from "@/lib/workspaces/terminal-file-path";

describe("terminal file targets", () => {
  it.each([
    ["docs/design/reference.png", "docs/design/reference.png"],
    ["file:///home/coder/a%20b.png", "/home/coder/a b.png"],
    ["file://ai-dev-01/home/coder/source.ts#L12", "/home/coder/source.ts"],
    ["src/app.ts:12:3", "src/app.ts"],
    ["README.md:12", "README.md"],
  ])("recognizes %s", (value, path) => {
    expect(terminalLinkTarget(value)).toEqual({ kind: "file", value: path });
  });
  it("finds Markdown and absolute paths without stealing URL substrings", () => {
    const text =
      "See (docs/design/reference.png), /home/coder/file.txt and https://example.com/docs/test.md";
    expect(terminalPathMatches(text)).toEqual([
      { text: "docs/design/reference.png", index: text.indexOf("docs/") },
      { text: "/home/coder/file.txt", index: text.indexOf("/home") },
    ]);
  });
  it("resolves relative and home paths and rejects paths outside File Browser", () => {
    expect(resolveTerminalFilePath("../image.png", "/home/coder/project/docs", "/home/coder")).toBe(
      "/home/coder/project/image.png",
    );
    expect(resolveTerminalFilePath("~/image.png", undefined, "/home/coder")).toBe(
      "/home/coder/image.png",
    );
    expect(() => resolveTerminalFilePath("../../etc/passwd", "/home/coder", "/home/coder")).toThrow(
      "outside",
    );
    expect(() =>
      resolveTerminalFilePath("/home/coder-other/a.txt", undefined, "/home/coder"),
    ).toThrow("outside");
    expect(() => resolveTerminalFilePath("image.png", undefined, "/home/coder")).toThrow(
      "current directory",
    );
  });
});
