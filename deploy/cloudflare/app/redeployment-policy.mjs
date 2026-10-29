import assert from "node:assert/strict";

/** Updating only the two task-created Workers requires an exact ownership chain. */
export function validatePreviewRedeployment(preflight, previous, accountId, workerNames) {
  assert.equal(previous.accountId, accountId);
  assert.match(previous.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(previous.probe.finalPassed, true);
  for (const [kind, name] of Object.entries(workerNames)) {
    const identity = previous.scriptIdentities.find((item) => item.name === name);
    const deployment = previous.workers[kind];
    const target = preflight.targets.find((item) => item.name === name);
    assert.ok(identity && deployment && target, "Missing preview ownership evidence");
    assert.equal(deployment.name, name);
    for (const id of [deployment.deploymentId, deployment.versionId])
      assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.match(identity.tag, /^[a-f0-9]{32}$/);
    assert.ok(Number.isFinite(Date.parse(identity.createdOn)));
    assert.equal(target.exists, true);
    assert.equal(target.tag, identity.tag, "Preview Worker identity changed");
    assert.equal(target.createdOn, identity.createdOn, "Preview Worker creation changed");
    assert.equal(target.deploymentId, deployment.deploymentId, "Preview deployment changed");
    assert.equal(target.versionId, deployment.versionId, "Preview version changed");
    for (const state of [target.publicState, previous.finalPublicState[kind]]) {
      assert.equal(state.enabled, false, "Preview must be private before preparation");
      assert.equal(state.previews_enabled, false);
    }
  }
  assert.ok(typeof previous.prepared.previewIdentityId === "string");
}
