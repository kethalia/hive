import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfiguredCoderUrl, isConfiguredCoderUrl } from "./coder-origin";

afterEach(() => vi.unstubAllEnvs());

describe("server-owned Coder origin", () => {
  it("normalizes the configured origin and legacy trailing slash bindings", () => {
    vi.stubEnv("CODER_URL", "https://CODER.example.com:443/");
    expect(getConfiguredCoderUrl()).toBe("https://coder.example.com");
    expect(isConfiguredCoderUrl("https://coder.example.com/")).toBe(true);
    expect(isConfiguredCoderUrl("https://other.example.com")).toBe(false);
    expect(isConfiguredCoderUrl("https://coder.example.com:8443")).toBe(false);
    expect(isConfiguredCoderUrl("http://coder.example.com")).toBe(false);
  });

  it.each([
    "",
    "not a URL",
    "file:///tmp/coder",
    "https://secret@coder.example.com",
    "https://coder.example.com/path",
    "https://coder.example.com/?target=other",
    "https://coder.example.com/#other",
  ])("rejects invalid configuration without revealing its value", (value) => {
    vi.stubEnv("CODER_URL", value);
    expect(() => getConfiguredCoderUrl()).toThrow(/CODER_URL/);
    expect(isConfiguredCoderUrl("https://coder.example.com")).toBe(false);
  });

  it("requires HTTPS in production and supports configured development origins", () => {
    vi.stubEnv("CODER_URL", "http://localhost:7080");
    vi.stubEnv("NODE_ENV", "development");
    expect(getConfiguredCoderUrl()).toBe("http://localhost:7080");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getConfiguredCoderUrl()).toThrow(/HTTPS/);
  });

  it("does not use inherited agent URL or retired allowlist as configuration", () => {
    vi.stubEnv("CODER_URL", "");
    vi.stubEnv("CODER_AGENT_URL", "https://other.example.com");
    vi.stubEnv("ALLOWED_CODER_URLS", "https://other.example.com");
    expect(() => getConfiguredCoderUrl()).toThrow("CODER_URL is not configured");
  });
});
