import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AgentBridgeClient,
  type AgentBridgeClientConfig,
  AgentBridgeError,
} from "@/lib/agents/portable-client.server";
import { agentCanonical, agentProofPayload } from "@/lib/agents/portable-contracts";

const issuer = generateKeyPairSync("ed25519"),
  host = generateKeyPairSync("ed25519"),
  sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
const binding = {
  coderOrigin: "https://coder.example",
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  agentId: randomUUID(),
  templateId: randomUUID(),
  appOrigin: "https://agent.example",
  appId: randomUUID(),
};
const config: AgentBridgeClientConfig = {
  issuer: "https://hive.example",
  keyId: "test",
  privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  binding,
  hiveUserId: randomUUID(),
  home: "/home/coder",
  profile: "software",
  manifestSha256: "a".repeat(64),
  helperSha256: "b".repeat(64),
};
const digest = sha(
  agentCanonical({
    schemaVersion: 1,
    issuer: config.issuer,
    issuerKeyId: config.keyId,
    issuerPublicKeySha256: sha(issuer.publicKey.export({ type: "spki", format: "der" })),
    binding,
    profile: config.profile,
    home: config.home,
    manifestSha256: config.manifestSha256,
    helperSha256: config.helperSha256,
    environment: {},
  }),
);
const lifetimeId = randomUUID();
function fixture(
  options: {
    loseMutation?: boolean;
    wrongManifest?: boolean;
    mutationFailed?: boolean;
    wrongReceipt?: boolean;
    management?: boolean;
    wrongManagementFence?: boolean;
  } = {},
) {
  const transport = vi.fn(async (ticket: string) => {
    const claims = JSON.parse(Buffer.from(ticket.split(".")[1], "base64url").toString());
    if (claims.request.operation !== "identity" && options.loseMutation)
      throw new Error("lost response");
    const data =
      claims.request.operation === "identity"
        ? {
            publicKeyPem: host.publicKey.export({ type: "spki", format: "pem" }).toString(),
            configDigest: digest,
            manifestSha256: options.wrongManifest ? "c".repeat(64) : config.manifestSha256,
            environment: {},
            ...(options.management ? { capabilities: ["codex-management"] } : {}),
          }
        : claims.request.operation === "codex-management"
          ? {
              scope: "managed-native",
              lifetimeId,
              generation: options.wrongManagementFence
                ? 99
                : claims.request.management.generation +
                  Number(claims.request.management.action === "save-config"),
              outcome: claims.request.management.action === "save-config" ? "saved" : "read",
              usage: null,
              overridden: null,
              config: {
                version: "version-2",
                values: {
                  model: null,
                  review_model: null,
                  model_reasoning_effort: null,
                  model_verbosity: null,
                  web_search: null,
                  service_tier: null,
                },
                origins: {},
                models: [],
                truncated: false,
                approvalPolicy: null,
                sandboxMode: null,
              },
            }
          : claims.request.operation === "install-notifications"
            ? {
                sourceId: claims.request.sourceId,
                generation: options.wrongReceipt
                  ? claims.request.generation + 1
                  : claims.request.generation,
                createdAt: claims.request.createdAt,
                credentialHash: sha(claims.request.token),
                callbackOrigin: config.issuer,
              }
            : claims.request.operation === "codex-account" ||
                claims.request.operation === "claude-account"
              ? {
                  scope:
                    claims.request.operation === "codex-account"
                      ? "managed-native"
                      : "workspace-cli",
                  lifetimeId,
                  generation: 0,
                  state: "signed-out",
                  pending: null,
                }
              : { message: "tracking installed" };
    const result = {
      schemaVersion: 1,
      requestId: claims.jti,
      lifetimeId,
      operation: claims.request.operation,
      result:
        claims.request.operation !== "identity" && options.mutationFailed
          ? { ok: false, error: "agent_operation_failed" }
          : { ok: true, data },
    };
    return Response.json({
      ...result,
      proof: sign(null, Buffer.from(agentProofPayload(result)), host.privateKey).toString(
        "base64url",
      ),
    });
  });
  return { transport, client: new AgentBridgeClient(config, transport) };
}
describe("portable agent client", () => {
  it("retains P03 account status on its pinned manifest and withholds discovery", async () => {
    const { transport } = fixture();
    const client = new AgentBridgeClient(
      { ...config, previousManifestSha256: config.manifestSha256, manifestSha256: "c".repeat(64) },
      transport,
    );
    await expect(
      client.execute({ operation: "codex-account", account: { action: "status" } }),
    ).resolves.toMatchObject({ state: "signed-out" });
    transport.mockClear();
    await expect(
      client.execute({ operation: "discover-projects", page: 1, perPage: 1 }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps old runtime operations usable while refusing unsupported management before submission", async () => {
    const old = fixture();
    await expect(
      old.client.execute({
        operation: "codex-management",
        management: { action: "config", lifetimeId, generation: 0 },
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(old.transport).toHaveBeenCalledTimes(1);
    expect(
      await old.client.execute({ operation: "codex-account", account: { action: "status" } }),
    ).toMatchObject({ state: "signed-out" });
  });
  it("fences management replies and treats a lost config-save response as uncertain without replay", async () => {
    const request = {
      operation: "codex-management" as const,
      management: {
        action: "save-config" as const,
        lifetimeId,
        generation: 0,
        version: "version-1",
        values: { model_verbosity: "high" as const },
      },
    };
    const good = fixture({ management: true });
    expect(await good.client.execute(request)).toMatchObject({ generation: 1, outcome: "saved" });
    for (const options of [
      { loseMutation: true },
      { wrongManagementFence: true },
      { mutationFailed: true },
    ]) {
      const failed = fixture({ management: true, ...options });
      await expect(failed.client.execute(request)).rejects.toMatchObject({
        code: "outcome_unknown",
      });
      expect(failed.transport).toHaveBeenCalledTimes(2);
    }
  });
  it.each([
    {
      operation: "claude-account" as const,
      account: {
        action: "code" as const,
        lifetimeId: randomUUID(),
        generation: 1,
        code: "PRIVATE_CODE#STATE",
      },
    },
    { operation: "rename-terminal-session" as const, oldName: "one", newName: "two" },
    { operation: "kill-terminal-session" as const, sessionName: "one" },
    {
      operation: "codex-account" as const,
      account: { action: "connect" as const, lifetimeId, generation: 0 },
    },
  ])("never retries uncertain new fixed mutation $operation", async (request) => {
    const f = fixture({ loseMutation: true });
    await expect(f.client.execute(request)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("uses a verified process identity before the fixed signed operation", async () => {
    const f = fixture();
    expect(await f.client.execute({ operation: "install" })).toEqual({
      message: "tracking installed",
    });
    expect(f.transport).toHaveBeenCalledTimes(2);
    const claims = JSON.parse(
      Buffer.from(f.transport.mock.calls[1][0].split(".")[1], "base64url").toString(),
    );
    expect(claims).toMatchObject({
      lifetimeId,
      request: { operation: "install" },
      binding: { buildId: binding.buildId, hiveUserId: config.hiveUserId },
    });
    expect(claims.request).not.toHaveProperty("source");
  });
  it("fails before mutations on an untrusted host pin", async () => {
    const f = fixture({ wrongManifest: true });
    await expect(f.client.execute({ operation: "install" })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("reports a lost mutation response as unknown without retrying", async () => {
    const f = fixture({ loseMutation: true });
    await expect(f.client.execute({ operation: "install" })).rejects.toEqual(
      new AgentBridgeError("outcome_unknown"),
    );
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("bounds an uncooperative transport after a mutation is submitted", async () => {
    const f = fixture(),
      real = f.transport.getMockImplementation();
    f.transport
      .mockImplementationOnce(real as NonNullable<typeof real>)
      .mockImplementationOnce(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = f.client.execute({ operation: "install" }, abort.signal);
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "outcome_unknown" });
  });
  it("treats a failed mutation as uncertain because user files may be partly changed", async () => {
    const f = fixture({ mutationFailed: true });
    await expect(f.client.execute({ operation: "install" })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("binds a notification receipt to the exact source/generation and treats lost or substituted results as uncertain", async () => {
    const operation = {
      operation: "install-notifications" as const,
      sourceId: randomUUID(),
      generation: 1,
      createdAt: "2026-11-06T00:00:00.000Z",
      token: "d".repeat(64),
    };
    const good = fixture();
    const receipt = await good.client.execute(operation);
    expect(receipt).toMatchObject({
      sourceId: operation.sourceId,
      generation: 1,
      callbackOrigin: config.issuer,
    });
    expect(JSON.stringify(receipt)).not.toContain(operation.token);
    for (const options of [
      { loseMutation: true },
      { wrongReceipt: true },
      { mutationFailed: true },
    ]) {
      const f = fixture(options);
      await expect(f.client.execute(operation)).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(f.transport).toHaveBeenCalledTimes(2);
    }
  });
});

it.each([
  "codex-account",
  "claude-account",
] as const)("accepts only the signed bounded account result for %s", async (operation) => {
  const f = fixture();
  expect(await f.client.execute({ operation, account: { action: "status" } })).toMatchObject({
    lifetimeId,
    state: "signed-out",
    pending: null,
  });
  expect(f.transport).toHaveBeenCalledTimes(2);
});

it("rejects replayed response IDs before submitting an account action", async () => {
  const f = fixture();
  const original = f.transport.getMockImplementation()!;
  let saved: Response | undefined;
  f.transport.mockImplementation(async (ticket) => {
    saved ??= await original(ticket);
    return saved.clone();
  });
  await expect(
    f.client.execute({ operation: "codex-account", account: { action: "status" } }),
  ).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(f.transport).toHaveBeenCalledTimes(2);
});

it("rejects a forged identity signature before sending an account operation", async () => {
  const f = fixture();
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementationOnce(async (ticket) => {
    const response = await original(ticket);
    const reply = await response.json();
    return Response.json({ ...reply, proof: "A".repeat(86) });
  });
  await expect(
    f.client.execute({ operation: "codex-account", account: { action: "status" } }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(f.transport).toHaveBeenCalledOnce();
});

it("holds a validly signed response from a different process lifetime without retry", async () => {
  const f = fixture();
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementationOnce(original).mockImplementationOnce(async (ticket) => {
    const response = await original(ticket);
    const { proof: _proof, ...reply } = await response.json();
    reply.lifetimeId = randomUUID();
    return Response.json({
      ...reply,
      proof: sign(null, Buffer.from(agentProofPayload(reply)), host.privateKey).toString(
        "base64url",
      ),
    });
  });
  await expect(
    f.client.execute({
      operation: "codex-account",
      account: { action: "disconnect", lifetimeId, generation: 0 },
    }),
  ).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(f.transport).toHaveBeenCalledTimes(2);
});
