import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type { CoderClient } from "@/lib/coder/client";
import { exchangeVerifiedWorkspaceVoiceCookie } from "@/lib/codex-session/bootstrap-delivery.server";
import type { VerifiedHostBinding } from "@/lib/codex-session/registration.server";
import { nativeVoiceSocket, VoiceRpc } from "./voice-rpc";

type Coder = Pick<CoderClient, "getApplicationAuthRedirect" | "getApplicationsHost" | "getBaseUrl">;
type Config = {
  privateKeyPem: string;
  keyId: string;
  issuer: string;
  manifestSha256: string;
  lockDirectory: string;
};
type NativeSocket = WebSocket & { accept(): void };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function packet(
  config: Config,
  binding: VerifiedHostBinding,
  scope: "voice:identity:v1" | "voice:connect:v1",
  threadId: string | null,
  lifetimeId: string | null,
) {
  const key = createPrivateKey(config.privateKeyPem),
    iat = Math.floor(Date.now() / 1000);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("voice unavailable");
  const claims = {
    iss: config.issuer,
    aud: binding.appOrigin,
    scope,
    jti: randomUUID(),
    iat,
    exp: iat + 15,
    workspaceId: binding.workspaceId,
    buildId: binding.buildId,
    agentId: binding.agentId,
    threadId,
    lifetimeId,
  };
  const payload = [{ alg: "EdDSA", typ: "JWT", kid: config.keyId }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return {
    claims,
    ticket: `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`,
  };
}
function configDigest(config: Config, binding: VerifiedHostBinding) {
  const publicKey = createPublicKey(createPrivateKey(config.privateKeyPem));
  return hash(
    JSON.stringify({
      schemaVersion: 1,
      issuer: config.issuer,
      audience: binding.appOrigin,
      issuerKeyId: config.keyId,
      issuerKeySha256: hash(publicKey.export({ type: "spki", format: "der" })),
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      agentId: binding.agentId,
      lockDirectory: config.lockDirectory,
      manifestSha256: config.manifestSha256,
    }),
  );
}
/** Only call after freshly resolving owner, active build, and the exact owner-only voice app. */
export async function openPortableVoiceClient(
  config: Config,
  coder: Coder,
  binding: VerifiedHostBinding,
  threadId: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  dispose: () => void = () => {},
) {
  if (
    (threadId && !uuid.test(threadId)) ||
    !/^[a-f0-9]{64}$/.test(config.manifestSha256) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(config.keyId)
  )
    throw new Error("voice unavailable");
  const scopedFetch: typeof fetch = (input, init) =>
    fetcher(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  const identity = packet(config, binding, "voice:identity:v1", null, null);
  const first = await exchangeVerifiedWorkspaceVoiceCookie(
    coder,
    binding,
    "/voice/identity",
    identity.claims.exp,
    scopedFetch,
  );
  const response = await scopedFetch(first.url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    headers: { Cookie: first.cookie, Authorization: `Bearer ${identity.ticket}` },
  });
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel();
    throw new Error("voice unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("voice unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 4096) throw new Error("voice unavailable");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object") throw new Error("voice unavailable");
  const data = body as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(",") !==
      [
        "requestId",
        "lifetimeId",
        "workspaceId",
        "buildId",
        "agentId",
        "manifestSha256",
        "configDigest",
        "publicKeyPem",
        "proof",
      ]
        .sort()
        .join(",") ||
    data.requestId !== identity.claims.jti ||
    typeof data.lifetimeId !== "string" ||
    !uuid.test(data.lifetimeId) ||
    data.workspaceId !== binding.workspaceId ||
    data.buildId !== binding.buildId ||
    data.agentId !== binding.agentId ||
    data.manifestSha256 !== config.manifestSha256 ||
    data.configDigest !== configDigest(config, binding) ||
    typeof data.publicKeyPem !== "string" ||
    data.publicKeyPem.length > 256 ||
    typeof data.proof !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(data.proof) ||
    Date.now() / 1000 >= identity.claims.exp
  )
    throw new Error("voice unavailable");
  const publicKey = createPublicKey(data.publicKeyPem);
  const unsigned = {
    requestId: data.requestId,
    lifetimeId: data.lifetimeId,
    workspaceId: data.workspaceId,
    buildId: data.buildId,
    agentId: data.agentId,
    manifestSha256: data.manifestSha256,
    configDigest: data.configDigest,
    publicKeyPem: data.publicKeyPem,
  };
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    publicKey.export({ type: "spki", format: "pem" }) !== data.publicKeyPem ||
    !verify(
      null,
      Buffer.from(`hive-voice-identity-v1\n${JSON.stringify(unsigned)}`),
      publicKey,
      Buffer.from(data.proof, "base64url"),
    )
  )
    throw new Error("voice unavailable");
  const next = packet(config, binding, "voice:connect:v1", threadId ?? null, data.lifetimeId);
  const endpoint = await exchangeVerifiedWorkspaceVoiceCookie(
    coder,
    binding,
    "/voice",
    next.claims.exp,
    scopedFetch,
  );
  signal.throwIfAborted();
  const upgraded = await scopedFetch(endpoint.url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    headers: {
      Upgrade: "websocket",
      Cookie: endpoint.cookie,
      Authorization: `Bearer ${next.ticket}`,
    },
  });
  const socket = (upgraded as Response & { webSocket?: NativeSocket }).webSocket;
  if (
    upgraded.status !== 101 ||
    !socket ||
    upgraded.redirected ||
    Date.now() / 1000 >= next.claims.exp
  ) {
    socket?.close();
    await upgraded.body?.cancel();
    throw new Error("voice unavailable");
  }
  socket.accept();
  const rpc = new VoiceRpc(nativeVoiceSocket(socket), dispose);
  const abort = () => rpc.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.initialize();
    signal.throwIfAborted();
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
