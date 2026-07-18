import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "../../../next.config";

describe("security headers contract", () => {
  it("allows same-origin tools and HTTPS Coder apps in workspace frames", () => {
    expect(contentSecurityPolicy).toContain("frame-src 'self' https:");
  });

  it("keeps Hive itself restricted to same-origin framing", () => {
    expect(contentSecurityPolicy).toContain("frame-ancestors 'self'");
  });
});
