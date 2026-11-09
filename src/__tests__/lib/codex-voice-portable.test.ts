import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/codex-session/bootstrap-delivery.server", () => ({
  exchangeVerifiedWorkspaceVoiceCookie: async (
    _coder: unknown,
    binding: { appOrigin: string },
    path: string,
  ) => ({ cookie: "app=scoped", url: binding.appOrigin + path }),
}));

import { openPortableVoiceClient } from "@/lib/codex/voice-portable-client.server";

const keys = generateKeyPairSync("ed25519"),
  hostKeys = generateKeyPairSync("ed25519");
const config = {
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  keyId: "test",
  issuer: "https://hive.example",
  manifestSha256: "a".repeat(64),
  lockDirectory: "/home/coder/.local/state/hive/voice/locks",
};
const binding = {
  coderOrigin: "https://coder.example",
  hiveUserId: randomUUID(),
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  agentId: randomUUID(),
  templateId: randomUUID(),
  appOrigin: "https://voice.example",
  appId: randomUUID(),
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = hash(
  JSON.stringify({
    schemaVersion: 1,
    issuer: config.issuer,
    audience: binding.appOrigin,
    issuerKeyId: config.keyId,
    issuerKeySha256: hash(keys.publicKey.export({ type: "spki", format: "der" })),
    workspaceId: binding.workspaceId,
    buildId: binding.buildId,
    agentId: binding.agentId,
    lockDirectory: config.lockDirectory,
    manifestSha256: config.manifestSha256,
  }),
);
class Socket extends EventTarget {
  readyState = 1;
  accept() {}
  send(value: string) {
    const request = JSON.parse(value);
    if (request.id)
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify({ id: request.id, result: {} }) }),
        ),
      );
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
function fixture(tamper = false) {
  const socket = new Socket(),
    claims: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string>).Authorization;
    const value = JSON.parse(Buffer.from(header.slice(7).split(".")[1], "base64url").toString());
    claims.push(value);
    if (value.scope === "voice:identity:v1") {
      const body = {
        requestId: value.jti,
        lifetimeId: randomUUID(),
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
        agentId: binding.agentId,
        manifestSha256: tamper ? "b".repeat(64) : config.manifestSha256,
        configDigest: digest,
        publicKeyPem: hostKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
      return Response.json({
        ...body,
        proof: sign(
          null,
          Buffer.from(`hive-voice-identity-v1\n${JSON.stringify(body)}`),
          hostKeys.privateKey,
        ).toString("base64url"),
      });
    }
    return { status: 101, redirected: false, webSocket: socket } as unknown as Response;
  });
  return { fetcher, claims, socket };
}
describe("portable voice client", () => {
  it("verifies host identity before issuing a lifetime and thread bound connection", async () => {
    const f = fixture(),
      threadId = randomUUID();
    const rpc = await openPortableVoiceClient(
      config,
      {} as never,
      binding,
      threadId,
      new AbortController().signal,
      f.fetcher as typeof fetch,
    );
    expect(f.claims).toHaveLength(2);
    expect(f.claims[1]).toMatchObject({
      scope: "voice:connect:v1",
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      agentId: binding.agentId,
      threadId,
      lifetimeId: expect.any(String),
    });
    expect(f.claims[1].lifetimeId).not.toBe(f.claims[0].lifetimeId);
    rpc.close();
    expect(f.socket.readyState).toBe(3);
  });
  it("rejects a mismatched package pin before opening a socket", async () => {
    const f = fixture(true);
    await expect(
      openPortableVoiceClient(
        config,
        {} as never,
        binding,
        undefined,
        new AbortController().signal,
        f.fetcher as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(f.claims).toHaveLength(1);
  });
});
