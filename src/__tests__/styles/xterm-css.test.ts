import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("xterm CSS selection mode", () => {
  it("keeps browser row selection scoped to explicit terminal selection mode", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/xterm.css"), "utf8");

    expect(css).toContain('[data-terminal-selection-mode="true"] .xterm .xterm-rows');
    expect(css).not.toContain("\n.xterm .xterm-rows,\n.xterm .xterm-rows *");
  });
});
