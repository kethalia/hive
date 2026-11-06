import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type { CoderClient } from "@/lib/coder/client";
import { requestVerifiedWorkspaceRead } from "@/lib/codex-session/bootstrap-delivery.server";
import type { VerifiedHostBinding } from "@/lib/codex-session/registration.server";
import {
  WORKSPACE_READ_MAX_REQUEST_BYTES,
  type WorkspaceReadData,
  WorkspaceReadError,
  type WorkspaceReadProfile,
  type WorkspaceReadRequest,
  workspaceReadCanonical,
  workspaceReadClaimsSchema,
  workspaceReadDataSchemas,
  workspaceReadEnvelopeSchema,
  workspaceReadRequestSchema,
  workspaceReadResponsePayload,
} from "./read-contracts";

if (typeof window !== "undefined") throw new Error("Workspace reads are server-only");
type ReadCoder = Pick<
  CoderClient,
  "getApplicationAuthRedirect" | "getApplicationsHost" | "getBaseUrl"
>;
export type WorkspaceReadClientConfig = {
  privateKeyPem: string;
  keyId: string;
  hiveOrigin: string;
  profile: WorkspaceReadProfile;
  projectsRoot: string;
  home: string;
  manifestSha256: string;
};
export class WorkspaceReadClient {
  constructor(
    private readonly config: WorkspaceReadClientConfig,
    private readonly coder: ReadCoder,
    private readonly binding: VerifiedHostBinding,
    private readonly transport: typeof requestVerifiedWorkspaceRead = requestVerifiedWorkspaceRead,
  ) {}
  private packet(request: WorkspaceReadRequest, lifetimeId: string | null) {
    const key = createPrivateKey(this.config.privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new WorkspaceReadError("disabled");
    const iat = Math.floor(Date.now() / 1000),
      claims = workspaceReadClaimsSchema.parse({
        iss: this.config.hiveOrigin,
        aud: this.binding.appOrigin,
        scope: "workspace:read:v1",
        jti: randomUUID(),
        iat,
        exp: iat + 15,
        lifetimeId,
        profile: this.config.profile,
        binding: this.binding,
        request,
      });
    const encoded = [{ alg: "EdDSA", typ: "JWT", kid: this.config.keyId }, claims]
      .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
      .join(".");
    return {
      claims,
      ticket: `${encoded}.${sign(null, Buffer.from(encoded), key).toString("base64url")}`,
    };
  }
  private expectedConfigDigest() {
    const { hiveUserId: _principal, ...binding } = this.binding,
      key = createPublicKey(createPrivateKey(this.config.privateKeyPem)),
      issuerPublicKeySha256 = createHash("sha256")
        .update(key.export({ type: "spki", format: "der" }))
        .digest("hex");
    return createHash("sha256")
      .update(
        workspaceReadCanonical({
          schemaVersion: 1,
          profile: this.config.profile,
          projectsRoot: this.config.projectsRoot,
          home: this.config.home,
          hiveOrigin: this.config.hiveOrigin,
          issuerKeyId: this.config.keyId,
          issuerPublicKeySha256,
          binding,
          port: 13342,
        }),
      )
      .digest("hex");
  }
  async read<K extends Exclude<WorkspaceReadRequest["operation"], "identity">>(
    raw: Extract<WorkspaceReadRequest, { operation: K }>,
    signal?: AbortSignal,
  ): Promise<WorkspaceReadData<K>> {
    try {
      const request = workspaceReadRequestSchema.parse(raw);
      if (request.operation === "identity") throw new WorkspaceReadError("invalid_response");
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > WORKSPACE_READ_MAX_REQUEST_BYTES)
        throw new WorkspaceReadError("request_too_large");
      signal?.throwIfAborted();
      const first = this.packet({ operation: "identity" }, null),
        identity = workspaceReadEnvelopeSchema.parse(
          await this.transport(this.coder, this.binding, {
            ticket: first.ticket,
            expiresAt: first.claims.exp,
            signal,
          }),
        );
      signal?.throwIfAborted();
      if (
        Date.now() / 1000 >= first.claims.exp ||
        identity.operation !== "identity" ||
        identity.requestId !== first.claims.jti ||
        !identity.result.ok
      )
        throw new WorkspaceReadError("invalid_response");
      const metadata = workspaceReadDataSchemas.identity.parse(identity.result.data),
        publicKey = createPublicKey(metadata.publicKeyPem),
        { proof, ...unsigned } = identity;
      if (
        metadata.profile !== this.config.profile ||
        metadata.projectsRoot !== this.config.projectsRoot ||
        metadata.manifestSha256 !== this.config.manifestSha256 ||
        metadata.configDigest !== this.expectedConfigDigest() ||
        publicKey.asymmetricKeyType !== "ed25519" ||
        publicKey.export({ type: "spki", format: "pem" }) !== metadata.publicKeyPem ||
        !verify(
          null,
          Buffer.from(workspaceReadResponsePayload(unsigned)),
          publicKey,
          Buffer.from(proof, "base64url"),
        )
      )
        throw new WorkspaceReadError("invalid_response");
      const next = this.packet(request, identity.lifetimeId),
        reply = workspaceReadEnvelopeSchema.parse(
          await this.transport(this.coder, this.binding, {
            ticket: next.ticket,
            expiresAt: next.claims.exp,
            signal,
          }),
        );
      signal?.throwIfAborted();
      const { proof: signature, ...result } = reply;
      if (
        Date.now() / 1000 >= next.claims.exp ||
        reply.lifetimeId !== identity.lifetimeId ||
        reply.operation !== request.operation ||
        reply.requestId !== next.claims.jti ||
        !verify(
          null,
          Buffer.from(workspaceReadResponsePayload(result)),
          publicKey,
          Buffer.from(signature, "base64url"),
        )
      )
        throw new WorkspaceReadError("invalid_response");
      if (!reply.result.ok) throw new WorkspaceReadError(reply.result.error);
      const data = workspaceReadDataSchemas[request.operation].parse(reply.result.data);
      if (request.operation === "paths") {
        const value = workspaceReadDataSchemas.paths.parse(data);
        if (
          value.candidates.length !== request.paths.length ||
          new Set(value.candidates.map((v) => v.index)).size !== request.paths.length ||
          value.candidates.some((v) => v.index >= request.paths.length)
        )
          throw new WorkspaceReadError("invalid_response");
      }
      return data as WorkspaceReadData<K>;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof WorkspaceReadError) throw error;
      throw new WorkspaceReadError("invalid_response");
    }
  }
}
