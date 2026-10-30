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
});
