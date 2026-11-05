import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const waitScript = resolve("templates/ai-dev-k8s/scripts/wait-for-codex.sh");

test("Codex module waits for Hive's working CLI without changing its config", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "hive-codex-order-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, "config.toml"),
    executable = join(home, "codex");
  writeFileSync(config, "user-owned settings\n");
  // An executable shim alone is not readiness: its version command must work.
  writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const pending = run("/bin/bash", [waitScript], {
    env: { HOME: home, PATH: `${home}:/usr/bin:/bin` },
    timeout: 5000,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  writeFileSync(executable, "#!/bin/sh\nprintf 'codex fixture\\n'\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
  await pending;
  assert.equal(readFileSync(config, "utf8"), "user-owned settings\n");
  const template = readFileSync("templates/ai-dev-k8s/main.tf", "utf8");
  assert.match(
    template,
    /pre_install_script\s*=\s*file\("\$\{path\.module\}\/scripts\/wait-for-codex\.sh"\)/,
  );
  assert.match(template, /manage_config\s*=\s*false/);
});
