import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthServiceClient } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("auth service portable redirect boundary", () => {
  const operations = [
    (client: AuthServiceClient) =>
      client.login({ email: "test@example.invalid", password: "private" }),
    (client: AuthServiceClient) => client.logout("session"),
    (client: AuthServiceClient) => client.getSession("session"),
    (client: AuthServiceClient) => client.getCredentials("session"),
    (client: AuthServiceClient) => client.getCoderToken("session"),
  ];

  it.each([
    301, 302, 303, 307, 308,
  ])("rejects status %s before reading the redirect body", async (status) => {
    vi.stubEnv("AUTH_SERVICE_SECRET", "a".repeat(64));
    const response = new Response("redirect body must not be used", {
      status,
      headers: { Location: "https://other.invalid/?credential=private" },
    });
    const body = vi.spyOn(response, "json");
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetch = vi.fn(async (_url, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    for (const operation of operations)
      await expect(operation(new AuthServiceClient("https://auth.invalid"))).rejects.toThrow(
        "Auth service redirects are not allowed",
      );
    expect(fetch).toHaveBeenCalledTimes(operations.length);
    expect(body).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(operations.length);
  });

  it("preserves authenticated JSON requests and 404 absence", async () => {
    vi.stubEnv("AUTH_SERVICE_SECRET", "a".repeat(64));
    const fetch = vi.fn(async (_url, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${"a".repeat(64)}`);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ error: "missing" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const client = new AuthServiceClient("https://auth.invalid/");
    expect(await client.getSession("session")).toBeNull();
    expect(await client.getCredentials("session")).toBeNull();
    expect(await client.getCoderToken("session")).toBeNull();
  });
});
