// Server-only module: node:crypto is intentionally not a browser dependency.
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import type { SessionBinding } from "./adapter";
import type { SessionGrant } from "./browser-transport";

if (typeof window !== "undefined") throw new Error("Session ticket signing is server-only.");

type SigningConfig = {
  privateKeyPem: string;
  keyId: string;
  hiveOrigin: string;
  appOrigin: string;
};

function exactOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.hostname.includes("*")
  )
    throw new Error("Session signing requires exact HTTPS origins.");
  return url;
}

/** Cryptographic primitive only. Before EVERY call (including renewal), the route
 * must authorize the current user, running workspace/build and registered native
 * server/project/thread. Neither a browser-supplied binding nor this type proves
 * authority. Keep the private key only in server secret configuration.
 */
export function issueCodexSessionGrant(
  config: SigningConfig,
  authorizedBinding: SessionBinding,
  ttlSeconds = 60,
): SessionGrant {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 60)
    throw new Error("Session ticket TTL must be 1–60 seconds.");
  const hive = exactOrigin(config.hiveOrigin);
  const app = exactOrigin(config.appOrigin);
  if (hive.hostname === app.hostname) throw new Error("Session app requires an isolated hostname.");
  const binding = {
    ownerId: authorizedBinding.ownerId,
    workspaceId: authorizedBinding.workspaceId,
    buildId: authorizedBinding.buildId,
    serverInstanceId: authorizedBinding.serverInstanceId,
    threadId: authorizedBinding.threadId,
  };
  if (
    ![
      binding.ownerId,
      binding.workspaceId,
      binding.buildId,
      binding.serverInstanceId,
      binding.threadId,
      config.keyId,
    ].every((value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value))
  )
    throw new Error("Invalid trusted session binding.");
  const key = createPrivateKey(config.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Session signing requires Ed25519.");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.keyId }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: config.hiveOrigin,
      aud: config.appOrigin,
      sub: binding.ownerId,
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      serverInstanceId: binding.serverInstanceId,
      threadId: binding.threadId,
      origin: config.hiveOrigin,
      scope: "session:read",
      iat: issuedAt,
      exp: expiresAt,
      jti: randomUUID(),
    }),
  ).toString("base64url");
  const ticket = `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), key).toString("base64url")}`;
  return {
    url: `${config.appOrigin}/session`,
    binding,
    protocolVersion: "0.165.0",
    expiresAt,
    ticket,
  };
}
