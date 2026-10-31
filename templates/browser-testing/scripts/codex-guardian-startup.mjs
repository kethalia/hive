// Private installer startup channel. This is not a network authentication API.
import { readFileSync } from "node:fs";
import { Socket } from "node:net";

const check = (value) => {
  if (!value) throw new Error("guardian_startup_rejected");
};
const digest = /^[a-f0-9]{64}$/;
export function guardianStartChallenge(value) {
  check(
    value &&
      Object.keys(value).sort().join() ===
        "configSha256,nodeSha256,nonce,packageManifestSha256,port,schemaVersion,type",
  );
  check(
    value.schemaVersion === 1 &&
      value.type === "start" &&
      typeof value.nonce === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.nonce) &&
      Buffer.from(value.nonce, "base64url").toString("base64url") === value.nonce &&
      [value.configSha256, value.nodeSha256, value.packageManifestSha256].every(
        (v) => typeof v === "string" && digest.test(v),
      ) &&
      Number.isInteger(value.port) &&
      value.port >= 1024 &&
      value.port <= 65535,
  );
  return structuredClone(value);
}

// The guardian becomes nondumpable after its executable identity is pinned.
// Refresh only kernel identity/parent fields here; never substitute another PID
// or attempt to recover an inaccessible executable through a descendant.
export function guardianKernelIdentity(identity, parentPid) {
  check(identity && Number.isSafeInteger(identity.pid) && identity.pid > 0);
  const root = `/proc/${identity.pid}`;
  // Nondumpable processes have root-owned proc inodes; real/effective/saved
  // kernel UIDs, rather than proc-directory ownership, identify this process.
  const uids = readFileSync(`${root}/status`, "utf8").match(
    /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m,
  );
  check(uids?.slice(1).every((value) => Number(value) === process.getuid()));
  const text = readFileSync(`${root}/stat`, "utf8");
  const fields = text
    .slice(text.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  check(
    !["Z", "X"].includes(fields[0]) &&
      fields[19] === identity.startTime &&
      /^\d+$/.test(fields[1] ?? "") &&
      Number(fields[1]) === parentPid &&
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === identity.bootId,
  );
  return { ...identity, parentPid };
}

export async function readGuardianStart({ fd = 3, stream, timeoutMs = 5000 } = {}) {
  check(fd === 3 && timeoutMs > 0 && timeoutMs <= 5000);
  const socket = stream ?? new Socket({ fd, readable: true, writable: true });
  let buffer = Buffer.alloc(0),
    completed = false,
    failed = false,
    sent = false;
  let rejectStart;
  const fail = () => {
    if (failed) return;
    failed = true;
    socket.destroy();
    rejectStart?.(new Error("guardian_startup_channel_lost"));
  };
  const challenge = await new Promise((resolve, reject) => {
    rejectStart = reject;
    const timer = setTimeout(fail, timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.on("error", fail);
    socket.on("end", () => {
      if (!sent) fail();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!sent) fail();
    });
    socket.on("data", (chunk) => {
      try {
        check(!completed && !failed);
        buffer = Buffer.concat([buffer, chunk]);
        check(buffer.length <= 32768);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        check(end > 0 && end === buffer.length - 1);
        const value = guardianStartChallenge(JSON.parse(buffer.subarray(0, end)));
        completed = true;
        finish(value);
      } catch {
        fail();
      }
    });
  });
  return {
    challenge,
    async ready(value) {
      check(
        !failed &&
          !sent &&
          value?.type === "ready" &&
          ["nonce", "configSha256", "packageManifestSha256", "nodeSha256", "port"].every(
            (k) => value[k] === challenge[k],
          ),
      );
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      check(bytes.length <= 32768);
      sent = true;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail();
          reject(new Error("guardian_startup_channel_lost"));
        }, 5000);
        socket.end(bytes, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    close: () => socket.destroy(),
  };
}
