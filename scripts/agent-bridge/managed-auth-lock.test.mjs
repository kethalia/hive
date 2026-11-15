import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, fstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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

// Unprivileged fixture: real private directories/fds/flock, only stat ownership
// metadata is substituted. Never chown/chmod HOME or open a real credential root.
async function withStatFixture(home, metadata, run, replacement) {
  const sourceUrl = new URL(
    "../../templates/ai-dev-k8s/scripts/codex-managed-auth-lock.mjs",
    import.meta.url,
  );
  let source = await readFile(sourceUrl, "utf8");
  const fixtureKey = `hiveAuthLockTest${randomUUID()}`,
    roots = new Set();
  const override = (s, fields = metadata) =>
    new Proxy(s, {
      get(target, key) {
        if (Object.hasOwn(fields, key)) return fields[key];
        return Reflect.get(target, key);
      },
    });
  let lockFd;
  globalThis[fixtureKey] = {
    lstat(path, real) {
      const s = real(path);
      return path === home
        ? override(s)
        : path === join(home, ".local") && metadata.descendant
          ? override(s, metadata.descendant)
          : s;
    },
    fstat(fd, real) {
      const s = real(fd);
      return roots.has(fd) ? override(s) : s;
    },
    open(path, flags, mode, real) {
      const fd = real(path, flags, mode);
      if (path === home) roots.add(fd);
      if (String(path).endsWith("/credential.lock")) {
        lockFd = fd;
        replacement?.();
      }
      return fd;
    },
  };
  for (const name of ["lstatSync", "fstatSync", "openSync"]) {
    assert(source.includes(`  ${name},`));
    source = source.replace(`  ${name},`, `  ${name} as native${name},`);
  }
  source += `\nconst fixture=globalThis[${JSON.stringify(fixtureKey)}];\nconst lstatSync=(p)=>fixture.lstat(p,nativelstatSync);\nconst fstatSync=(fd)=>fixture.fstat(fd,nativefstatSync);\nconst openSync=(p,f,m)=>fixture.open(p,f,m,nativeopenSync);\n`;
  try {
    const { acquireManagedAuthLock: acquire } = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    await run(acquire);
    if (replacement && lockFd !== undefined)
      assert.throws(() => fstatSync(lockFd), { code: "EBADF" });
  } finally {
    delete globalThis[fixtureKey];
  }
}

test("only the initial root-owned fsGroup HOME may be group-writable", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-auth-fsgroup-"));
  try {
    await withStatFixture(
      home,
      { uid: 0, gid: process.getgid(), mode: 0o042775 },
      async (acquire) => {
        const lock = acquire(home);
        lock.close();
      },
    );
    const foreign = Math.max(process.getgid(), ...process.getgroups()) + 10000;
    for (const metadata of [
      { uid: 0, gid: foreign, mode: 0o042775 },
      { uid: 0, gid: process.getgid(), mode: 0o042777 },
      { uid: process.getuid() + 10000, gid: process.getgid(), mode: 0o040755 },
    ])
      await withStatFixture(home, metadata, async (acquire) =>
        assert.throws(() => acquire(home), /managed_auth_unavailable/),
      );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fsGroup exception does not permit writable descendants or substituted HOME", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-auth-fsgroup-descendant-"));
  const link = `${home}-link`;
  try {
    mkdirSync(join(home, ".local"), { mode: 0o700 });
    chmodSync(join(home, ".local"), 0o770);
    await withStatFixture(
      home,
      { uid: 0, gid: process.getgid(), mode: 0o042775 },
      async (acquire) => {
        assert.throws(() => acquire(home), /managed_auth_unavailable/);
      },
    );
    chmodSync(join(home, ".local"), 0o700);
    await withStatFixture(
      home,
      {
        uid: 0,
        gid: process.getgid(),
        mode: 0o042775,
        descendant: { uid: 0, gid: process.getgid(), mode: 0o040755 },
      },
      async (acquire) => {
        assert.throws(() => acquire(home), /managed_auth_unavailable/);
      },
    );
    await symlink(home, link);
    assert.throws(() => acquireManagedAuthLock(link), /managed_auth_unavailable/);
  } finally {
    await rm(link, { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("directory replacement after lock open fails closed and closes the lock fd", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-auth-replacement-"));
  try {
    await withStatFixture(
      home,
      { uid: 0, gid: process.getgid(), mode: 0o042775 },
      async (acquire) => {
        assert.throws(() => acquire(home), /managed_auth_unavailable/);
      },
      () => {
        renameSync(join(home, ".local"), join(home, "retained-local"));
        symlinkSync(join(home, "retained-local"), join(home, ".local"));
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
