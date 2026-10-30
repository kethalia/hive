import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import type { RegisteredSessionConfig } from "./registered-session.server";
import type { RegistrationBinding } from "./registration.server";

/** Derived solely from deployment policy and independently resolved Coder scope.
 * The host's presented config digest is compared to this, never an approval input. */
export function expectedGuardianHostConfig(
  binding: RegistrationBinding,
  config: RegisteredSessionConfig,
  env: Record<string, string | undefined> = process.env,
) {
  const model = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
    .parse(env.HIVE_CODEX_MANAGER_MODEL);
  const effort = z
    .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
    .parse(env.HIVE_CODEX_MANAGER_EFFORT);
  const deliveryExecutionEnabled = env.HIVE_DELIVERY_EXECUTION_ENABLED === "true";
  if (deliveryExecutionEnabled && env.HIVE_DELIVERY_MANAGER_ENABLED !== "true")
    throw new Error("Delivery execution requires manager policy");
  const publicKey = createPublicKey(config.privateKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Guardian issuer rejected");
  const { projects: _projects, ...hostBinding } = binding;
  return {
    schemaVersion: 1,
    enabled: true,
    profile: "software",
    binding: hostBinding,
    hiveOrigin: config.hiveOrigin,
    issuerPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    issuerKeyId: config.keyId,
    port: config.gatewayPort,
    model,
    effort,
    managerEnabled: env.HIVE_DELIVERY_MANAGER_ENABLED === "true",
    nativeIsolationEnabled: true,
    guardianEnabled: true,
    ...(deliveryExecutionEnabled ? { deliveryExecutionEnabled: true } : {}),
  };
}
/** Matches the installed Python writer: sorted ASCII keys, compact JSON, LF. */
export function guardianConfigBytes(config: ReturnType<typeof expectedGuardianHostConfig>) {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, sorted(v)]),
          )
        : value;
  const json = JSON.stringify(sorted(config));
  if ([...json].some((character) => character.charCodeAt(0) > 127))
    throw new Error("Guardian config encoding rejected");
  return `${json}\n`;
}
export const guardianConfigSha256 = (config: ReturnType<typeof expectedGuardianHostConfig>) =>
  createHash("sha256").update(guardianConfigBytes(config)).digest("hex");
