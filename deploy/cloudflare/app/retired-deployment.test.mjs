import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const [script, args] of [
  ["deploy-prepared.mjs", ["/nonexistent/manifest.json", "app"]],
  ["deploy-prepared.mjs", ["/nonexistent/manifest.json", "auth"]],
  ["deploy-delivery-pilot-jobs.mjs", ["/nonexistent/manifest.json", "create"]],
  ["deploy-delivery-pilot-jobs.mjs", ["/nonexistent/manifest.json", "enable"]],
]) {
  test(`${script} ${args.at(-1)} refuses live recreation before artifact or provider access`, () => {
    const result = spawnSync(
      process.execPath,
      [new URL(script, import.meta.url).pathname, ...args, "--deploy"],
      {
        encoding: "utf8",
        env: { PATH: "/nonexistent" },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Retired compatibility Workers cannot be deployed/);
    assert.equal(result.stdout, "");
  });
}
