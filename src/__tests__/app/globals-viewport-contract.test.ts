import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("global viewport sizing contract", () => {
  it("uses the large viewport unit for the app shell when Safari supports it", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

    expect(css).toContain("--app-viewport-height: 100vh;");
    expect(css).toMatch(
      /@supports \(height: 100lvh\) \{\s*:root \{\s*--app-viewport-height: 100lvh;\s*}\s*}/,
    );
  });

  it("keeps focused form controls above the iOS automatic zoom threshold", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

    expect(css).toMatch(
      /@media \(pointer: coarse\) and \(max-width: 1366px\) \{\s*:root input,\s*:root select,\s*:root textarea \{\s*font-size: 16px;\s*}\s*}/,
    );
    expect(css).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  });
});
