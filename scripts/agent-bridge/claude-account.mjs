import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { createAccountManager, createAccountWire } from "./codex-account.mjs";

/** Official linux-x64 release manifests. Unknown refreshed versions never
 * silently inherit a known login framing contract. No updater runs here. */
export const CLAUDE_RELEASES = Object.freeze({
  "2.1.312": {
    size: 293592432,
    sha256: "4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d",
  },
  "2.1.319": {
    size: 340226576,
    sha256: "dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed",
  },
});
const verified = new Map();
export function verifyClaudeExecutable(home) {
  const executable = realpathSync(join(home, ".local/bin/claude"));
  const version = basename(executable),
    pin = CLAUDE_RELEASES[version];
  if (!pin || executable !== join(home, ".local/share/claude/versions", version))
    throw Error("claude_runtime_unavailable");
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd, { bigint: true });
    if (
      !s.isFile() ||
      s.uid !== BigInt(process.getuid()) ||
      s.mode & 0o022n ||
      s.nlink !== 1n ||
      s.size !== BigInt(pin.size)
    )
      throw Error("claude_runtime_unavailable");
    const stamp = [s.dev, s.ino, s.ctimeNs, s.mtimeNs, s.size].join(":");
    if (verified.get(executable) !== stamp) {
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(1024 * 1024);
      let bytes = 0;
      for (;;) {
        const count = readSync(fd, buffer);
        if (count === 0) break;
        bytes += count;
        if (bytes > pin.size) throw Error();
        hash.update(buffer.subarray(0, count));
      }
      const final = fstatSync(fd, { bigint: true });
      if (
        bytes !== pin.size ||
        hash.digest("hex") !== pin.sha256 ||
        final.ctimeNs !== s.ctimeNs ||
        final.mtimeNs !== s.mtimeNs
      )
        throw Error("claude_runtime_unavailable");
      if (verified.size >= 8) verified.clear();
      verified.set(executable, stamp);
    }
    return executable;
  } finally {
    closeSync(fd);
  }
}

/** Configuration comes only from the existing pinned bridge environment. A
 * client cannot select the CLI, home, config directory, origin or command. */
function acquireClaudeLock(directory) {
  if (!isAbsolute(directory) || directory.length > 4096) throw Error();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync(directory),
    s = lstatSync(root);
  if (!s.isDirectory() || s.uid !== process.getuid() || s.mode & 0o022) throw Error();
  const fd = openSync(
    join(root, ".hive-account.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const f = fstatSync(fd);
    if (
      !f.isFile() ||
      f.uid !== process.getuid() ||
      f.nlink !== 1 ||
      f.mode & 0o077 ||
      f.size !== 0
    )
      throw Error();
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout: 2000,
    });
    return {
      fd,
      directory: root,
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

export async function openClaudeSession(home, fd, notify, directory, source) {
  const executable = verifyClaudeExecutable(home);
  if (typeof source !== "string" || Buffer.byteLength(source) > 32768) throw Error();
  const guard =
    "import ctypes,os,signal,sys\np=int(sys.argv[1])\nr=ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)\nif r!=0 or os.getppid()!=p: sys.exit(1)\n";
  const child = spawn("/usr/bin/python3", ["-I", "-B", "-c", guard + source, String(process.pid)], {
    cwd: home,
    stdio: ["pipe", "pipe", "ignore", fd],
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: directory,
      HIVE_CLAUDE_EXECUTABLE: executable,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      TERM: "dumb",
      BROWSER: "/usr/bin/false",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });
  const wire = createAccountWire(child, notify, { codeInput: true });
  try {
    if ((await wire.call("initialize"))?.protocol !== "hive-claude-cli-auth-v1") throw Error();
    return wire;
  } catch (error) {
    await wire.close();
    throw error;
  }
}

export function createClaudeAccountManager({
  home,
  lifetimeId,
  profile,
  configDirectory = join(home, ".claude"),
  driverSource,
  ...dependencies
}) {
  let directory;
  return createAccountManager({
    home,
    lifetimeId,
    profile,
    provider: "claude",
    acquire() {
      const lock = acquireClaudeLock(configDirectory);
      directory = lock.directory;
      return lock;
    },
    open: (root, fd, notify) => openClaudeSession(root, fd, notify, directory, driverSource()),
    ...dependencies,
  });
}
