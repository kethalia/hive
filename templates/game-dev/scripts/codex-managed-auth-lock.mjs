import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";

/** Shared by managed native execution and the auth-only CLI. Never use the
 * user's default CODEX_HOME. flock belongs to the open description; inheriting
 * fd into the child keeps the fence even if its parent crashes. */
export function acquireManagedAuthLock(home, mode = "exclusive") {
  if (!["shared", "exclusive"].includes(mode)) throw Error("managed_auth_unavailable");
  const uid = process.getuid(),
    groups = new Set([process.getgid(), ...process.getgroups()]);
  const directories = [];
  let path = home,
    fd;
  const reject = () => {
    throw Error("managed_auth_unavailable");
  };
  const valid = (s, initial) =>
    s.isDirectory() &&
    !(s.mode & 0o002) &&
    ((s.uid === uid && !(s.mode & 0o022)) || (initial && s.uid === 0 && groups.has(s.gid)));
  const same = (a, b) =>
    a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
  try {
    for (const part of ["", ".local", "share", "hive", "codex-native"]) {
      const initial = !part;
      const anchored = initial ? path : `/proc/self/fd/${directories.at(-1).fd}/${part}`;
      if (part) {
        path = join(path, part);
        try {
          mkdirSync(anchored, { mode: 0o700 });
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
      const before = lstatSync(path);
      if (realpathSync(path) !== path || !valid(before, initial)) reject();
      const directory = openSync(
        anchored,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directories.push({ path, fd: directory, initial });
      const opened = fstatSync(directory);
      if (!valid(opened, initial) || !same(before, opened)) reject();
    }
    // Follow the held directory, never a substituted intermediate path.
    const lockPath = `/proc/self/fd/${directories.at(-1).fd}/credential.lock`;
    fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== uid || s.nlink !== 1 || s.mode & 0o077 || s.size !== 0) reject();
    execFileSync(
      "/usr/bin/flock",
      [mode === "shared" ? "--shared" : "--exclusive", "--nonblock", "3"],
      {
        stdio: ["ignore", "ignore", "ignore", fd],
        timeout: 2000,
      },
    );
    if (!same(s, lstatSync(lockPath))) reject();
    for (const directory of directories) {
      const current = lstatSync(directory.path),
        held = fstatSync(directory.fd);
      if (
        realpathSync(directory.path) !== directory.path ||
        !valid(current, directory.initial) ||
        !same(current, held)
      )
        reject();
    }
    const acquired = fd;
    fd = undefined;
    return {
      fd: acquired,
      close() {
        if (this.fd !== null) {
          closeSync(this.fd);
          this.fd = null;
        }
      },
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
    for (const directory of directories.reverse()) closeSync(directory.fd);
  }
}
