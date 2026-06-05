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
});
