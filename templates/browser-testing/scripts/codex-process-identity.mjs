// Linux process identity from the kernel, never argv, environment or ticket data.
import { readFileSync, readlinkSync, statSync } from "node:fs";
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("process_identity_unavailable");
  const root = `/proc/${pid}`;
  if (statSync(root).uid !== process.getuid()) throw new Error("process_identity_unavailable");
  const before = readFileSync(`${root}/stat`, "utf8");
  const fields = before
    .slice(before.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  const executable = readlinkSync(`${root}/exe`),
    info = statSync(`${root}/exe`, { bigint: true });
  if (
    fields[0] === "Z" ||
    !/^\d+$/.test(fields[19] ?? "") ||
    !executable.startsWith("/") ||
    executable.endsWith(" (deleted)") ||
    !info.isFile()
  )
    throw new Error("process_identity_unavailable");
  const after = readFileSync(`${root}/stat`, "utf8");
  if (
    after
      .slice(after.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/)[19] !== fields[19]
  )
    throw new Error("process_identity_changed");
  return {
    pid,
    startTime: fields[19],
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    executable,
    device: String(info.dev),
    inode: String(info.ino),
  };
}
