import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCoderCliEnvironment } from "@/lib/coder/cli-auth.server";

afterEach(() => vi.unstubAllEnvs());
describe("Coder CLI credential isolation", () => {
  it("uses a private temporary config and Bearer header without inherited session auth", async () => {
    vi.stubEnv("CODER_SESSION_TOKEN", "owner-key");
    vi.stubEnv("CODER_CONFIG_DIR", "/owner/config");
    vi.stubEnv("CODER_HEADER", "inherited-header");
    vi.stubEnv("CODER_HEADER_COMMAND", "inherited-command");
    const prepared = await prepareCoderCliEnvironment({
      coderUrl: "https://coder.example.com",
      token: "oauth-access",
      credentialSource: "oauth",
    });
    try {
      expect(prepared.env.CODER_URL).toBe("https://coder.example.com");
      expect(prepared.env.CODER_HEADER).toBe("Authorization=Bearer oauth-access");
      expect(prepared.env.CODER_SESSION_TOKEN).toBeUndefined();
      expect(prepared.env.CODER_HEADER_COMMAND).toBeUndefined();
      expect(prepared.env.CODER_CONFIG_DIR).not.toBe("/owner/config");
      expect((await stat(prepared.env.CODER_CONFIG_DIR!)).mode & 0o777).toBe(0o700);
      expect(process.env.CODER_SESSION_TOKEN).toBe("owner-key");
    } finally {
      await prepared.cleanup();
    }
    await expect(stat(prepared.env.CODER_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
    await prepared.cleanup();
  });
  it("preserves legacy CLI environment and explicit key", async () => {
    vi.stubEnv("CODER_CONFIG_DIR", "/owner/config");
    const prepared = await prepareCoderCliEnvironment({ token: "legacy-key" });
    expect(prepared.env.CODER_SESSION_TOKEN).toBe("legacy-key");
    expect(prepared.env.CODER_CONFIG_DIR).toBe("/owner/config");
    await prepared.cleanup();
  });
  it("requires explicit OAuth origin and credential", async () => {
    await expect(prepareCoderCliEnvironment({ credentialSource: "oauth" })).rejects.toThrow(
      "credentials required",
    );
  });
});
