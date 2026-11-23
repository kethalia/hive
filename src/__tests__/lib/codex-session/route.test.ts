import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getRequestSession: vi.fn() }));

import { POST as register } from "@/app/api/codex-host/registrations/route";
import { POST as readGrant } from "@/app/api/projects/[projectId]/session-grant/route";
import { getRequestSession } from "@/lib/auth/session";
import { authorizeSessionOwner, boundedSessionJson } from "@/lib/codex-session/route.server";

afterEach(() => vi.unstubAllEnvs());
describe("registration HTTP boundary", () => {
  it("keeps registration and read routes disabled by default", async () => {
    vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "false");
    expect(
      (
        await register(
          new Request("https://hive.example/api/codex-host/registrations", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await readGrant(
          new Request("https://hive.example/api/projects/p/session-grant", { method: "POST" }),
          { params: Promise.resolve({ projectId: "p" }) },
        )
      ).status,
    ).toBe(404);
  });
  it("rejects missing or cross-site origin before session access", async () => {
    vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "true");
    for (const [key, value] of Object.entries({
      HIVE_CODEX_ISSUER_PRIVATE_KEY: "configured",
      HIVE_CODEX_ISSUER_KEY_ID: "issuer",
      HIVE_CODEX_HIVE_ORIGIN: "https://hive.example",
      HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: "template",
      HIVE_CODEX_APP_SLUG: "app",
      HIVE_CODEX_GATEWAY_PORT: "13341",
    }))
      vi.stubEnv(key, value);
    vi.mocked(getRequestSession).mockClear();
    const result = await authorizeSessionOwner(
      new Request("https://hive.example/api/projects/p/session-grant", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(getRequestSession).not.toHaveBeenCalled();
  });
  it("bounds declared and streaming body bytes and rejects compression/non-JSON", async () => {
    const request = (body: string, headers: Record<string, string> = {}) =>
      new Request("https://hive.example", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });
    await expect(boundedSessionJson(request('{"ok":true}'))).resolves.toEqual({ ok: true });
    await expect(boundedSessionJson(request("x".repeat(101)), 100)).rejects.toThrow();
    await expect(
      boundedSessionJson(request("{}", { "Content-Length": "999999" })),
    ).rejects.toThrow();
    await expect(
      boundedSessionJson(request("{}", { "Content-Encoding": "gzip" })),
    ).rejects.toThrow();
    await expect(
      boundedSessionJson(request("{}", { "Content-Type": "text/plain" })),
    ).rejects.toThrow();
  });
});
