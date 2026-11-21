import type { PrismaClient } from "@hive/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoderOAuthConfig } from "../../../services/auth/src/auth/coder-oauth-config";
import { registerCoderPreviewCallback } from "../../../services/auth/src/auth/coder-preview-callback";

const publicOrigin = "https://codex-projects-p05.hive-preview.kethalia.com";
const callbackUrl = `${publicOrigin}/api/auth/callback/coder`;
const config: CoderOAuthConfig = {
  publicOrigin,
  callbackUrl,
  coderOrigin: "https://coder.kethalia.com",
  clientId: "preview-client",
  clientSecret: "test",
  secret: "test",
};
const oldCallback = "https://older-branch.hive-preview.kethalia.com/api/auth/callback/coder";
const signal = new AbortController().signal;

function fixture(redirects: string[]) {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        client_id: config.clientId,
        client_name: "Hive Worker Previews",
        redirect_uris: redirects,
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const lock = vi.fn();
  const db = {
    $transaction: (work: (tx: { $executeRaw: typeof lock }) => Promise<void>) =>
      work({ $executeRaw: lock }),
  } as unknown as PrismaClient;
  return { db, fetch, lock };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Coder OAuth callback registration for native Previews", () => {
  it("adds a new exact callback and preserves other preview callbacks", async () => {
    vi.stubEnv("HIVE_NATIVE_MODE", "preview");
    vi.stubEnv("HIVE_PREVIEW_CODER_REGISTRATION_TOKEN", "preview-registration-token");
    const { db, fetch, lock } = fixture([oldCallback]);
    await registerCoderPreviewCallback(config, db, signal);
    expect(lock).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [endpoint, update] = fetch.mock.calls[1];
    expect(endpoint).toBe("https://coder.kethalia.com/oauth2/clients/preview-client");
    expect(update.method).toBe("PUT");
    expect(JSON.parse(update.body).redirect_uris).toEqual([callbackUrl, oldCallback]);
  });

  it("leaves production and already registered callbacks alone", async () => {
    const { db, fetch } = fixture([callbackUrl]);
    vi.stubEnv("HIVE_NATIVE_MODE", "production");
    await registerCoderPreviewCallback(config, db, signal);
    expect(fetch).not.toHaveBeenCalled();

    vi.stubEnv("HIVE_NATIVE_MODE", "preview");
    vi.stubEnv("HIVE_PREVIEW_CODER_REGISTRATION_TOKEN", "preview-registration-token");
    await registerCoderPreviewCallback(config, db, signal);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the latest callback within Coder's registration limit", async () => {
    vi.stubEnv("HIVE_NATIVE_MODE", "preview");
    vi.stubEnv("HIVE_PREVIEW_CODER_REGISTRATION_TOKEN", "preview-registration-token");
    const callbacks = Array.from(
      { length: 32 },
      (_, index) => `https://branch-${index}.hive-preview.kethalia.com/api/auth/callback/coder`,
    );
    const { db, fetch } = fixture(callbacks);
    await registerCoderPreviewCallback(config, db, signal);
    const redirects = JSON.parse(fetch.mock.calls[1][1].body).redirect_uris;
    expect(redirects).toEqual([callbackUrl, ...callbacks.slice(0, 31)]);
  });

  it("rejects an origin outside the Cloudflare preview domain before calling Coder", async () => {
    vi.stubEnv("HIVE_NATIVE_MODE", "preview");
    vi.stubEnv("HIVE_PREVIEW_CODER_REGISTRATION_TOKEN", "preview-registration-token");
    const { db, fetch } = fixture([oldCallback]);
    await expect(
      registerCoderPreviewCallback(
        { ...config, callbackUrl: "https://hive.kethalia.com/api/auth/callback/coder" },
        db,
        signal,
      ),
    ).rejects.toThrow("coder_preview_callback_configuration");
    expect(fetch).not.toHaveBeenCalled();
  });
});
