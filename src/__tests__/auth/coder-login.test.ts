import { afterEach, describe, expect, it, vi } from "vitest";
import { coderLoginError, coderLoginMode, coderLoginStartUrl } from "@/lib/auth/coder-login.server";

const configured = {
  HIVE_CODER_OAUTH_ENABLED: "true",
  CODER_URL: "https://coder.kethalia.com",
  HIVE_PUBLIC_ORIGIN: "https://hive.example",
  HIVE_CODER_OAUTH_CLIENT_ID: "fixture-client",
  HIVE_CODER_OAUTH_CLIENT_SECRET: "synthetic-secret",
};
afterEach(() => vi.unstubAllEnvs());
describe("OAuth presentation projection", () => {
  it("reads live server readiness for each request instead of capturing build-time values", () => {
    for (const [key, value] of Object.entries(configured)) vi.stubEnv(key, value);
    expect(coderLoginMode()).toBe("oauth");
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
    expect(coderLoginMode()).toBe("legacy");
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
    vi.stubEnv("HIVE_CODER_OAUTH_CLIENT_SECRET", "");
    expect(coderLoginMode()).toBe("oauth-unavailable");
  });
  it("retains legacy mode only while the feature is disabled", () => {
    expect(coderLoginMode({})).toBe("legacy");
    expect(coderLoginMode({ ...configured, HIVE_CODER_OAUTH_ENABLED: "false" })).toBe("legacy");
  });
  it("returns only a readiness enum and never a confidential config object", () => {
    expect(coderLoginMode(configured)).toBe("oauth");
    expect(JSON.stringify(coderLoginMode(configured))).not.toContain(
      configured.HIVE_CODER_OAUTH_CLIENT_SECRET,
    );
  });
  it("fails closed in enabled mode rather than falling back to password collection", () => {
    for (const bad of [
      { ...configured, HIVE_CODER_OAUTH_CLIENT_SECRET: "" },
      { ...configured, HIVE_PUBLIC_ORIGIN: "https://hive.example/arbitrary" },
      { ...configured, CODER_URL: "http://coder.kethalia.com" },
    ])
      expect(coderLoginMode(bad)).toBe("oauth-unavailable");
  });
  it("projects only the registered start URL, independent of a deployment-specific browser address", () => {
    expect(coderLoginStartUrl(configured)).toBe("https://hive.example/api/auth/coder/start");
    const serialized = JSON.stringify(coderLoginStartUrl(configured));
    expect(serialized).not.toContain(configured.HIVE_CODER_OAUTH_CLIENT_SECRET);
    expect(serialized).not.toContain(configured.HIVE_CODER_OAUTH_CLIENT_ID);
    for (const bad of [
      {},
      { ...configured, HIVE_CODER_OAUTH_CLIENT_SECRET: "" },
      { ...configured, HIVE_PUBLIC_ORIGIN: "https://foreign.example/path" },
    ])
      expect(coderLoginStartUrl(bad)).toBeNull();
  });
  it("recognizes only the backend's fixed sanitized failure label", () => {
    expect(coderLoginError({ error: "coder_oauth_failed" })).toBe("failed");
    for (const search of [
      { error: "<script>private</script>" },
      { error: ["coder_oauth_failed"] },
      { code: "private-code", state: "private-state" },
    ])
      expect(coderLoginError(search)).toBeNull();
  });
});
