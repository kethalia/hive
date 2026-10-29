// Internal installed-host building block. No public route, cleanup or signing authority.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { processIdentity, processParentPid } from "./codex-process-identity.mjs";

const MAX_FRAME = 32768;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const allowedEnv = new Set([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "HIVE_NATIVE_CODEX_TOKEN",
]);
const hostEnv = new Set([
  "HIVE_WORKSPACE_PROFILE",
  "CODER_AGENT_TOKEN",
  "CODER_AGENT_TOKEN_FILE",
  "CODER_AGENT_URL",
]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw new Error("guardian_contract_rejected");
};
function check(value) {
  if (!value) fail();
}
class Encoding {
  chunks = [];
  u32(value) {
    check(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value);
    this.chunks.push(b);
    return this;
  }
  u64(value) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(value));
    this.chunks.push(b);
    return this;
  }
  str(value) {
    check(typeof value === "string" && !value.includes("\0"));
    const b = Buffer.from(value);
    check(b.length <= 4096);
    this.u32(b.length);
    this.chunks.push(b);
    return this;
  }
  result() {
    const b = Buffer.concat(this.chunks);
    check(b.length <= MAX_FRAME);
    return b;
  }
}
function pin(path, expectedSha256) {
  check(
    typeof path === "string" &&
      path.startsWith("/") &&
      realpathSync(path) === path &&
      digest.test(expectedSha256),
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    check(
      before.isFile() &&
        [0n, BigInt(process.getuid())].includes(before.uid) &&
        !(before.mode & 0o22n),
    );
    const bytes = readFileSync(fd);
    check(
      bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha(bytes) === expectedSha256,
    );
    const after = fstatSync(fd, { bigint: true });
    check(
      before.ino === after.ino &&
        before.dev === after.dev &&
        before.ctimeNs === after.ctimeNs &&
        before.mtimeNs === after.mtimeNs &&
        before.size === after.size,
    );
    return { fd, stat: after, path, sha256: expectedSha256 };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function rootDescriptor(root) {
  check(
    root &&
      /^[a-z0-9_-]{1,64}$/.test(root.id) &&
      ["native", "tmux", "terminal", "host"].includes(root.role) &&
      (root.role !== "host" || root.workerChannel === true) &&
      (root.workerChannel === undefined || root.workerChannel === true),
  );
  check(
    Array.isArray(root.args) &&
      root.args.length < 128 &&
      root.args.every(
        (v) => typeof v === "string" && !v.includes("\0") && Buffer.byteLength(v) <= 4096,
      ),
  );
  check(
    typeof root.cwd === "string" && root.cwd.startsWith("/") && realpathSync(root.cwd) === root.cwd,
  );
  const executable = pin(root.executable, root.sha256);
  let cwd;
  try {
    cwd = openSync(root.cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directory = fstatSync(cwd);
    check(
      directory.isDirectory() && directory.uid === process.getuid() && !(directory.mode & 0o22),
    );
    const env = Object.entries(root.env ?? {});
    check(
      env.length <= 16 &&
        env.every(
          ([k, v]) =>
            (allowedEnv.has(k) || (root.role === "host" && hostEnv.has(k))) &&
            (k !== "HIVE_WORKSPACE_PROFILE" || v === "software") &&
            typeof v === "string" &&
            !v.includes("\0") &&
            Buffer.byteLength(`${k}=${v}`) <= 4096,
        ),
    );
    return {
      ...root,
      executable,
      cwd,
      argv: [root.executable, ...root.args],
      environment: env.map(([k, v]) => `${k}=${v}`),
    };
  } catch (error) {
    closeSync(executable.fd);
    if (cwd !== undefined) closeSync(cwd);
    throw error;
  }
}
function encodeBootstrap(
  lifetimeId,
  bindingDigest,
  ownershipDigest,
  launchSetDigest,
  projects,
  roots,
) {
  const e = new Encoding()
    .u32(1)
    .str(lifetimeId)
    .str(bindingDigest)
    .str(ownershipDigest)
    .str(launchSetDigest)
    .u32(projects.length);
  for (const p of projects) e.str(p.projectId).str(p.bindingDigest);
  e.u32(roots.length);
  roots.forEach((root, index) => {
    const s = root.executable.stat;
    e.str(root.id)
      .u32({ native: 1, tmux: 2, terminal: 3, host: 4 }[root.role])
      .u32(4 + index * 2)
      .u32(5 + index * 2)
      .u64(s.dev)
      .u64(s.ino)
      .u64(s.size)
      .u32(Number(s.mode))
      .u32(Number(s.uid))
      .u64(s.mtimeNs / 1000000000n)
      .u32(Number(s.mtimeNs % 1000000000n))
      .u64(s.ctimeNs / 1000000000n)
      .u32(Number(s.ctimeNs % 1000000000n))
      .u32(root.argv.length);
    for (const v of root.argv) e.str(v);
    e.u32(root.environment.length);
    for (const v of root.environment) e.str(v);
  });
  const workerIndex = roots.findIndex((root) => root.workerChannel);
  if (workerIndex >= 0)
    e.u32(1)
      .u32(workerIndex)
      .u32(4 + roots.length * 2);
  return e.result();
}

export class NativeGuardian {
  #child;
  #channel;
  #options;
  #roots;
  #binding;
  #sequence = 0;
  #buffer = Buffer.alloc(0);
  #pending;
  #queue = Promise.resolve();
  #phase = "starting";
  #failure;
  #failureJournal;
  #generation = 1;
  #closedRequestId;
  #identity;
  #exited;
  constructor(child, options, roots, binding) {
    this.#child = child;
    this.#channel = child.stdio[3];
    this.#options = options;
    this.#roots = roots;
    this.#binding = binding;
    this.#exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
        if (!["acknowledging", "closed"].includes(this.#phase))
          this.#reject("guardian_lifetime_lost");
      }),
    );
    child.once("error", () => this.#reject("guardian_start_failed"));
    this.#channel.on("error", () => this.#reject("guardian_channel_lost"));
    this.#channel.on("end", () => {
      if (!["acknowledging", "closed"].includes(this.#phase)) this.#reject("guardian_channel_lost");
    });
    this.#channel.on("data", (data) => {
      try {
        this.#buffer = Buffer.concat([this.#buffer, data]);
        check(this.#buffer.length <= MAX_FRAME + 4);
        while (this.#buffer.length >= 4) {
          const length = this.#buffer.readUInt32BE();
          check(length > 0 && length <= 2048);
          if (this.#buffer.length < length + 4) break;
          const response = JSON.parse(this.#buffer.subarray(4, 4 + length));
          this.#buffer = this.#buffer.subarray(4 + length);
          const pending = this.#pending;
          check(
            pending &&
              response.requestId === pending.id &&
              response.protocolVersion === 1 &&
              response.lifetimeId === this.#binding.lifetimeId &&
              response.bindingDigest === this.#binding.bindingDigest &&
              response.ownershipDigest === this.#binding.ownershipDigest &&
              response.launchSetDigest === this.#binding.launchSetDigest,
          );
          check(
            Object.keys(response).sort().join() ===
              [
                "protocolVersion",
                "requestId",
                "code",
                "phase",
                "generation",
                "lifetimeId",
                "bindingDigest",
                "ownershipDigest",
                "launchSetDigest",
                "rootPid",
                "closedRequestId",
                "drainRequestId",
                "reaped",
              ]
                .sort()
                .join(),
          );
          clearTimeout(pending.timer);
          this.#pending = null;
          if (response.code !== "ok") {
            pending.reject(
              new Error(
                response.code === "drain_held"
                  ? "guardian_drain_held"
                  : "guardian_protocol_rejected",
              ),
            );
            this.#reject("guardian_protocol_rejected");
          } else pending.resolve(response);
        }
      } catch {
        this.#reject("guardian_protocol_rejected");
      }
    });
  }
  #reject(reason) {
    if (this.#failure || this.#phase === "closed") return;
    this.#failure = new Error(reason);
    this.#phase = "indeterminate";
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(this.#failure);
      this.#pending = null;
    }
    this.#channel.destroy(); // EOF revokes execution; never SIGKILL the adopting guardian.
    this.#failureJournal = Promise.resolve()
      .then(() => this.#options.journal.indeterminate({ ...this.#binding, reason }))
      .catch(() => {});
  }
  #rpc(op, payload = Buffer.alloc(0), timeoutMs = 2000) {
    if (this.#failure) return Promise.reject(this.#failure);
    check(!this.#pending);
    const id = ++this.#sequence,
      message = new Encoding().u32(op).u32(id).result();
    const body = Buffer.concat([message, payload]);
    check(body.length <= MAX_FRAME);
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#reject("guardian_request_timeout"), timeoutMs);
      this.#pending = { id, resolve, reject, timer };
      this.#channel.write(frame);
    });
  }
  #serialized(fn) {
    const value = this.#queue.then(() => {
      if (this.#failure) throw this.#failure;
      return fn();
    });
    this.#queue = value.catch(() => {});
    return value;
  }
  async initialize(payload, guardianPin) {
    try {
      const ready = await this.#rpc(1, payload);
      check(ready.phase === "ready");
      this.#identity = processIdentity(this.#child.pid);
      check(
        this.#identity.executable === guardianPin.path &&
          processParentPid(this.#child.pid) === process.pid,
      );
      check(sha(readFileSync(`/proc/${this.#child.pid}/exe`)) === guardianPin.sha256);
      await this.#options.journal.ready({ ...this.#binding, guardianIdentity: this.#identity });
      const active = await this.#rpc(2);
      check(active.phase === "open" && active.generation === 1);
      this.#phase = "open";
    } catch (error) {
      this.#reject("guardian_initialization_failed");
      await this.#failureJournal;
      throw error;
    }
  }
  get state() {
    return structuredClone({
      phase: this.#phase,
      ...this.#binding,
      generation: this.#generation,
      guardianIdentity: this.#identity,
      ...(this.#failure
        ? {
            failure: {
              reason: this.#failure.message,
              exitCode: this.#child.exitCode,
              signal: this.#child.signalCode,
            },
          }
        : {}),
    });
  }
  workerChannel(rootId) {
    const root = this.#roots.find((value) => value.id === rootId);
    check(this.#phase === "open" && root?.workerChannel === true);
    return this.#child.stdio[4 + this.#roots.length * 2];
  }
  admitProject(project) {
    return this.#serialized(async () => {
      check(
        this.#phase === "open" &&
          uuid.test(project?.projectId) &&
          digest.test(project?.bindingDigest),
      );
      const prior = this.#binding.projects.find((value) => value.projectId === project.projectId);
      if (prior) {
        check(prior.bindingDigest === project.bindingDigest);
        return this.state;
      }
      check(this.#binding.projects.length < 32);
      for (const name of ["admissionIntent", "admissionAccepted"])
        check(typeof this.#options.journal[name] === "function");
      const projects = Object.freeze([
        ...this.#binding.projects,
        Object.freeze({ projectId: project.projectId, bindingDigest: project.bindingDigest }),
      ]);
      const next = Object.freeze({
        ...this.#binding,
        projects,
        ownershipDigest: sha(JSON.stringify(projects)),
      });
      try {
        await this.#options.journal.admissionIntent({
          ...next,
          expectedGeneration: this.#generation,
          previousOwnershipDigest: this.#binding.ownershipDigest,
        });
        const payload = new Encoding()
          .u32(this.#generation)
          .str(this.#binding.ownershipDigest)
          .str(next.ownershipDigest)
          .str(project.projectId)
          .str(project.bindingDigest)
          .result();
        this.#binding = next;
        const result = await this.#rpc(7, payload);
        check(result.phase === "open" && result.generation === this.#generation + 1);
        this.#generation = result.generation;
        await this.#options.journal.admissionAccepted(this.state);
        return this.state;
      } catch (error) {
        this.#reject("guardian_admission_uncertain");
        await this.#failureJournal;
        throw error;
      }
    });
  }
  launch(rootId) {
    return this.#serialized(async () => {
      check(this.#phase === "open");
      const index = this.#roots.findIndex((r) => r.id === rootId);
      check(index >= 0);
      // Journal before launch; an ambiguous reply cannot authorize another start.
      await this.#options.journal.launchIntent({
        ...this.#binding,
        rootId,
        generation: this.#generation,
      });
      try {
        const result = await this.#rpc(3, new Encoding().u32(this.#generation).u32(index).result());
        check(
          result.phase === "open" &&
            result.generation === this.#generation &&
            Number.isInteger(result.rootPid) &&
            result.rootPid > 1,
        );
        return { rootId, pid: result.rootPid, lifetimeId: this.#binding.lifetimeId };
      } catch (error) {
        this.#reject("guardian_launch_uncertain");
        throw error;
      }
    });
  }
  drain() {
    return this.#serialized(async () => {
      check(this.#phase === "open");
      const decisions = structuredClone(
        await this.#options.authorizeDrain(structuredClone(this.#binding)),
      );
      check(Array.isArray(decisions) && decisions.length === this.#binding.projects.length);
      this.#binding.projects.forEach((p, i) => {
        check(
          decisions[i]?.projectId === p.projectId &&
            decisions[i]?.bindingDigest === p.bindingDigest &&
            uuid.test(decisions[i]?.decisionId),
        );
      });
      this.#phase = "closing";
      try {
        await this.#options.journal.closeIntent({
          ...this.#binding,
          expectedGeneration: this.#generation,
          decisions,
        });
        const payload = new Encoding()
          .u32(this.#generation)
          .str(this.#binding.ownershipDigest)
          .u32(decisions.length);
        for (const d of decisions) payload.str(d.projectId).str(d.bindingDigest).str(d.decisionId);
        const closed = await this.#rpc(4, payload.result());
        check(closed.phase === "closed" && closed.generation === this.#generation + 1);
        this.#generation = closed.generation;
        this.#closedRequestId = closed.closedRequestId;
        const result = await this.#rpc(5, new Encoding().u32(this.#generation).result(), 6000);
        check(
          result.phase === "drained" &&
            result.generation === this.#generation &&
            result.closedRequestId === this.#closedRequestId &&
            result.drainRequestId === result.requestId &&
            Number.isInteger(result.reaped) &&
            result.reaped >= 0,
        );
        const receipt = Object.freeze({
          schemaVersion: 1,
          scope: "managed_native_tree_only",
          cleanupAuthorized: false,
          receiptId: randomUUID(),
          ...this.#binding,
          guardianIdentity: this.#identity,
          generation: this.#generation,
          closedRequestId: this.#closedRequestId,
          drainRequestId: result.drainRequestId,
          finalWaitResult: "ECHILD",
          waitFlags: "__WALL",
          reaped: result.reaped,
          decisions: decisions.map(({ projectId, bindingDigest, decisionId }) => ({
            projectId,
            bindingDigest,
            decisionId,
          })),
        });
        await this.#options.journal.acceptReceipt(receipt);
        this.#phase = "acknowledging";
        await this.#rpc(
          6,
          new Encoding().u32(this.#generation).u32(result.drainRequestId).result(),
        );
        const ended = await Promise.race([
          this.#exited,
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error("guardian_exit_timeout")), 2000);
            timer.unref();
          }),
        ]);
        check(ended.code === 0 && ended.signal === null);
        this.#phase = "closed";
        this.#channel.destroy();
        return receipt;
      } catch (error) {
        this.#reject("guardian_drain_uncertain");
        await this.#failureJournal;
        throw error;
      }
    });
  }
  async abort() {
    this.#reject("guardian_controller_abort");
    await this.#failureJournal;
    return Promise.race([
      this.#exited,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ held: true }), 6000);
        timer.unref();
      }),
    ]);
  }
}

