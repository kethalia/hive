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
  let path = home;
  for (const part of ["", ".local", "share", "hive", "codex-native"]) {
    if (part) {
      path = join(path, part);
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    const s = lstatSync(path);
    if (
      realpathSync(path) !== path ||
      !s.isDirectory() ||
      s.uid !== process.getuid() ||
      s.mode & 0o022
    )
      throw Error("managed_auth_unavailable");
  }
  const fd = openSync(
    join(path, "credential.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      s.mode & 0o077 ||
      s.size !== 0
    )
      throw Error("managed_auth_unavailable");
    execFileSync(
      "/usr/bin/flock",
      [mode === "shared" ? "--shared" : "--exclusive", "--nonblock", "3"],
      {
        stdio: ["ignore", "ignore", "ignore", fd],
        timeout: 2000,
      },
    );
    return {
      fd,
      close() {
        if (this.fd !== null) {
          closeSync(this.fd);
          this.fd = null;
        }
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
