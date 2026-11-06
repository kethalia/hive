import { TOKEN_LIFETIME_SECONDS } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coderKeyId, createManagedCoderKey, deleteManagedCoderKey } from "./managed-keys";

const token = `abcdefghij-${"k".repeat(22)}`;
const caller = `1234567890-${"z".repeat(22)}`;
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("CODER_CA_CERT", "");
  network = vi.fn();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function minted(overrides: Record<string, unknown> = {}) {
  network.mockResolvedValueOnce(Response.json({ key: token }));
  network.mockImplementationOnce(() => {
    const request = network.mock.calls[0][1];
    return Promise.resolve(
      Response.json({
        id: "abcdefghij",
        user_id: "owner",
        token_name: JSON.parse(request.body).token_name,
        login_type: "token",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        ...overrides,
      }),
    );
  });
}

describe("managed Coder key provenance", () => {
  it("uses named token duration nanoseconds and verifies returned identity, user and expiry", async () => {
    minted();
    const key = await createManagedCoderKey("https://coder.example.com/", caller, "owner");
    expect(key?.id).toBe("abcdefghij");
    expect(key?.token).toBe(token);
    expect(key?.expiresAt).toBeInstanceOf(Date);
    const [url, init] = network.mock.calls[0];
    expect(url).toBe("https://coder.example.com/api/v2/users/owner/keys/tokens");
    expect(JSON.parse(init.body)).toEqual({
      token_name: expect.stringMatching(/^hive-[0-9a-f-]{36}$/),
      lifetime: TOKEN_LIFETIME_SECONDS * 1_000_000_000,
    });
    expect(network.mock.calls[1][0]).toBe(
      "https://coder.example.com/api/v2/users/owner/keys/abcdefghij",
    );
    expect(network.mock.calls[1][1].headers["Coder-Session-Token"]).toBe(token);
    expect(init.redirect).toBe("manual");
  });

  it.each([
    { id: "unrelated1" },
    { user_id: "other-user" },
    { token_name: "unrelated-key" },
    { login_type: "password" },
    { expires_at: "invalid" },
    { expires_at: new Date(0).toISOString() },
    { expires_at: new Date(Date.now() + 366 * 86400000).toISOString() },
  ])("rejects unverified metadata without deleting any key: %j", async (overrides) => {
    minted(overrides);
    expect(await createManagedCoderKey("https://coder.example.com", caller, "owner")).toBeNull();
    expect(network.mock.calls.every(([, init]) => init.method !== "DELETE")).toBe(true);
  });

  it("rejects malformed returned tokens and redirects before forwarding secrets", async () => {
    network.mockResolvedValueOnce(Response.json({ key: "unrecognized-token" }));
    expect(await createManagedCoderKey("https://coder.example.com", caller, "owner")).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
    network.mockResolvedValueOnce(
      new Response("redirect body", {
        status: 302,
        headers: { Location: "https://attacker.example" },
      }),
    );
    expect(await createManagedCoderKey("https://coder.example.com", caller, "owner")).toBeNull();
    expect(network).toHaveBeenCalledTimes(2);
    expect(coderKeyId("abcdefghij-short")).toBeNull();
  });

  it("deletes only the exact tracked ID and treats already absent keys as cleaned", async () => {
    network.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(
      await deleteManagedCoderKey("https://coder.example.com", token, "owner", "abcdefghij"),
    ).toBe(true);
    expect(network.mock.calls[0][0]).toBe(
      "https://coder.example.com/api/v2/users/owner/keys/abcdefghij",
    );
    expect(network.mock.calls[0][1].method).toBe("DELETE");
    expect(
      await deleteManagedCoderKey("https://coder.example.com", token, "owner", "../escape"),
    ).toBe(false);
    expect(network).toHaveBeenCalledTimes(1);
  });
});