export async function openNativeGuardian(options) {
  check(
    options && digest.test(options.bindingDigest) && typeof options.authorizeDrain === "function",
  );
  for (const operation of [
    "begin",
    "ready",
    "launchIntent",
    "closeIntent",
    "acceptReceipt",
    "indeterminate",
  ])
    check(typeof options.journal?.[operation] === "function");
  check(Array.isArray(options.projects) && options.projects.length <= 32);
  const projects = options.projects
    .map((p) => {
      check(uuid.test(p.projectId) && digest.test(p.bindingDigest));
      return { projectId: p.projectId, bindingDigest: p.bindingDigest };
    })
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
  check(new Set(projects.map((p) => p.projectId)).size === projects.length);
  check(
    Array.isArray(options.roots) &&
      options.roots.length > 0 &&
      options.roots.length <= 8 &&
      options.roots.filter((root) => root.workerChannel).length <= 1 &&
      (!options.roots.some((root) => root.role === "host") || options.roots.length === 1) &&
      new Set(options.roots.map((r) => r.id)).size === options.roots.length,
  );
  const guardianPin = pin(options.executable, options.sha256),
    roots = [];
  let guardian;
  try {
    for (const r of options.roots) roots.push(rootDescriptor(r));
    const launchSetDigest = sha(
      JSON.stringify(
        roots.map((r) => ({
          id: r.id,
          role: r.role,
          executable: r.executable.path,
          sha256: r.executable.sha256,
          argvDigest: sha(JSON.stringify(r.argv)),
          envDigest: sha(JSON.stringify(r.environment)),
          cwdDevice: String(fstatSync(r.cwd).dev),
          cwdInode: String(fstatSync(r.cwd).ino),
          ...(r.workerChannel ? { workerChannelFd: 3 } : {}),
        })),
      ),
    );
    projects.forEach(Object.freeze);
    Object.freeze(projects);
    const binding = Object.freeze({
      lifetimeId: randomUUID(),
      bindingDigest: options.bindingDigest,
      ownershipDigest: sha(JSON.stringify(projects)),
      projects,
      launchSetDigest,
      guardianSha256: guardianPin.sha256,
    });
    const payload = encodeBootstrap(
      binding.lifetimeId,
      binding.bindingDigest,
      binding.ownershipDigest,
      binding.launchSetDigest,
      projects,
      roots,
    );
    await options.journal.begin(binding);
    const child = spawn(guardianPin.path, ["--private-fd-v1"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: [
        "ignore",
        "ignore",
        "ignore",
        "pipe",
        ...roots.flatMap((r) => [r.executable.fd, r.cwd]),
        ...(roots.some((root) => root.workerChannel) ? ["pipe"] : []),
      ],
    });
    guardian = new NativeGuardian(child, options, roots, binding);
    await guardian.initialize(payload, guardianPin);
    return guardian;
  } finally {
    closeSync(guardianPin.fd);
    for (const r of roots) {
      closeSync(r.executable.fd);
      closeSync(r.cwd);
    }
  }
}
