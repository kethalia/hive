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
  options: { loseMutation?: boolean; wrongManifest?: boolean; mutationFailed?: boolean } = {},
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
});
