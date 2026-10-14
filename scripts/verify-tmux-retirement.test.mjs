import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("tmux retirement archives only the generated configuration and preserves user data", () => {
  const result = spawnSync("python3", ["-B", "scripts/tmux-retirement.test.py"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("all workspace profiles retire the snapshot installer and retain the plain tmux app", () => {
  for (const profile of [
    "ai-dev-k8s",
    "browser-testing",
    "game-dev",
    "electronics",
    "infrastructure",
  ]) {
    const root = new URL(`../templates/${profile}/`, import.meta.url);
    const terraform = readFileSync(new URL("main.tf", root), "utf8");
    const startup = readFileSync(new URL("scripts/init.sh", root), "utf8");
    assert.doesNotMatch(terraform, /module "tmux"|registry\.coder\.com\/anomaly\/tmux/);
    assert.match(terraform, /command\s*=\s*"tmux new-session -A -s default"/);
    assert.match(terraform, /from\s*=\s*module\.tmux\[0\]\.coder_app\.tmux_sessions\["default"\]/);
    assert.match(terraform, /to\s*=\s*coder_app\.tmux\[0\]/);
    assert.match(terraform, /tmux_snapshot_migration_script\s*=\s*file\(/);
    const migrationAt = startup.indexOf("tmux_snapshot_migration_script");
    assert.ok(migrationAt >= 0 && migrationAt < startup.indexOf("git_config_retry_script"));
  }
});
