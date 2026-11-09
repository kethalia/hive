import { describe, expect, it } from "vitest";
import { acceptanceDeploymentConfig } from "@/lib/delivery/acceptance-config.server";
import { acceptanceFixtureProducer } from "./acceptance-fixture";

const producer = {
  ...acceptanceFixtureProducer,
  permissionsDigest: "5cb0236664ba9833dc964200828cc6b650583eb0b7d2bd43d587889c5a9b175b",
};
const env = {
  HIVE_DELIVERY_ACCEPTANCE_ENABLED: "true",
  HIVE_DELIVERY_EXECUTION_ENABLED: "true",
  HIVE_DELIVERY_MANAGER_ENABLED: "true",
  HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED: "true",
  HIVE_DELIVERY_ACCEPTANCE_PRODUCER: JSON.stringify(producer),
};
describe("independent producer deployment selection", () => {
  it("preserves absence/default off and requires exact complete descriptor", () => {
    expect(acceptanceDeploymentConfig({})).toBeNull();
    expect(acceptanceDeploymentConfig(env)).toEqual(producer);
    for (const key of [
      "HIVE_DELIVERY_EXECUTION_ENABLED",
      "HIVE_DELIVERY_MANAGER_ENABLED",
      "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
    ])
      expect(() => acceptanceDeploymentConfig({ ...env, [key]: "false" })).toThrow();
  });
  it("rejects unknown permission/prompt/schema digests and caller additions", () => {
    for (const altered of [
      { ...producer, permissionsDigest: "a".repeat(64) },
      { ...producer, promptDigest: "a".repeat(64) },
      { ...producer, schemaDigest: "a".repeat(64) },
      { ...producer, allowTools: true },
    ])
      expect(() =>
        acceptanceDeploymentConfig({
          ...env,
          HIVE_DELIVERY_ACCEPTANCE_PRODUCER: JSON.stringify(altered),
        }),
      ).toThrow();
  });
});
