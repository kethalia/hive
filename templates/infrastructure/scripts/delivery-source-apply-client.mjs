// Fixed private metadata worker. No model-controlled process, path or environment.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const check = (value, code) => {
  if (!value) throw new Error(code);
};
const copy = structuredClone;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((k) => keys.includes(k));
const canonical = JSON.stringify;
export function runFixedSourceApplyWorker(start, exchange, options = {}) {
  check(
    exact(start, ["projectId", "repositoryId", "applicationId", "publicationOperationId"]) &&
      ["projectId", "applicationId", "publicationOperationId"].every(
        (k) => typeof start[k] === "string" && /^[a-f0-9-]{36}$/.test(start[k]),
      ) &&
      /^[1-9][0-9]{0,19}$/.test(start.repositoryId),
    "source_worker_configuration_invalid",
  );
  check(
    typeof exchange === "function" &&
      (options.timeoutMs === undefined ||
        (Number.isSafeInteger(options.timeoutMs) &&
          options.timeoutMs > 0 &&
          options.timeoutMs <= 120000)),
    "source_worker_configuration_invalid",
  );
  const child = spawn(
    "/usr/bin/python3",
    ["-I", fileURLToPath(new URL("./delivery-source-apply-worker.py", import.meta.url))],
    {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    },
  );
  return runApplyWorkerChannel(child, start, exchange, options);
}
// Explicit injected child is only a protocol fixture seam; the installed entry
// above has no child/path selection option and always launches the fixed sibling.
export function runApplyWorkerChannel(child, start, exchange, { timeoutMs = 120000, signal } = {}) {
  check(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000,
    "source_worker_configuration_invalid",
  );
  return new Promise((done, reject) => {
    const channel = child.stdio[3];
    if (!channel) {
      child.on("error", () => {});
      child.once("close", () => reject(new Error("source_worker_uncertain")));
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      return;
    }
    let active = true,
      buffer = Buffer.alloc(0),
      total = 0,
      frames = 0,
      lastId = 0,
      result = null,
      failure = null,
      chain = Promise.resolve();
    let stop;
    const stopped = new Promise((resolve) => {
      stop = resolve;
    });
    const execution = new AbortController();
    const kill = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    const fail = () => {
      if (failure) return;
      failure = new Error("source_worker_uncertain");
      active = false;
      execution.abort();
      stop();
      kill();
      channel?.destroy();
    };
    const send = (value) => {
      check(active, "source_worker_uncertain");
      const raw = Buffer.from(`${canonical(value)}\n`);
      total += raw.length;
      check(raw.length <= 65536 && total <= 8 * 1024 * 1024, "source_worker_protocol_limit");
      channel.write(raw);
    };
    const timer = setTimeout(fail, timeoutMs),
      abort = () => fail();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) fail();
    child.on("error", fail);
    child.once("exit", () => {
      // No descendant may keep an inherited protocol FD alive indefinitely.
      // Destroy only this channel; never signal a numeric group after reap.
      const closure = setTimeout(() => {
        channel.destroy();
        fail();
      }, 1000);
      closure.unref();
      child.once("close", () => clearTimeout(closure));
    });
    channel.on("error", fail);
    channel.on("data", (chunk) => {
      if (!active) return;
      try {
        total += chunk.length;
        check(total <= 8 * 1024 * 1024, "source_worker_protocol_limit");
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.includes(10)) {
          const end = buffer.indexOf(10);
          check(end < 65536 && ++frames <= 4096, "source_worker_protocol_limit");
          const raw = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          chain = chain
            .then(async () => {
              check(active && !result, "source_worker_protocol_invalid");
              const frame = JSON.parse(raw.toString("utf8"));
              check(
                exact(frame, ["schemaVersion", "type", "id", "value"]) &&
                  frame.schemaVersion === 1 &&
                  frame.id === lastId + 1,
                "source_worker_protocol_invalid",
              );
              lastId = frame.id;
              if (frame.type === "error") throw new Error("source_worker_failed");
              if (frame.type === "result") {
                check(
                  exact(frame.value, [
                    "applicationId",
                    "publicationOperationId",
                    "acceptedSource",
                  ]) &&
                    frame.value.applicationId === start.applicationId &&
                    frame.value.publicationOperationId === start.publicationOperationId,
                  "source_worker_protocol_invalid",
                );
                result = copy(frame.value);
                return;
              }
              check(
                ["authority", "input_barrier", "applied"].includes(frame.type),
                "source_worker_protocol_invalid",
              );
              const value = await Promise.race([
                exchange(frame.type, copy(frame.value), { signal: execution.signal }),
                stopped.then(() => {
                  throw new Error("source_worker_uncertain");
                }),
              ]);
              send({
                schemaVersion: 1,
                type: "response",
                id: frame.id,
                value,
              });
            })
            .catch(fail);
        }
        check(buffer.length <= 65536, "source_worker_protocol_limit");
      } catch {
        fail();
      }
    });
    child.once("close", async (code) => {
      await chain;
      const groupPresent = () => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return error.code !== "ESRCH";
        }
      };
      const reapDeadline = Date.now() + 1000;
      while (groupPresent() && Date.now() < reapDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (groupPresent()) failure = new Error("source_worker_group_unresolved");
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code !== 0 || failure || !result || buffer.length) {
        reject(failure ?? new Error("source_worker_uncertain"));
      } else done(result);
    });
    try {
      send({ schemaVersion: 1, type: "start", value: start });
    } catch {
      fail();
    }
  });
}
