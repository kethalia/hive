import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWorkspaceAppIsolated } from "@/lib/security/workspace-app-isolation";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "hive.example.com" })),
}));

import { headers } from "next/headers";
import {
  getIsolatedWorkspaceAppAuthRedirect,
  getWorkspaceAppIsolationContext,
} from "@/lib/workspaces/app-access";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("workspace app isolation", () => {
  it.each([
    "https://hive.example.com/tool",
    "https://hive.example.com:8443/tool",
    "https://HIVE.EXAMPLE.COM./tool",
    "https://apps.hive.example.com/tool",
    "https://nested.apps.hive.example.com/tool",
    "javascript:alert(1)",
    "data:text/html,script",
    "/api/workspace-proxy/workspace/filebrowser",
    "https://user:password@apps.example.net",
  ])("rejects active content within cookie scope and unsafe URL forms", (url) => {
    expect(() =>
      assertWorkspaceAppIsolated(url, "hive.example.com", [".hive.example.com"]),
    ).toThrow();
  });

  it.each([
    "https://filebrowser--main--dev--alice.apps.example.net/files/",
    "https://hive.example.com.evil.test/tool",
  ])("accepts separate app hosts with exact domain-boundary comparisons", (url) =>
    expect(
      assertWorkspaceAppIsolated(url, "hive.example.com", [".hive.example.com"]).toString(),
    ).toBe(url));

  it("requires a different hostname for local apps even when cookies are host-only", () => {
    expect(() => assertWorkspaceAppIsolated("http://localhost:7080", "localhost")).toThrow();
    expect(assertWorkspaceAppIsolated("http://127.0.0.1:7080", "localhost").hostname).toBe(
      "127.0.0.1",
    );
  });

  it("checks public deployment authority and legacy cookie domains before requesting app authentication", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://pr-42.hive.example.com");
    vi.stubEnv("COOKIE_DOMAIN", "");
    const context = await getWorkspaceAppIsolationContext();
    const client = { getApplicationAuthRedirect: vi.fn() };
    await expect(
      getIsolatedWorkspaceAppAuthRedirect(client, "https://app.hive.example.com", context),
    ).rejects.toThrow("cookie scope");
    expect(client.getApplicationAuthRedirect).not.toHaveBeenCalled();
  });

  it("uses request authority when a public origin is not configured", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "");
    vi.stubEnv("COOKIE_DOMAIN", ".hive.example.com");
    expect(await getWorkspaceAppIsolationContext()).toEqual({
      hiveHostname: "hive.example.com",
      hiveHostnames: ["hive.example.com"],
      cookieDomains: [".hive.example.com"],
    });
  });

  it("fails closed when request authority is unavailable", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "");
    vi.mocked(headers).mockResolvedValueOnce(new Headers() as never);
    await expect(getWorkspaceAppIsolationContext()).rejects.toThrow("Hive host is unavailable");
  });

  it("also protects the incoming host when a configured public origin differs", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://configured.example.net");
    vi.stubEnv("COOKIE_DOMAIN", "");
    const context = await getWorkspaceAppIsolationContext();
    const client = { getApplicationAuthRedirect: vi.fn() };
    await expect(
      getIsolatedWorkspaceAppAuthRedirect(client, "https://app.hive.example.com", context),
    ).rejects.toThrow("cookie scope");
    await expect(
      getIsolatedWorkspaceAppAuthRedirect(client, "https://hive.example.com:8443", context),
    ).rejects.toThrow("cookie scope");
    expect(client.getApplicationAuthRedirect).not.toHaveBeenCalled();
  });

  it.each([
    "https://hive.example.com",
    "https://another-app.example.net",
    "javascript:alert(1)",
  ])("rejects an authentication redirect that changes the app origin", async (redirect) => {
    const client = { getApplicationAuthRedirect: vi.fn(async () => redirect) };
    await expect(
      getIsolatedWorkspaceAppAuthRedirect(client, "https://app.example.net", {
        hiveHostname: "hive.example.com",
        cookieDomains: [],
      }),
    ).rejects.toThrow();
  });

  it("preserves Coder app authentication grants on the authorized app origin", async () => {
    const target = "https://app.example.net/files/project";
    const grant = `${target}?coder_application_connect_api_key=encrypted-grant`;
    const client = { getApplicationAuthRedirect: vi.fn(async () => grant) };
    expect(
      await getIsolatedWorkspaceAppAuthRedirect(client, target, {
        hiveHostname: "hive.example.com",
        cookieDomains: [],
      }),
    ).toBe(grant);
    expect(client.getApplicationAuthRedirect).toHaveBeenCalledWith(target);
  });
});
