// Bounded diagnostic sink for the fixture-only ESM loader. No raw stderr is saved.
import { readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

let sequence = 0;
const code = (value) =>
  typeof value === "string" && /^[A-Z_0-9]{1,40}$/.test(value) ? value : "other";
function identity(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const wchan = readFileSync(`/proc/${pid}/wchan`, "utf8").trim();
    return {
      pid,
      parentPid: Number(parts[1]),
      startTime: parts[19],
      state: parts[0],
      wchan: /^[a-zA-Z0-9_.]{1,80}$/.test(wchan) ? wchan : "other",
    };
  } catch {
    return { pid, unavailable: true };
  }
}
function threadWaits(processes) {
  return processes.map(({ pid, startTime, parentPid }) => {
    const waits = {},
      blocked = [];
    try {
      const current = identity(pid);
      if (current.startTime !== startTime || current.parentPid !== parentPid)
        return { pid, changed: true };
      const tids = readdirSync(`/proc/${pid}/task`);
      for (const tid of tids.slice(0, 128)) {
        if (!/^[0-9]+$/.test(tid)) continue;
        let key = "unavailable";
        try {
          const wchan = readFileSync(`/proc/${pid}/task/${tid}/wchan`, "utf8").trim();
          key = /^[a-zA-Z0-9_.]{1,80}$/.test(wchan) ? wchan : "other";
          if (/jbd2|folio|io_schedule|wait_on_page|balance_dirty/.test(key)) {
            const fields = readFileSync(`/proc/${pid}/task/${tid}/syscall`, "utf8")
              .trim()
              .split(/\s+/);
            const syscall = Number(fields[0]);
            let fdCategory = "not_captured",
              fdDevice = null;
            // Only fsync/fdatasync descriptor arguments. Never save pointers,
            // syscall buffers, descriptor contents or arbitrary filenames.
            if ([74, 75].includes(syscall)) {
              const path = readlinkSync(`/proc/${pid}/fd/${Number(fields[1])}`);
              const stat = statSync(`/proc/${pid}/fd/${Number(fields[1])}`);
              fdDevice = String(stat.dev);
              fdCategory = stat.isDirectory()
                ? "directory"
                : /\.sqlite(?:-wal|-shm)?$/.test(path)
                  ? "sqlite"
                  : /\/logs?\//.test(path)
                    ? "log"
                    : /\.toml$/.test(path)
                      ? "toml"
                      : /\.json$/.test(path)
                        ? "json"
                        : "other_regular";
            }
            blocked.push({
              tid: Number(tid),
              wchan: key,
              syscall: Number.isInteger(syscall) ? syscall : null,
              fdCategory,
              fdDevice,
            });
          }
        } catch {}
        waits[key] = (waits[key] ?? 0) + 1;
      }
      return { pid, threadCount: tids.length, waits, blocked };
    } catch {
      return { pid, unavailable: true };
    }
  });
}
function descendants(root, expectedStart) {
  const first = identity(root);
  if (first.parentPid !== process.pid || first.startTime !== expectedStart) return [];
  const found = [first];
  for (let i = 0; i < found.length && found.length < 5; i++) {
    try {
      const ids = readFileSync(`/proc/${found[i].pid}/task/${found[i].pid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map(Number);
      for (const pid of ids) {
        const child = identity(pid);
        if (child.parentPid === found[i].pid) found.push(child);
      }
    } catch {}
  }
  return found.slice(0, 5);
}
export function startupObserver(source) {
  const directory = process.env.HIVE_NATIVE_STARTUP_DIAGNOSTICS;
  if (!directory?.startsWith("/tmp/hive-native-startup-"))
    throw new Error("diagnostic_directory_required");
  const started = performance.now();
  const result = {
    schemaVersion: 1,
    hostPid: process.pid,
    sequence: ++sequence,
    ...source,
    events: [],
    stderrBytes: 0,
    stderrTruncated: false,
  };
  const path = join(directory, `${process.pid}-${sequence}.json`);
  let rootStart;
  const event = (type, fields = {}) => {
    if (result.events.length < 800)
      result.events.push({
        ms: Math.round((performance.now() - started) * 1000) / 1000,
        type,
        ...fields,
      });
  };
  const save = () => writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.once("exit", save);
  return {
    event,
    spawned(child, endpoint) {
      const root = identity(child.pid);
      rootStart = root.startTime;
      event("spawn", { port: Number(new URL(endpoint).port), ...root });
      let raw = "";
      const classify = (line) => {
        const categories = [];
        if (/WebSocket|websocket|ws:\/\//.test(line) && /listen/i.test(line))
          categories.push("websocket_listening");
        if (/alias/.test(line) && /Read-only|read.only|Permission denied/.test(line))
          categories.push("alias_read_only");
        if (/bwrap/.test(line)) categories.push("bwrap_mentioned");
        if (/ERROR|error:|panicked/.test(line)) categories.push("error_mentioned");
        if (/Address already in use/.test(line)) categories.push("address_in_use");
        if (categories.length) event("stderr", { categories });
      };
      child.stderr.on("data", (chunk) => {
        const remaining = Math.max(0, 16384 - result.stderrBytes);
        result.stderrBytes += Math.min(chunk.length, remaining);
        result.stderrTruncated ||= chunk.length > remaining;
        raw += chunk.subarray(0, remaining).toString();
        const lines = raw.split("\n");
        raw = lines.pop();
        for (const line of lines) classify(line);
      });
      child.once("exit", (exitCode, signal) => {
        event("exit", { exitCode, signal });
        save();
      });
      child.once("error", (error) => {
        event("child_error", { code: code(error.code) });
        save();
      });
    },
    poll(child, attempt) {
      const processes = descendants(child.pid, rootStart);
      event("poll", { attempt, processes });
      if ([10, 20, 30, 39].includes(attempt))
        event("thread_waits", { attempt, processes: threadWaits(processes) });
    },
    socketError(error, attempt) {
      event("websocket_error", {
        attempt,
        code: code(error.code),
        category: /timed out/i.test(error.message)
          ? "handshake_timeout"
          : /Unexpected server response/.test(error.message)
            ? "http_rejection"
            : "connection_error",
      });
    },
  };
}
