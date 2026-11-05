import assert from "node:assert/strict";
import test from "node:test";
import { assertPilotEvidenceBucket, PILOT_EVIDENCE_BUCKET } from "./delivery-pilot-bucket.mjs";
import { ACCOUNT_ID } from "./deployment-plan.mjs";

const now = Date.now();
function fixture() {
  return {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    observedAt: new Date(now).toISOString(),
    bucket: { name: PILOT_EVIDENCE_BUCKET.name, creation_date: PILOT_EVIDENCE_BUCKET.creationDate },
    managed: { bucketId: PILOT_EVIDENCE_BUCKET.bucketId, enabled: false },
    custom: { domains: [] },
    lock: {
      rules: [
        {
          id: "hive-delivery-pilot-retention",
          enabled: true,
          prefix: "",
          condition: { type: "Age", maxAgeSeconds: 1800 },
        },
      ],
    },
  };
}
test("source evidence pins exact private task-created bucket and fresh retention", () => {
  assert.doesNotThrow(() => assertPilotEvidenceBucket(PILOT_EVIDENCE_BUCKET, fixture(), now));
  for (const m of [
    (x) => (x.managed.enabled = true),
    (x) => (x.managed.bucketId = "a".repeat(32)),
    (x) => (x.bucket.creation_date = new Date(now).toISOString()),
    (x) => (x.custom.domains = ["example.com"]),
    (x) => (x.lock.rules[0].condition.maxAgeSeconds = 0),
    (x) => (x.observedAt = new Date(now - 61000).toISOString()),
  ]) {
    const x = fixture();
    m(x);
    assert.throws(() => assertPilotEvidenceBucket(PILOT_EVIDENCE_BUCKET, x, now));
  }
});
