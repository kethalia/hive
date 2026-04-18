import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoderClient } from "../../lib/coder/client";

const BASE_URL = "https://coder.example.com";

describe("CoderClient.validateInstance", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns valid with version for a real Coder instance", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "2.9.0", external_url: BASE_URL }), {
        status: 200,
      })
    );

    const result = await CoderClient.validateInstance(BASE_URL);
    expect(result).toEqual({ valid: true, version: "2.9.0" });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v2/buildinfo`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("returns invalid for non-Coder URL (non-200)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const result = await CoderClient.validateInstance(BASE_URL);
    expect(result).toEqual({ valid: false, reason: "not a Coder instance" });
  });

  it("returns invalid for response without version field", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ some: "other" }), { status: 200 })
    );

    const result = await CoderClient.validateInstance(BASE_URL);
    expect(result).toEqual({ valid: false, reason: "not a Coder instance" });
  });

  it("returns DNS error for ENOTFOUND", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      new Error("getaddrinfo ENOTFOUND coder.example.com")
    );

    const result = await CoderClient.validateInstance(BASE_URL);
    expect(result).toEqual({ valid: false, reason: "DNS resolution failed" });
  });

  it("returns timeout error for AbortError", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));

    const result = await CoderClient.validateInstance(BASE_URL);
    expect(result).toEqual({ valid: false, reason: "connection timeout" });
  });

  it("strips trailing slash from URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "2.9.0" }), { status: 200 })
    );

    await CoderClient.validateInstance(`${BASE_URL}/`);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v2/buildinfo`,
      expect.anything()
    );
  });
});

describe("CoderClient.login", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns session token and user info on success", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session_token: "tok_abc123" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "user-uuid", username: "alice", email: "alice@test.com" }),
          { status: 200 }
        )
      );

    const result = await CoderClient.login(BASE_URL, "alice@test.com", "password123");
    expect(result).toEqual({
      sessionToken: "tok_abc123",
      userId: "user-uuid",
      username: "alice",
    });
  });

  it("throws 'invalid credentials' on 401", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 })
    );

    await expect(
      CoderClient.login(BASE_URL, "bad@test.com", "wrong")
    ).rejects.toThrow("invalid credentials");
  });

  it("throws on other HTTP errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("server error", { status: 500, statusText: "Internal Server Error" })
    );

    await expect(
      CoderClient.login(BASE_URL, "a@b.com", "pw")
    ).rejects.toThrow("login failed: 500");
  });

  it("strips trailing slash from URL", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session_token: "tok" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "u", username: "a", email: "a@b.com" }), { status: 200 })
      );

    await CoderClient.login(`${BASE_URL}/`, "a@b.com", "pw");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${BASE_URL}/api/v2/users/login`);
  });
});

describe("CoderClient.createApiKey", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns key string on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ key: "api-key-xyz" }), { status: 200 })
    );

    const key = await CoderClient.createApiKey(BASE_URL, "session-tok", "user-id");
    expect(key).toBe("api-key-xyz");
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v2/users/user-id/keys`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("returns null on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("forbidden", { status: 403 })
    );

    const key = await CoderClient.createApiKey(BASE_URL, "tok", "uid");
    expect(key).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network failure"));

    const key = await CoderClient.createApiKey(BASE_URL, "tok", "uid");
    expect(key).toBeNull();
  });

  it("passes lifetime_seconds when provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ key: "k" }), { status: 200 })
    );

    await CoderClient.createApiKey(BASE_URL, "tok", "uid", 86400);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body).toEqual({ lifetime_seconds: 86400 });
  });
});
