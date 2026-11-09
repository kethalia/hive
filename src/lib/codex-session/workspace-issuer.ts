import { createPrivateKey, createPublicKey } from "node:crypto";

export type WorkspaceIssuerEnvironment = {
  HIVE_WORKSPACE_ISSUER_MODE?: string;
  HIVE_CODEX_GATEWAY_ENABLED?: string;
  HIVE_CODEX_ISSUER_PRIVATE_KEY?: string;
  HIVE_CODEX_ISSUER_PUBLIC_KEY?: string;
  HIVE_CODEX_ISSUER_KEY_ID?: string;
  HIVE_CODEX_HIVE_ORIGIN?: string;
  HIVE_CODEX_SOFTWARE_TEMPLATE_IDS?: string;
};

/** An explicit deployment mode shares only the already enrolled software host
 * issuer, with exact scope and key checks. Dedicated issuers stay the default. */
export function workspaceIssuerPrivateKey(
  env: WorkspaceIssuerEnvironment,
  input: { dedicatedKey: string; origin: string; keyId: string; templateIds: string[] },
): string {
  if (!env.HIVE_WORKSPACE_ISSUER_MODE || env.HIVE_WORKSPACE_ISSUER_MODE === "dedicated")
    return input.dedicatedKey;
  if (
    env.HIVE_WORKSPACE_ISSUER_MODE !== "shared-host" ||
    env.HIVE_CODEX_GATEWAY_ENABLED !== "true" ||
    input.dedicatedKey ||
    input.origin !== env.HIVE_CODEX_HIVE_ORIGIN ||
    input.keyId !== env.HIVE_CODEX_ISSUER_KEY_ID ||
    input.templateIds.length !== 1 ||
    input.templateIds[0] !== env.HIVE_CODEX_SOFTWARE_TEMPLATE_IDS
  )
    throw new Error("Workspace issuer scope mismatch");
  const key = createPrivateKey(env.HIVE_CODEX_ISSUER_PRIVATE_KEY ?? "");
  const publicKey = createPublicKey(env.HIVE_CODEX_ISSUER_PUBLIC_KEY ?? "");
  if (
    key.asymmetricKeyType !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    !createPublicKey(key)
      .export({ type: "spki", format: "der" })
      .equals(publicKey.export({ type: "spki", format: "der" }))
  )
    throw new Error("Workspace issuer key mismatch");
  return env.HIVE_CODEX_ISSUER_PRIVATE_KEY ?? "";
}
