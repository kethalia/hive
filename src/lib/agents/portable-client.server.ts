import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  type AgentBridgeBinding,
  type AgentOperation,
  type AgentOperationResult,
  agentBridgeBindingSchema,
  agentCanonical,
  agentOperationSchema,
  agentProofPayload,
  agentReplySchema,
  agentResultSchemas,
} from "./portable-contracts";

export class AgentBridgeError extends Error {
  constructor(public readonly code: "unavailable" | "operation_failed" | "outcome_unknown") {
    super(
      code === "outcome_unknown"
        ? "Agent operation outcome is unknown. Inspect workspace state before retrying."
        : code === "operation_failed"
          ? "Agent operation failed. Check the workspace configuration and try again."
          : "Agent tools are unavailable in this workspace.",
    );
  }
}
export type AgentBridgeClientConfig = {
  issuer: string;
  keyId: string;
  privateKeyPem: string;
  binding: AgentBridgeBinding;
  hiveUserId: string;
  home: string;
  profile: "software" | "browser" | "game" | "electronics" | "infrastructure";
  manifestSha256: string;
  helperSha256: string;
};
export type AgentBridgeTransport = (
  ticket: string,
  expiresAt: number,
  signal: AbortSignal,
) => Promise<Response>;
const hash = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
const MUTATIONS = new Set(["install", "disable", "configure-coder", "resume"]);
function packet(
  config: AgentBridgeClientConfig,
  request: AgentOperation,
  lifetimeId: string | null,
) {
  const key = createPrivateKey(config.privateKeyPem),
    iat = Math.floor(Date.now() / 1000);
  if (key.asymmetricKeyType !== "ed25519") throw new AgentBridgeError("unavailable");
  const claims = {
    iss: config.issuer,
    aud: config.binding.appOrigin,
    scope: "agent:operation:v1",
    jti: randomUUID(),
    iat,
    exp: iat + 60,
    lifetimeId,
    binding: { ...config.binding, hiveUserId: config.hiveUserId },
    request,
  };
  const encoded = [{ alg: "EdDSA", typ: "JWT", kid: config.keyId }, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return {
    claims,
    ticket: `${encoded}.${sign(null, Buffer.from(encoded), key).toString("base64url")}`,
  };
}
function digest(config: AgentBridgeClientConfig, environment: Record<string, string | undefined>) {
  const issuerPublicKeySha256 = hash(
    createPublicKey(createPrivateKey(config.privateKeyPem)).export({ type: "spki", format: "der" }),
  );
  return hash(
    agentCanonical({
      schemaVersion: 1,
      issuer: config.issuer,
      issuerKeyId: config.keyId,
      issuerPublicKeySha256,
      binding: config.binding,
      profile: config.profile,
      home: config.home,
      manifestSha256: config.manifestSha256,
      helperSha256: config.helperSha256,
      environment,
    }),
  );
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
async function bounded(response: Response, signal: AbortSignal) {
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.has("location") ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error();
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (let count = 0; count < 4096; count++) {
      signal.throwIfAborted();
      const part = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (part.done)
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024 + 16384) throw new Error();
      chunks.push(new Uint8Array(part.value));
    }
    throw new Error();
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
}
/** The caller must resolve the owner-only app and current workspace/build before
 * invoking this client, and revalidate binding after it returns. A lost mutation
 * response has unknown outcome; this client never retries. */
export class AgentBridgeClient {
  constructor(
    private readonly config: AgentBridgeClientConfig,
    private readonly transport: AgentBridgeTransport,
  ) {}
  async execute<K extends Exclude<AgentOperation["operation"], "identity">>(
    request: Extract<AgentOperation, { operation: K }>,
    callerSignal?: AbortSignal,
  ): Promise<AgentOperationResult<K>> {
    let submitted = false;
    const signal = AbortSignal.any([
      AbortSignal.timeout(45000),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      agentBridgeBindingSchema.parse(this.config.binding);
      const parsed = agentOperationSchema.parse(request);
      if (parsed.operation === "identity") throw new Error();
      const initial = packet(this.config, { operation: "identity" }, null);
      const identity = agentReplySchema.parse(
        await bounded(
          await abortable(this.transport(initial.ticket, initial.claims.exp, signal), signal),
          signal,
        ),
      );
      if (
        identity.requestId !== initial.claims.jti ||
        identity.operation !== "identity" ||
        !identity.result.ok ||
        Date.now() / 1000 >= initial.claims.exp
      )
        throw new Error();
      const data = agentResultSchemas.identity.parse(identity.result.data),
        publicKey = createPublicKey(data.publicKeyPem),
        { proof, ...unsigned } = identity;
      if (
        data.manifestSha256 !== this.config.manifestSha256 ||
        data.configDigest !== digest(this.config, data.environment) ||
        publicKey.asymmetricKeyType !== "ed25519" ||
        publicKey.export({ type: "spki", format: "pem" }) !== data.publicKeyPem ||
        !verify(
          null,
          Buffer.from(agentProofPayload(unsigned)),
          publicKey,
          Buffer.from(proof, "base64url"),
        )
      )
        throw new Error();
      const next = packet(this.config, parsed, identity.lifetimeId);
      signal.throwIfAborted();
      submitted = true;
      const reply = agentReplySchema.parse(
        await bounded(
          await abortable(this.transport(next.ticket, next.claims.exp, signal), signal),
          signal,
        ),
      );
      const { proof: signature, ...payload } = reply;
      if (
        reply.requestId !== next.claims.jti ||
        reply.lifetimeId !== identity.lifetimeId ||
        reply.operation !== parsed.operation ||
        Date.now() / 1000 >= next.claims.exp ||
        !verify(
          null,
          Buffer.from(agentProofPayload(payload)),
          publicKey,
          Buffer.from(signature, "base64url"),
        )
      )
        throw new Error();
      if (!reply.result.ok)
        throw new AgentBridgeError(
          MUTATIONS.has(parsed.operation) ? "outcome_unknown" : "operation_failed",
        );
      return agentResultSchemas[parsed.operation].parse(
        reply.result.data,
      ) as AgentOperationResult<K>;
    } catch (error) {
      if (error instanceof AgentBridgeError && error.code === "operation_failed") throw error;
      if (submitted && MUTATIONS.has((request as AgentOperation).operation))
        throw new AgentBridgeError("outcome_unknown");
      throw new AgentBridgeError("unavailable");
    }
  }
}
