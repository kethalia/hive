import assert from "node:assert/strict";
import test from "node:test";
import { verifyProviderBuildIdentity } from "./provider-build-identity.mjs";

const sha = "a".repeat(40),
  uuid = "00000000-0000-4000-8000-000000000001";
const env = {
  WORKERS_CI: "1",
  WORKERS_CI_COMMIT_SHA: sha,
  WORKERS_CI_BUILD_UUID: uuid,
  WORKERS_CI_BRANCH: "main",
};
test("provider source stamp verifies checkout and refuses mismatched or dirty sources", () => {
  assert.deepEqual(verifyProviderBuildIdentity(env, { sha, clean: true }), {
    schemaVersion: 1,
    status: "available",
    provider: "cloudflare-builds",
    sourceSha: sha,
    buildUuid: uuid,
    branch: "main",
  });
  for (const patch of [
    { WORKERS_CI_COMMIT_SHA: "b".repeat(40) },
    { WORKERS_CI_BUILD_UUID: "unknown" },
    { WORKERS_CI_BRANCH: "main;write" },
  ])
    assert.throws(() => verifyProviderBuildIdentity({ ...env, ...patch }, { sha, clean: true }));
  assert.throws(() => verifyProviderBuildIdentity(env, { sha, clean: false }));
});
test("local identity stays explicitly unavailable despite user-supplied identity-looking env fields", () => {
  assert.deepEqual(
    verifyProviderBuildIdentity(
      { ...env, WORKERS_CI: undefined, HIVE_NATIVE_BUILD_IDENTITY: "fake" },
      { sha, clean: true },
    ),
    { schemaVersion: 1, status: "unavailable", reason: "non_provider_build" },
  );
});
