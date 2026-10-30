import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPackage, syncAgentPackage } from "./build-package.mjs";

test("agent package is deterministic and its published pins are current", async () => {
  const a = await agentPackage(),
    b = await agentPackage();
  assert.deepEqual(a.archive, b.archive);
  assert.deepEqual(a.compressed, b.compressed);
  assert.match(a.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(a.helperSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await syncAgentPackage(process.cwd(), true), a);
});
