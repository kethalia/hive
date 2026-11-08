import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireManagedAuthLock } from "../../templates/ai-dev-k8s/scripts/codex-managed-auth-lock.mjs";

test("native/auth mutual exclusion follows the inherited child fd after parent release", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-auth-lock-"));
  let child;
  try {
    const first = acquireManagedAuthLock(home);
    assert.throws(() => acquireManagedAuthLock(home));
    child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore", first.fd] },
    );
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    first.close(); // Models the parent dying; child keeps the exact open description.
    assert.throws(() => acquireManagedAuthLock(home));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    child = null;
    const next = acquireManagedAuthLock(home);
    next.close();
  } finally {
    child?.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
test("managed credential roots reject symlink substitution without touching default CLI home", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-auth-root-"));
  try {
    await symlink(tmpdir(), join(home, ".local"));
    assert.throws(() => acquireManagedAuthLock(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("multiple native readers coexist while either one prevents account mutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-auth-readers-"));
  let one, two;
  try {
    one = acquireManagedAuthLock(home, "shared");
    two = acquireManagedAuthLock(home, "shared");
    assert.throws(() => acquireManagedAuthLock(home));
    one.close();
    assert.throws(() => acquireManagedAuthLock(home));
    two.close();
    const auth = acquireManagedAuthLock(home);
    assert.throws(() => acquireManagedAuthLock(home, "shared"));
    auth.close();
    assert.throws(() => acquireManagedAuthLock(home, "unrecognized"));
  } finally {
    one?.close();
    two?.close();
    await rm(home, { recursive: true, force: true });
  }
});
