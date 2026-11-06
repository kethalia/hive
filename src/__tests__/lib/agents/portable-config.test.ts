import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { portableAgentConfig } from "@/lib/agents/portable-config.server";

const key = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const pin = {
  templateId: randomUUID(),
  profile: "software",
  manifestSha256: "a".repeat(64),
  helperSha256: "b".repeat(64),
};
const env = {
  HIVE_AGENT_TOOLS_ENABLED: "true",
  HIVE_AGENT_TOOLS_TRANSPORT: "workspace-app",
  HIVE_AGENT_TOOLS_HIVE_ORIGIN: "https://hive.example",
  HIVE_AGENT_TOOLS_ISSUER_KEY_ID: "test",
  HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY: key,
  HIVE_AGENT_TOOLS_PINS_JSON: JSON.stringify([pin]),
};
describe("portable agent configuration", () => {
  it("requires explicit enablement and a valid issuer and exact template pin", () => {
    expect(portableAgentConfig(env).pins).toEqual([pin]);
    for (const changed of [
      { HIVE_AGENT_TOOLS_ENABLED: "false" },
      { HIVE_AGENT_TOOLS_TRANSPORT: "ssh" },
      { HIVE_AGENT_TOOLS_HIVE_ORIGIN: "http://hive.example" },
      { HIVE_AGENT_TOOLS_PINS_JSON: JSON.stringify([pin, pin]) },
      { HIVE_AGENT_TOOLS_PINS_JSON: JSON.stringify([{ ...pin, helperSha256: "wrong" }]) },
    ])
      expect(() => portableAgentConfig({ ...env, ...changed })).toThrow();
  });
  it("shares the host key only for exactly the enrolled software issuer", () => {
    const pair = generateKeyPairSync("ed25519");
    const shared = {
      ...env,
      HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY: "",
      HIVE_WORKSPACE_ISSUER_MODE: "shared-host",
      HIVE_CODEX_GATEWAY_ENABLED: "true",
      HIVE_CODEX_HIVE_ORIGIN: "https://hive.example",
      HIVE_CODEX_ISSUER_KEY_ID: "test",
      HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: pin.templateId,
      HIVE_CODEX_ISSUER_PRIVATE_KEY: pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      HIVE_CODEX_ISSUER_PUBLIC_KEY: pair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    };
    expect(portableAgentConfig(shared).privateKeyPem).toBe(shared.HIVE_CODEX_ISSUER_PRIVATE_KEY);
    for (const change of [
      { HIVE_CODEX_HIVE_ORIGIN: "https://other.example" },
      { HIVE_CODEX_ISSUER_KEY_ID: "other" },
      { HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: randomUUID() },
      { HIVE_CODEX_GATEWAY_ENABLED: "false" },
      { HIVE_WORKSPACE_ISSUER_MODE: "invalid" },
      { HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY: key },
      { HIVE_AGENT_TOOLS_PINS_JSON: JSON.stringify([{ ...pin, profile: "browser" }]) },
      {
        HIVE_CODEX_ISSUER_PUBLIC_KEY: generateKeyPairSync("ed25519")
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
      },
    ])
      expect(() => portableAgentConfig({ ...shared, ...change })).toThrow();
  });
});
