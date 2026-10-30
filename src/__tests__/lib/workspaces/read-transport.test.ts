import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestVerifiedWorkspaceRead } from "@/lib/codex-session/bootstrap-delivery.server";

const binding = {
  coderOrigin: "https://coder.invalid",
  appOrigin: "https://hive-read--main--fixture--owner.apps.invalid",
};
const cookieName = `coder_subdomain_app_session_token_${createHash("sha256").update("*.apps.invalid").digest("hex").slice(0, 32)}`;
function fixture(response: () => Response = () => Response.json({ readOnly: true })) {
  const coder = {
      getBaseUrl: () => binding.coderOrigin,
      getApplicationsHost: vi.fn(async () => "*.apps.invalid"),
      getApplicationAuthRedirect: vi.fn(
        async (target: string) =>
          `${target}?coder_application_connect_api_key_35e783=fixture-app-only`,
      ),
    },
    fetchApp = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === "GET"
        ? new Response(null, {
            status: 303,
            headers: {
              Location: `${binding.appOrigin}/workspace/read`,
              "Set-Cookie": `${cookieName}=fixture-app-cookie; HttpOnly; Secure; Path=/`,
            },
          })
        : response(),
    );
  return { coder, fetchApp };
}
afterEach(() => vi.useRealTimers());
describe("fixed workspace read app transport", () => {
  it("exchanges only the canonical app-scoped cookie and posts to the fixed path", async () => {
    const f = fixture(),
      expiresAt = Math.floor(Date.now() / 1000) + 30;
    expect(
      await requestVerifiedWorkspaceRead(
        f.coder,
        binding,
        { ticket: "fixture-signed-ticket", expiresAt },
        f.fetchApp,
      ),
    ).toEqual({ readOnly: true });
    expect(f.coder.getApplicationAuthRedirect).toHaveBeenCalledWith(
      `${binding.appOrigin}/workspace/read`,
    );
    expect(f.fetchApp).toHaveBeenCalledTimes(2);
    const [target, init] = f.fetchApp.mock.calls[1];
    expect(target).toBe(`${binding.appOrigin}/workspace/read`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Cookie: `${cookieName}=fixture-app-cookie` },
      body: JSON.stringify({ ticket: "fixture-signed-ticket" }),
    });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });
  it("rejects a redirect rather than sending a signed request to another origin", async () => {
    const f = fixture(
      () => new Response(null, { status: 307, headers: { Location: "https://foreign.invalid" } }),
    );
    await expect(
      requestVerifiedWorkspaceRead(
        f.coder,
        binding,
        { ticket: "fixture", expiresAt: Math.floor(Date.now() / 1000) + 30 },
        f.fetchApp,
      ),
    ).rejects.toThrow();
    expect(f.fetchApp).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized input before contacting Coder and bounds oversized/zero-chunk replies", async () => {
    const f = fixture();
    await expect(
      requestVerifiedWorkspaceRead(
        f.coder,
        binding,
        { ticket: "x".repeat(786433), expiresAt: Math.floor(Date.now() / 1000) + 30 },
        f.fetchApp,
      ),
    ).rejects.toThrow();
    expect(f.coder.getApplicationAuthRedirect).not.toHaveBeenCalled();
    for (const large of [true, false]) {
      const next = fixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                c.enqueue(new Uint8Array(large ? 131073 : 0));
              },
            }),
          ),
      );
      await expect(
        requestVerifiedWorkspaceRead(
          next.coder,
          binding,
          { ticket: "fixture", expiresAt: Math.floor(Date.now() / 1000) + 30 },
          next.fetchApp,
        ),
      ).rejects.toThrow();
    }
  });
  it("aborts a stalled stream within a bounded cancel window even if cancel never settles", async () => {
    vi.useFakeTimers();
    const abort = new AbortController(),
      f = fixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                return new Promise(() => {});
              },
            }),
          ),
      );
    const pending = requestVerifiedWorkspaceRead(
      f.coder,
      binding,
      { ticket: "fixture", expiresAt: Math.floor(Date.now() / 1000) + 30, signal: abort.signal },
      f.fetchApp,
    );
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(f.fetchApp).toHaveBeenCalledTimes(2));
    abort.abort();
    await vi.advanceTimersByTimeAsync(201);
    await rejection;
    expect(f.fetchApp).toHaveBeenCalledTimes(2);
  });
});
