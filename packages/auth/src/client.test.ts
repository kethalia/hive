import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthServiceClient, AuthServiceError } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("auth service portable redirect boundary", () => {
  const operations = [
    (client: AuthServiceClient) =>
      client.login({
        coderUrl: "https://coder.example.invalid",
        email: "test@example.invalid",
        password: "private",
      }),
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

  it("carries the explicit trusted client address only on its authenticated login request", async () => {
    const send = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("X-Hive-Client-IP")).toBe("203.0.113.7");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${"a".repeat(64)}`);
      return Response.json({ sessionId: "session", applicationsHost: "", user: {} });
    });
    const client = new AuthServiceClient("https://auth.internal", undefined, {
      serviceSecret: "a".repeat(64),
      fetch: send,
    });
    await client.login(
      { coderUrl: "https://coder.example.com", email: "fixture@example.com", password: "fixture" },
      "203.0.113.7",
    );
    expect(send).toHaveBeenCalledOnce();
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

describe("per-operation login deadline", () => {
  const input = {
    coderUrl: "https://coder.example.com",
    email: "fixture@example.com",
    password: "fixture",
  };
  const result = { sessionId: "session", applicationsHost: "" };
  function delayedTransport(delay: number): typeof fetch {
    return vi.fn(
      async (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(Response.json(result)), delay);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
  }

  it("admits slow login under its configured budget while keeping session reads short", async () => {
    const client = new AuthServiceClient("https://auth.internal", 10, {
      fetch: delayedTransport(30),
      serviceSecret: "a".repeat(64),
      loginTimeoutMs: 100,
    });
    await expect(client.login(input)).resolves.toEqual(result);
    await expect(client.getSession("session")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("retains an explicit short constructor deadline when no login override is supplied", async () => {
    const client = new AuthServiceClient("https://auth.internal", 10, {
      fetch: delayedTransport(30),
      serviceSecret: "a".repeat(64),
    });
    await expect(client.login(input)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("caller cancellation caps the longer login budget", async () => {
    const caller = new AbortController();
    const client = new AuthServiceClient("https://auth.internal", 10, {
      fetch: delayedTransport(50),
      serviceSecret: "a".repeat(64),
      loginTimeoutMs: 100,
    });
    const pending = client.login(input, undefined, caller.signal);
    caller.abort(new DOMException("Caller canceled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    200, 401,
  ])("cancels a stalled response body under the same login deadline at status %s", async (status) => {
    const cancel = vi.fn();
    const client = new AuthServiceClient("https://auth.internal", 10, {
      fetch: async () => new Response(new ReadableStream({ cancel }), { status }),
      serviceSecret: "a".repeat(64),
      loginTimeoutMs: 20,
    });
    const pending = client.login(input);
    // Keep the local event loop alive while AbortSignal.timeout uses an unref'd timer.
    const alive = setTimeout(() => {}, 100);
    try {
      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(alive);
    }
  });

  it("keeps credential rejection distinct from a transport deadline", async () => {
    const client = new AuthServiceClient("https://auth.internal", 10, {
      fetch: async () => Response.json({ error: "Invalid credentials" }, { status: 401 }),
      serviceSecret: "a".repeat(64),
      loginTimeoutMs: 100,
    });
    await expect(client.login(input)).rejects.toThrow("Invalid credentials");
  });
});

describe("login service failure status", () => {
  it.each([
    401, 429, 500, 502, 503, 504,
  ])("preserves upstream status %s and its finite message", async (status) => {
    const client = new AuthServiceClient("https://auth.internal", undefined, {
      serviceSecret: "a".repeat(64),
      fetch: async () => Response.json({ error: "Service rejected login" }, { status }),
    });
    const error = await client
      .login({
        coderUrl: "https://coder.example.com",
        email: "fixture@example.com",
        password: "fixture",
      })
      .catch((failure) => failure);
    expect(error).toBeInstanceOf(AuthServiceError);
    expect(error).toMatchObject({ status, message: "Service rejected login" });
  });

  it("preserves service failure status even when its body is not JSON", async () => {
    const client = new AuthServiceClient("https://auth.internal", undefined, {
      serviceSecret: "a".repeat(64),
      fetch: async () => new Response("unavailable", { status: 502 }),
    });
    await expect(
      client.login({
        coderUrl: "https://coder.example.com",
        email: "fixture@example.com",
        password: "fixture",
      }),
    ).rejects.toMatchObject({ status: 502, message: "Login failed with status 502" });
  });
});
