import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const [file, count] of [
  ["test_workspace_read.py", 9],
  ["test_workspace_read_install.py", 8],
  ["test_workspace_read_bootstrap.py", 5],
  ["test_workspace_identity_install.py", 4],
  ["test_workspace_image_preview.py", 4],
])
  test(`workspace read Python boundary: ${file}`, () => {
    const result = spawnSync("/usr/bin/python3", ["-B", `scripts/agents/${file}`], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1048576,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, new RegExp(`Ran ${count} tests`));
    assert.match(result.stderr, /\nOK\b/);
  });
