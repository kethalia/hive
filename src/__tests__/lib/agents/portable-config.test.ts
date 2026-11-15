import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { portableAccountConfig, portableAgentConfig } from "@/lib/agents/portable-config.server";

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
  it("rejects shared-host and unknown issuer modes before any managed runtime is introduced", () => {
    for (const mode of ["shared-host", "invalid"]) {
      expect(() => portableAgentConfig({ ...env, HIVE_WORKSPACE_ISSUER_MODE: mode })).toThrow();
    }
    expect(
      portableAgentConfig({ ...env, HIVE_WORKSPACE_ISSUER_MODE: "dedicated" }).privateKeyPem,
    ).toBe(key);
  });
});

it("account provider enablement does not enable generic tools or the other provider", () => {
  const scoped = { ...env, HIVE_AGENT_TOOLS_ENABLED: "false", HIVE_CODEX_ACCOUNTS_ENABLED: "true" };
  expect(portableAccountConfig("codex", scoped)).toMatchObject({
    accountProvider: "codex",
    issuer: env.HIVE_AGENT_TOOLS_HIVE_ORIGIN,
    pins: [pin],
  });
  expect(() => portableAgentConfig(scoped)).toThrow();
  expect(() => portableAccountConfig("claude", scoped)).toThrow();
  expect(() =>
    portableAccountConfig("codex", {
      ...scoped,
      HIVE_CODEX_ACCOUNTS_ENABLED: "false",
      HIVE_AGENT_TOOLS_ENABLED: "true",
    }),
  ).toThrow();
  expect(() =>
    portableAccountConfig("codex", { ...scoped, HIVE_AGENT_TOOLS_TRANSPORT: "ssh" }),
  ).toThrow();
  expect(
    portableAccountConfig("claude", { ...scoped, HIVE_CLAUDE_ACCOUNTS_ENABLED: "true" }),
  ).toMatchObject({ accountProvider: "claude" });
});
