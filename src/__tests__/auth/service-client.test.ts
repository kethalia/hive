import { afterEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => vi.fn());
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: context }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  context.mockReset();
});

describe("auth service runtime transport", () => {
  it("keeps the Node URL singleton and never resolves a Cloudflare binding", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "node");
    vi.stubEnv("AUTH_SERVICE_URL", "http://legacy-auth:4400");
    vi.stubEnv("AUTH_SERVICE_SECRET", "a".repeat(64));
    const network = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", network);
    const { getAuthServiceClient } = await import("@/lib/auth/service-client");
    expect(getAuthServiceClient()).toBe(getAuthServiceClient());
    await expect(getAuthServiceClient().getSession("session")).resolves.toBeNull();
    expect(network).toHaveBeenCalledWith(
      "http://legacy-auth:4400/sessions/session",
      expect.anything(),
    );
    expect(context).not.toHaveBeenCalled();
  });

  it("binds each Worker request to its own service and secret without network fallback", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    vi.stubEnv("AUTH_SERVICE_URL", "http://must-not-be-used:4400");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const first = { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) };
    const second = { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) };
    context
      .mockReturnValueOnce({ env: { AUTH_SERVICE: first, AUTH_SERVICE_SECRET: "a".repeat(64) } })
      .mockReturnValueOnce({ env: { AUTH_SERVICE: second, AUTH_SERVICE_SECRET: "b".repeat(64) } });
    const { getAuthServiceClient } = await import("@/lib/auth/service-client");
    const clientA = getAuthServiceClient();
    const clientB = getAuthServiceClient();
    await clientB.getSession("second");
    await clientA.getSession("first");
    expect(first.fetch).toHaveBeenCalledWith(
      "https://hive-auth.internal/sessions/first",
      expect.objectContaining({ headers: { Authorization: `Bearer ${"a".repeat(64)}` } }),
    );
    expect(second.fetch).toHaveBeenCalledWith(
      "https://hive-auth.internal/sessions/second",
      expect.objectContaining({ headers: { Authorization: `Bearer ${"b".repeat(64)}` } }),
    );
    expect(first.fetch.mock.instances[0]).toBe(first);
    expect(second.fetch.mock.instances[0]).toBe(second);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { AUTH_SERVICE: { fetch: vi.fn() } },
    { AUTH_SERVICE: { fetch: vi.fn() }, AUTH_SERVICE_SECRET: "invalid" },
  ])("rejects incomplete Worker authority instead of using an origin URL: %j", async (env) => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    context.mockReturnValue({ env });
    const { getAuthServiceClient } = await import("@/lib/auth/service-client");
    expect(() => getAuthServiceClient()).toThrow();
  });
});
