import assert from "node:assert/strict";
import { ACCOUNT_ID } from "./deployment-plan.mjs";

export const PILOT_EVIDENCE_BUCKET = Object.freeze({
  name: "hive-delivery-pilot-20261105",
  creationDate: "2026-11-05T17:01:05.489Z",
  bucketId: "58e5cd7186cb490e9ee21f814a27ac9d",
});
export function assertPilotEvidenceBucket(identity, readback, now = Date.now()) {
  assert.deepEqual(identity, PILOT_EVIDENCE_BUCKET);
  assert.equal(readback.schemaVersion, 1);
  assert.equal(readback.accountId, ACCOUNT_ID);
  const age = now - Date.parse(readback.observedAt);
  assert.ok(Number.isFinite(age) && age >= -5000 && age <= 60000);
  assert.equal(readback.bucket.name, identity.name);
  assert.equal(readback.bucket.creation_date, identity.creationDate);
  assert.equal(readback.managed.bucketId, identity.bucketId);
  assert.equal(readback.managed.enabled, false);
  assert.deepEqual(readback.custom.domains, []);
  assert.deepEqual(readback.lock.rules, [
    {
      id: "hive-delivery-pilot-retention",
      enabled: true,
      prefix: "",
      condition: { type: "Age", maxAgeSeconds: 1800 },
    },
  ]);
}
