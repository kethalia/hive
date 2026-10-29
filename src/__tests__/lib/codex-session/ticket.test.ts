import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { issueCodexSessionGrant } from "@/lib/codex-session/ticket.server";
import { startBridge } from "../../../../templates/ai-dev-k8s/scripts/codex-session-bridge.mjs";

const keys = generateKeyPairSync("ed25519");
const config = {
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  keyId: "key-1",
  hiveOrigin: "https://hive.example.com",
  appOrigin: "https://app.example.com",
};
const binding = {
  ownerId: "owner",
  workspaceId: "workspace",
  buildId: "build",
  serverInstanceId: "server",
  threadId: "thread",
};
afterEach(() => vi.useRealTimers());

describe("server-only Codex capability signer", () => {
  it("signs exactly the bridge's EdDSA claims and returns no private key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const grant = issueCodexSessionGrant(config, binding);
    const [header, body, signature] = grant.ticket.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: "JWT",
      kid: "key-1",
    });
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(claims).toEqual({
      iss: config.hiveOrigin,
      aud: config.appOrigin,
      sub: binding.ownerId,
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      serverInstanceId: binding.serverInstanceId,
      threadId: binding.threadId,
      origin: config.hiveOrigin,
      scope: "session:read",
      iat: Math.floor(Date.now() / 1000),
      exp: grant.expiresAt,
      jti: expect.any(String),
    });
    expect(claims.exp - claims.iat).toBe(60);
    expect(
      verify(
        null,
        Buffer.from(`${header}.${body}`),
        keys.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(grant.url).toBe(`${config.appOrigin}/session`);
    expect(JSON.stringify(grant)).not.toContain("PRIVATE KEY");
    expect(issueCodexSessionGrant(config, binding).ticket).not.toBe(grant.ticket);
    expect(
      issueCodexSessionGrant(config, { ...binding, privateKey: "never-copy" } as typeof binding)
        .binding,
    ).toEqual(binding);
  });

  it("rejects invalid lifetime, non-Ed25519 keys, unsafe origins, and malformed bindings", () => {
    for (const ttl of [0, 61, -1, 1.5])
      expect(() => issueCodexSessionGrant(config, binding, ttl)).toThrow();
    for (const hiveOrigin of [
      "http://hive.example.com",
      "https://*.example.com",
      "https://hive.example.com/path",
    ])
      expect(() => issueCodexSessionGrant({ ...config, hiveOrigin }, binding)).toThrow();
    expect(() =>
      issueCodexSessionGrant({ ...config, appOrigin: config.hiveOrigin }, binding),
    ).toThrow();
    expect(() => issueCodexSessionGrant(config, { ...binding, threadId: "" })).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      issueCodexSessionGrant(
        {
          ...config,
          privateKeyPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        },
        binding,
      ),
    ).toThrow("Ed25519");
  });

  it("interoperates with the actual bridge verifier over a local WebSocket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-signer-interop-"));
    const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => native.once("listening", resolve));
    native.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        if (request.method === "initialize")
          socket.send(
            JSON.stringify({ id: request.id, result: { userAgent: "hive/0.165.0 (Linux)" } }),
          );
      }),
    );
    const address = native.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP address");
    const bridge = await startBridge({
      schemaVersion: 1,
      protocolVersion: "0.165.0",
      binding,
      hiveOrigin: config.hiveOrigin,
      appOrigin: config.appOrigin,
      nativeUrl: `ws://127.0.0.1:${address.port}`,
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      keyId: config.keyId,
      stateDirectory: directory,
      port: 0,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/session`, {
      headers: { origin: config.hiveOrigin, host: new URL(config.appOrigin).host },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const reply = new Promise<any>((resolve, reject) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
        socket.once("close", () => reject(new Error("Bridge rejected signed grant")));
      });
      const grant = issueCodexSessionGrant(config, binding);
      socket.send(JSON.stringify({ type: "authenticate", ticket: grant.ticket }));
      await expect(reply).resolves.toEqual({
        type: "authenticated",
        protocolVersion: "0.165.0",
        binding,
      });
    } finally {
      socket.terminate();
      await bridge.close();
      for (const client of native.clients) client.terminate();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
