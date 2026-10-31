import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ query: vi.fn(), session: vi.fn() }));
vi.mock("@hive/db", () => ({
  getDb: () => ({ $transaction: mock.query, user: { findUnique: mock.query } }),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.session }));

import { POST as register } from "@/app/api/codex-host/registrations/route";
import { isHostCallbackTransport } from "../../../../deploy/cloudflare/app/host-callback";

afterEach(() => vi.unstubAllEnvs());
describe("callback transport preserves actual native registration cryptographic authority", () => {
  it("rejects a well-formed grant signed by another issuer without session fallback or database queries", async () => {
    const issuer = generateKeyPairSync("ed25519"),
      forged = generateKeyPairSync("ed25519");
    const origin = "https://preview.example";
    for (const [name, value] of Object.entries({
      HIVE_CODEX_GATEWAY_ENABLED: "true",
      HIVE_CODEX_ISSUER_PRIVATE_KEY: issuer.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      HIVE_CODEX_ISSUER_KEY_ID: "issuer",
      HIVE_CODEX_HIVE_ORIGIN: origin,
      HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: "software",
      HIVE_CODEX_APP_SLUG: "codex-session",
      HIVE_CODEX_GATEWAY_PORT: "13341",
    }))
      vi.stubEnv(name, value);
    const header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "issuer" }),
      ).toString("base64url"),
      payload = Buffer.from("{}").toString("base64url");
    const grant = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), forged.privateKey).toString("base64url")}`;
    const request = new Request(`${origin}/api/codex-host/registrations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer preview-authority-is-not-native-authority",
        Cookie: "__Host-hive-session=irrelevant-browser-session",
      },
      body: JSON.stringify({
        grant,
        serverInstanceId: "instance",
        protocolVersion: "0.165.0",
        threads: [],
        hostPublicKeyPem: forged.publicKey.export({ type: "spki", format: "pem" }).toString(),
        proof: "a".repeat(86),
      }),
    });
    expect(isHostCallbackTransport(request, "true")).toBe(true);
    expect((await register(request)).status).toBe(403);
    expect(mock.session).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
  });
});
