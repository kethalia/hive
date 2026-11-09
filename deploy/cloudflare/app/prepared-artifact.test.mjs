import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_ID, APP_NAME, AUTH_NAME } from "./deployment-plan.mjs";
import { assertPreparedArtifact } from "./prepared-artifact.mjs";

function fixture() {
  const configs = {
    app: {
      configSHA256: "app-config",
      secretFileSHA256: "app-secrets",
      secretNames: ["PREVIEW_BEARER"],
    },
    auth: {
      configSHA256: "auth-config",
      secretFileSHA256: "auth-secrets",
      secretNames: ["AUTH_SERVICE_SECRET"],
    },
  };
  const record = {
    accountId: ACCOUNT_ID,
    workerNames: [APP_NAME, AUTH_NAME],
    sourceRevision: "a".repeat(40),
    readinessSHA256: "ready",
    sourceInputSetSHA256: "source",
    artifactSetSHA256: "artifact",
    publicUrlsEnabled: false,
    additionalCostsAuthorized: false,
    maxScriptedRequests: 30,
    configs,
  };
  const current = {
    revision: record.sourceRevision,
    readinessSHA256: "ready",
    sourceInputSetSHA256: "source",
    artifactSetSHA256: "artifact",
    configs: structuredClone(configs),
  };
  return { record, current, check: () => assertPreparedArtifact(record, current) };
}
test("accepts the exact prepared source, outputs and private binding files", () => {
  fixture().check();
});
test("rejects old prepared configs after checkout advances or artifact changes", () => {
  for (const field of [
    "revision",
    "readinessSHA256",
    "sourceInputSetSHA256",
    "artifactSetSHA256",
  ]) {
    const f = fixture();
    f.current[field] = "changed";
    assert.throws(f.check);
  }
});
test("rejects mutated config, changed credential file or extra secret binding", () => {
  for (const mutate of [
    (current) => {
      current.configs.app.configSHA256 = "changed";
    },
    (current) => {
      current.configs.auth.secretFileSHA256 = "changed";
    },
    (current) => {
      current.configs.app.secretNames.push("OWNER_DATABASE_URL");
    },
  ]) {
    const f = fixture();
    mutate(f.current);
    assert.throws(f.check);
  }
});
