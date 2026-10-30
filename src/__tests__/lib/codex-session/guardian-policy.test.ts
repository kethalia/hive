import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedGuardianHostConfig,
  guardianConfigBytes,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  GUARDIAN_METADATA_POLICY_DIGEST,
  guardianDeploymentPolicy,
} from "@/lib/codex-session/guardian-contracts";

const pin = {
  packageManifestSha256: "a".repeat(64),
  guardianElfSha256: "b".repeat(64),
  nodeSha256: "c".repeat(64),
  protocol: "guardian-v1",
  policyDigest: "d".repeat(64),
  metadataPolicyDigest: GUARDIAN_METADATA_POLICY_DIGEST,
};
describe("deployment-owned guardian approval", () => {
  it("fails closed without explicit enablement and a strict nonduplicated package allowlist", () => {
    expect(
      guardianDeploymentPolicy({ HIVE_GUARDIAN_APPROVED_PACKAGES_JSON: JSON.stringify([pin]) }),
    ).toMatchObject({ enabled: false, producerEnabled: false });
    for (const packages of [
      [],
      [pin, pin],
      [{ ...pin, metadataPolicyDigest: "0".repeat(64) }],
      [{ ...pin, allow: true }],
      [{ ...pin, protocol: "model-selected" }],
    ])
      expect(() =>
        guardianDeploymentPolicy({
          HIVE_GUARDIAN_ENABLED: "true",
          HIVE_GUARDIAN_APPROVED_PACKAGES_JSON: JSON.stringify(packages),
        }),
      ).toThrow();
    expect(
      guardianDeploymentPolicy({
        HIVE_GUARDIAN_ENABLED: "true",
        HIVE_GUARDIAN_APPROVED_PACKAGES_JSON: JSON.stringify([pin]),
      }),
    ).toMatchObject({ enabled: true, producerEnabled: false });
  });
  it("pins the exact protection descriptor exported by the installed namespace", () => {
    const url = pathToFileURL(
      resolve("templates/ai-dev-k8s/scripts/codex-native-namespace.mjs"),
    ).href;
    const digest = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const p=await import(${JSON.stringify(url)});process.stdout.write(p.METADATA_READ_ONLY_POLICY_DIGEST);`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" } },
    );
    expect(digest).toBe(GUARDIAN_METADATA_POLICY_DIGEST);
  });
  it("derives dynamic config bytes from verified app/build/issuer, matching the actual Python writer", () => {
    const key = generateKeyPairSync("ed25519");
    const binding = {
      coderOrigin: "https://coder.invalid",
      hiveUserId: randomUUID(),
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      buildId: randomUUID(),
      agentId: randomUUID(),
      templateId: randomUUID(),
      appOrigin: "https://app.invalid",
      appId: randomUUID(),
      projects: [],
    };
    const config = {
      privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      keyId: "fixture",
      hiveOrigin: "https://hive.invalid",
      softwareTemplateIds: [binding.templateId],
      appSlug: "codex-session",
      gatewayPort: 13341,
      cookieDomains: [],
    };
    const env = {
      HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
      HIVE_CODEX_MANAGER_EFFORT: "low",
      HIVE_DELIVERY_MANAGER_ENABLED: "true",
    };
    const expected = expectedGuardianHostConfig(binding, config, env);
    const python = execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        "import json,sys;sys.stdout.write(json.dumps(json.loads(sys.argv[1]),separators=(',',':'),sort_keys=True)+'\\n')",
        JSON.stringify(expected),
      ],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" } },
    );
    expect(guardianConfigBytes(expected)).toBe(python);
    expect(expected).not.toHaveProperty("deliveryExecutionEnabled");
    expect(
      guardianConfigSha256(
        expectedGuardianHostConfig(binding, config, {
          ...env,
          HIVE_DELIVERY_EXECUTION_ENABLED: "false",
        }),
      ),
    ).toBe(guardianConfigSha256(expected));
    const execution = expectedGuardianHostConfig(binding, config, {
      ...env,
      HIVE_DELIVERY_EXECUTION_ENABLED: "true",
    });
    expect(execution.deliveryExecutionEnabled).toBe(true);
    expect(guardianConfigSha256(execution)).not.toBe(guardianConfigSha256(expected));
    expect(() =>
      expectedGuardianHostConfig(binding, config, {
        ...env,
        HIVE_DELIVERY_MANAGER_ENABLED: "false",
        HIVE_DELIVERY_EXECUTION_ENABLED: "true",
      }),
    ).toThrow("requires manager");
    expect(expected).toMatchObject({
      guardianEnabled: true,
      nativeIsolationEnabled: true,
      managerEnabled: true,
    });
    expect(
      guardianConfigSha256(
        expectedGuardianHostConfig({ ...binding, buildId: randomUUID() }, config, env),
      ),
    ).not.toBe(guardianConfigSha256(expected));
    expect(
      guardianConfigSha256(
        expectedGuardianHostConfig(binding, { ...config, keyId: "rotated" }, env),
      ),
    ).not.toBe(guardianConfigSha256(expected));
  });
});
