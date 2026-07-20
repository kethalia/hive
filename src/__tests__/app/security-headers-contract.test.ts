import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "../../../next.config";

describe("security headers contract", () => {
  it("does not allow arbitrary HTTPS origins in workspace frames", () => {
    expect(contentSecurityPolicy).toContain("frame-src 'self'");
    expect(contentSecurityPolicy).not.toContain("frame-src 'self' https:");
  });

  it("keeps Hive itself restricted to same-origin framing", () => {
    expect(contentSecurityPolicy).toContain("frame-ancestors 'self'");
  });

  it("renders frame-host metadata from the current document policy", async () => {
    const layoutSource = await readFile("src/app/layout.tsx", "utf8");

    expect(layoutSource).toContain("CODER_FRAME_HOSTS_REQUEST_HEADER");
    expect(layoutSource).not.toContain("CODER_HOST_COOKIE");
  });
});
