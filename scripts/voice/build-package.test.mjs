import assert from "node:assert/strict";
import { test } from "node:test";
import { voicePackage } from "./build-package.mjs";

test("voice package is deterministic and pins its bundled source", async () => {
  const a = await voicePackage(),
    b = await voicePackage();
  assert.deepEqual(a.archive, b.archive);
  assert.deepEqual(a.compressed, b.compressed);
  assert.match(a.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(a.manifestSha256, /^[a-f0-9]{64}$/);
});
