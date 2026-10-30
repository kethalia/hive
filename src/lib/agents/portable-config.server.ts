import { createPrivateKey } from "node:crypto";
import { getDb } from "@hive/db";
import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { requestVerifiedWorkspaceAgent } from "@/lib/codex-session/bootstrap-delivery.server";
import { AgentBridgeError } from "./portable-client.server";
import { AgentBridgeService, type AgentBridgeServiceConfig } from "./portable-service.server";

const pin = z
  .object({
    templateId: z.string().uuid(),
    profile: z.enum(["software", "browser", "game", "electronics", "infrastructure"]),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function portableAgentConfig(
  env: Record<string, string | undefined> = process.env,
): AgentBridgeServiceConfig {
  if (env.HIVE_AGENT_TOOLS_ENABLED !== "true" || env.HIVE_AGENT_TOOLS_TRANSPORT !== "workspace-app")
    throw new AgentBridgeError("unavailable");
  try {
    const issuer = env.HIVE_AGENT_TOOLS_HIVE_ORIGIN ?? "",
      keyId = env.HIVE_AGENT_TOOLS_ISSUER_KEY_ID ?? "",
      privateKeyPem = env.HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY ?? "",
      url = new URL(issuer),
      pins = z
        .array(pin)
        .min(1)
        .max(32)
        .parse(JSON.parse(env.HIVE_AGENT_TOOLS_PINS_JSON ?? ""));
    if (
      url.protocol !== "https:" ||
      url.origin !== issuer ||
      url.username ||
      url.password ||
      createPrivateKey(privateKeyPem).asymmetricKeyType !== "ed25519" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
      new Set(pins.map((p) => p.templateId)).size !== pins.length
    )
      throw new Error();
    return {
      issuer,
      keyId,
      privateKeyPem,
      pins,
      home: "/home/coder",
      cookieDomains: env.COOKIE_DOMAIN ? [env.COOKIE_DOMAIN] : [],
    };
  } catch {
    throw new AgentBridgeError("unavailable");
  }
}
export function createPortableAgentService(config = portableAgentConfig()) {
  return new AgentBridgeService(config, {
    async coderForPrincipal(principal, signal) {
      signal.throwIfAborted();
      const user = await getDb().user.findUnique({
        where: { id: principal.hiveUserId },
        select: { coderUserId: true },
      });
      signal.throwIfAborted();
      if (!user || user.coderUserId !== principal.coderUserId)
        throw new AgentBridgeError("unavailable");
      return getCoderClientForUser(principal.hiveUserId, { signal });
    },
    transport: (coder, binding) => (ticket, expiresAt, signal) =>
      requestVerifiedWorkspaceAgent(coder, binding, { ticket, expiresAt, signal }),
  });
}
