import assert from "node:assert/strict";
import { ACCOUNT_ID, APP_NAME, AUTH_NAME } from "./deployment-plan.mjs";

export function assertPreparedArtifact(record, current) {
  assert.equal(record.accountId, ACCOUNT_ID);
  assert.deepEqual(record.workerNames, [APP_NAME, AUTH_NAME]);
  assert.match(record.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(record.sourceRevision, current.revision, "Prepared source revision changed");
  assert.equal(record.readinessSHA256, current.readinessSHA256, "Prepared readiness changed");
  assert.equal(record.sourceInputSetSHA256, current.sourceInputSetSHA256);
  assert.equal(record.artifactSetSHA256, current.artifactSetSHA256, "Prepared artifact changed");
  assert.equal(record.publicUrlsEnabled, false);
  assert.equal(record.additionalCostsAuthorized, false);
  for (const kind of ["app", "auth"]) {
    assert.equal(
      record.configs[kind].configSHA256,
      current.configs[kind].configSHA256,
      "Prepared config changed",
    );
    assert.equal(
      record.configs[kind].secretFileSHA256,
      current.configs[kind].secretFileSHA256,
      "Prepared secret binding file changed",
    );
    assert.deepEqual(record.configs[kind].secretNames, current.configs[kind].secretNames);
  }
}
