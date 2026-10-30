import assert from "node:assert/strict";
import test from "node:test";
import { portableActionManifest } from "./portable-actions-build.mjs";

const names = [
  "createWorkspaceAction",
  "startWorkspaceAction",
  "stopWorkspaceAction",
  "deleteWorkspaceAction",
];
const key = (index) => index.toString(16).padStart(42, "0");
function fixture() {
  return {
    encryptionKey: "synthetic-build-secret",
    node: Object.fromEntries(
      names.map((exportedName, index) => [
        key(index),
        {
          filename: "lib/actions/workspaces.ts",
          exportedName,
          workers: { "app/(dashboard)/workspaces/page": { moduleId: "synthetic", async: false } },
        },
      ]),
    ),
    edge: {},
  };
}
test("only reviewed exact exports from the built workspace page become portable", () => {
  const input = fixture();
  input.node[key(10)] = { ...input.node[key(0)], exportedName: "createSessionAction" };
  input.node[key(11)] = { ...input.node[key(0)], filename: "other/workspaces.ts" };
  const output = portableActionManifest(input);
  assert.equal(Object.keys(output.actions).length, 5);
  assert.equal(output.actions[key(10)].exportedName, "createSessionAction");
  assert.deepEqual(output.actions[key(0)].paths, ["/workspaces"]);
  assert.equal(output.actions[key(0)].maxBodyBytes, 65536);
  assert.ok(!JSON.stringify(output).includes(input.encryptionKey));
  assert.ok(!JSON.stringify(output).includes("moduleId"));
});
test("missing or changed framework action mappings fail the build closed", () => {
  const input = fixture();
  delete input.node[key(0)];
  assert.throws(() => portableActionManifest(input), /missing/);
  const noPage = fixture();
  noPage.node[key(0)].workers = { "app/other/page": {} };
  assert.throws(() => portableActionManifest(noPage), /missing/);
  const invalidId = fixture();
  invalidId.node.invalid = invalidId.node[key(0)];
  delete invalidId.node[key(0)];
  assert.throws(() => portableActionManifest(invalidId));
});

test("reviewed read actions are portable while terminal mutation stays excluded", () => {
  const input = fixture();
  const reads = [
    "getWorkspaceSessionsAction",
    "getExistingTerminalPathsAction",
    "getWorkspaceSessionToolsAction",
  ];
  for (const [i, exportedName] of [...reads, "renameSessionAction", "killSessionAction"].entries())
    input.node[key(20 + i)] = { ...input.node[key(0)], exportedName };
  const output = portableActionManifest(input);
  assert.equal(Object.keys(output.actions).length, 7);
  for (const name of reads)
    assert.ok(Object.values(output.actions).some((v) => v.exportedName === name));
  for (const action of Object.values(output.actions))
    assert.equal(
      action.maxBodyBytes,
      action.exportedName === "getExistingTerminalPathsAction" ? 786432 : 65536,
    );
  assert.ok(
    !Object.values(output.actions).some(
      (v) => v.exportedName === "killSessionAction" || v.exportedName === "renameSessionAction",
    ),
  );
});
