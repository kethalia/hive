#!/usr/bin/env node
// Local-only prototype. No HTTP listener, registration API, or automatic startup.
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

export const VERSION = "0.165.0";
const id = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(x);
const check = (x, code) => {
  if (!x) throw new Error(code);
};
const hash = (x) => createHash("sha256").update(x).digest("hex");
const exact = (x, keys) =>
  x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).every((k) => keys.includes(k));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function privatePath(path, directory = false) {
  check(realpathSync(path) === path, "symlink_path");
  const s = lstatSync(path);
  check(
    s.uid === process.getuid() && !(s.mode & 0o077) && (directory ? s.isDirectory() : s.isFile()),
    "private_path_required",
  );
}
function atomic(path, value, raw = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, raw ? value : JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function validateSupervisorConfig(raw) {
  check(
    exact(raw, [
      "schemaVersion",
      "profile",
      "ownerId",
      "workspaceId",
      "buildId",
      "codexExecutable",
      "codexSha256",
      "projects",
    ]) &&
      raw.schemaVersion === 1 &&
      raw.profile === "software",
    "unsupported_configuration",
  );
  for (const key of ["ownerId", "workspaceId", "buildId"]) check(id(raw[key]), "invalid_identity");
  check(
    typeof raw.codexExecutable === "string" &&
      resolve(raw.codexExecutable) === raw.codexExecutable &&
      /^[a-f0-9]{64}$/.test(raw.codexSha256),
    "invalid_executable_pin",
  );
  check(
    Array.isArray(raw.projects) && raw.projects.length > 0 && raw.projects.length <= 32,
    "invalid_projects",
  );
  const seen = new Set();
  for (const p of raw.projects) {
    check(
      exact(p, [
        "projectId",
        "repositoryId",
        "taskId",
        "leaseId",
        "leaseGeneration",
        "model",
        "effort",
      ]) &&
        id(p.projectId) &&
        /^[1-9][0-9]{0,19}$/.test(p.repositoryId) &&
        id(p.taskId) &&
        id(p.leaseId) &&
        Number.isSafeInteger(p.leaseGeneration) &&
        p.leaseGeneration > 0 &&
        typeof p.model === "string" &&
        /^[a-z0-9][a-z0-9._-]{0,99}$/.test(p.model) &&
        ["low", "medium", "high", "xhigh", "max", "ultra"].includes(p.effort),
      "invalid_project",
    );
    check(!seen.has(p.projectId) && !seen.has(`repo:${p.repositoryId}`), "duplicate_project");
    seen.add(p.projectId);
    seen.add(`repo:${p.repositoryId}`);
  }
  return structuredClone(raw);
}

// Not cryptographic Coder identity. Only an installed, private local configuration
// supplies these values; external registration must independently authenticate them.
export async function openSupervisor(raw, dependencies = {}) {
  const config = validateSupervisorConfig(raw);
  const home = dependencies.home ?? userInfo().homedir;
  check(realpathSync(home) === home, "invalid_home");
  const stateDirectory = join(home, ".local/state/hive/codex-project-supervisor");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  privatePath(stateDirectory, true);
  const lock = openSync(
    join(stateDirectory, "supervisor.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let runtime;
  try {
    const s = fstatSync(lock);
    check(s.isFile() && s.uid === process.getuid() && !(s.mode & 0o077), "invalid_lock");
    try {
      execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", lock],
        timeout: 2000,
      });
    } catch {
      throw new Error("supervisor_already_running");
    }
    const statePath = join(stateDirectory, "registry.json");
    const keyPath = join(stateDirectory, "key");
    if (!existsSync(keyPath)) {
      check(!existsSync(statePath), "registry_key_missing");
      const fd = openSync(
        keyPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, randomBytes(32));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    privatePath(keyPath);
    const key = readFileSync(keyPath);
    check(key.length === 32, "invalid_registry_key");
    const sign = (v) => createHmac("sha256", key).update(JSON.stringify(v)).digest("hex");
    let state = {
      schemaVersion: 1,
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      projects: {},
    };
    if (existsSync(statePath)) {
      privatePath(statePath);
      check(lstatSync(statePath).size <= 1024 * 1024, "registry_too_large");
      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      const signature = sign(saved.state);
      check(
        typeof saved.signature === "string" &&
          saved.signature.length === signature.length &&
          timingSafeEqual(Buffer.from(saved.signature), Buffer.from(signature)),
        "invalid_registry_signature",
      );
      state = saved.state;
      check(
        state.schemaVersion === 1 &&
          state.ownerId === config.ownerId &&
          state.workspaceId === config.workspaceId &&
          state.projects &&
          Object.keys(state.projects).length <= 32,
        "registry_identity_changed",
      );
    }
    const save = () => atomic(statePath, { state, signature: sign(state) });
    state.serverInstanceId = randomUUID();
    state.buildId = config.buildId;
    state.status = "starting";
    for (const entry of Object.values(state.projects)) entry.attached = false;
    save();
    const supervisor = new ProjectSupervisor(config, home, stateDirectory, state, save, lock);
    runtime = await (dependencies.runtimeFactory ?? launchNative)({
      config,
      home,
      stateDirectory,
      lock,
    });
    supervisor.runtime = runtime;
    if (dependencies.managerAdapter) supervisor.setManagerAdapter(dependencies.managerAdapter);
    runtime.onClose(() => supervisor.revoke());
    check(runtime.version === VERSION && runtime.alive(), "unsupported_native_runtime");
    state.status = "ready";
    save();
    return supervisor;
  } catch (error) {
    await runtime?.close();
    closeSync(lock);
    throw error;
  }
}

export class ProjectSupervisor {
  constructor(config, home, stateDirectory, state, save, lock) {
    Object.assign(this, { config, home, stateDirectory, state, save, lock });
    this.closed = false;
    this.busy = false;
    this.revocationListeners = new Set();
  }
  onRevoked(listener) {
    this.revocationListeners.add(listener);
    if (this.state.status === "revoked") listener();
    return () => this.revocationListeners.delete(listener);
  }
  revoke() {
    if (this.state.status === "revoked") return;
    this.state.status = "revoked";
    for (const listener of this.revocationListeners) {
      try {
        listener();
      } catch {}
    }
    for (const entry of Object.values(this.state.projects)) entry.attached = false;
    this.save();
  }
  // Installed controller only; not exposed through command() or the native bridge.
  enrollPreparedProject(project) {
    check(!this.closed && !this.busy && this.state.status === "ready", "supervisor_busy_or_closed");
    const existing = this.config.projects.find((p) => p.projectId === project.projectId);
    if (existing) {
      check(JSON.stringify(existing) === JSON.stringify(project), "project_binding_conflict");
      // Existing durable enrollment also supports history-only recovery after
      // checkout cleanup. Every execution command independently verifies lease.
      return;
    }
    const next = validateSupervisorConfig({
      ...this.config,
      projects: [...this.config.projects, project],
    });
    this.lease(project);
    this.config.projects = next.projects;
  }
  project(projectId) {
    const project = this.config.projects.find((p) => p.projectId === projectId);
    check(project, "project_not_registered");
    return project;
  }
  checkout(project) {
    const path = join(this.home, "projects/.hive-managed/github", project.repositoryId, "checkout");
    check(realpathSync(path) === path && lstatSync(path).isDirectory(), "checkout_unavailable");
    // Verify current signed managed-project lease using its fixed trusted helper.
    // The injected fixture runtime tests this callback separately; production helper
    // path is resolved beside this installed package, not from a task request.
    return path;
  }
  lease(project) {
    const helper = new URL("./managed-projects.py", import.meta.url);
    const result = this.runtime.inspectLease
      ? this.runtime.inspectLease(project)
      : JSON.parse(
          execFileSync("/usr/bin/python3", [helper.pathname], {
            input: JSON.stringify({
              schemaVersion: 1,
              provider: "github",
              repositoryId: project.repositoryId,
              operation: "inspect",
            }),
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 32768,
            env: { PATH: "/usr/bin:/bin" },
            stdio: ["pipe", "pipe", "ignore"],
          }),
        );
    const value = result?.ok === true ? result.data : null;
    check(
      value?.status === "ready" &&
        value.checkoutVerified === true &&
        value.lease?.id === project.leaseId &&
        value.lease?.taskId === project.taskId &&
        value.lease?.generation === project.leaseGeneration &&
        Number.isFinite(value.lease?.expiresAt) &&
        value.lease.expiresAt > Date.now() / 1000 &&
        value.checkoutDirectory === this.checkout(project),
      "checkout_lease_changed",
    );
    return value;
  }
  snapshot(projectId) {
    this.project(projectId);
    const entry = this.state.projects[projectId];
    return {
      projectId,
      phase:
        this.state.status !== "ready"
          ? "revoked"
          : entry?.phase === "historyRejoinUnsupported"
            ? "historyRejoinUnsupported"
            : entry?.threadId && entry.serverInstanceId !== this.state.serverInstanceId
              ? "rejoinRequired"
              : (entry?.phase ?? "not-created"),
      threadId: entry?.threadId ?? null,
      serverInstanceId: this.state.serverInstanceId,
      attached: entry?.attached ?? false,
      firstPromptRequestId: entry?.firstPrompt?.requestId ?? null,
    };
  }
  // Registration can precede the first actual prompt. Browser history and CLI
  // attachment continue to require binding()'s persisted state below.
  registrationBinding(projectId) {
    const project = this.project(projectId),
      entry = this.state.projects[projectId];
    check(
      this.state.status === "ready" &&
        this.runtime.alive() &&
        entry &&
        id(entry.threadId) &&
        entry.repositoryId === project.repositoryId &&
        entry.serverInstanceId === this.state.serverInstanceId &&
        ["awaitingFirstTurn", "firstPromptUncertain", "awaitingPersistence", "persisted"].includes(
          entry.phase,
        ),
      "registration_binding_unavailable",
    );
    return {
      ownerId: this.config.ownerId,
      workspaceId: this.config.workspaceId,
      buildId: this.config.buildId,
      serverInstanceId: this.state.serverInstanceId,
      threadId: entry.threadId,
    };
  }
  setManagerAdapter(adapter) {
    check(
      !this.managerAdapter &&
        adapter &&
        typeof adapter.tools === "function" &&
        typeof adapter.handleToolCall === "function" &&
        typeof this.runtime.setManagerAdapter === "function",
      "invalid_manager_adapter",
    );
    this.managerAdapter = adapter;
    this.runtime.setManagerAdapter({
      handleToolCall: async (params) => {
        const project = this.config.projects.find(
          (p) => this.state.projects[p.projectId]?.threadId === params.threadId,
        );
        check(
          project && this.registrationBinding(project.projectId).threadId === params.threadId,
          "manager_thread_unregistered",
        );
        return adapter.handleToolCall(params);
      },
      observe: adapter.observe
        ? (notification) => {
            const threadId = notification?.params?.threadId;
            const project = this.config.projects.find(
              (p) => this.state.projects[p.projectId]?.threadId === threadId,
            );
            if (project && this.registrationBinding(project.projectId).threadId === threadId)
              return adapter.observe(notification);
          }
        : undefined,
    });
  }
  managerTools(projectId) {
    if (!this.managerAdapter) return [];
    const tools = this.managerAdapter.tools(projectId);
    check(
      Array.isArray(tools) &&
        tools.length <= 1 &&
        Buffer.byteLength(JSON.stringify(tools)) <= 65536 &&
        tools.every(
          (t) =>
            t.type === "function" &&
            t.name === "hive_delivery" &&
            typeof t.description === "string" &&
            t.inputSchema &&
            typeof t.inputSchema === "object",
        ),
      "invalid_manager_tools",
    );
    return structuredClone(tools);
  }
  binding(projectId) {
    const entry = this.state.projects[projectId];
    check(
      this.state.status === "ready" &&
        this.runtime.alive() &&
        entry?.phase === "persisted" &&
        entry.serverInstanceId === this.state.serverInstanceId,
      "session_not_available",
    );
    const project = this.project(projectId);
    check(entry.repositoryId === project.repositoryId, "session_binding_denied");
    return {
      ownerId: this.config.ownerId,
      workspaceId: this.config.workspaceId,
      buildId: this.config.buildId,
      serverInstanceId: this.state.serverInstanceId,
      threadId: entry.threadId,
    };
  }
  authorizeBinding(candidate) {
    const keys = ["ownerId", "workspaceId", "buildId", "serverInstanceId", "threadId"];
    check(
      exact(candidate, keys) && keys.every((key) => id(candidate[key])),
      "session_binding_denied",
    );
    for (const project of this.config.projects) {
      if (this.state.projects[project.projectId]?.threadId !== candidate.threadId) continue;
      const binding = this.binding(project.projectId);
      check(
        keys.every((key) => candidate[key] === binding[key]),
        "session_binding_denied",
      );
      return project.projectId;
    }
    throw new Error("session_binding_denied");
  }
  async command(request) {
    check(!this.closed && !this.busy, "supervisor_busy_or_closed");
    check(
      exact(request, ["operation", "projectId", "creationIntentId", "requestId", "text"]) &&
        id(request.projectId),
      "invalid_command",
    );
    const fields = {
      inspect: [],
      ensureProject: ["creationIntentId"],
      firstPrompt: ["requestId", "text"],
      refresh: [],
      rejoin: [],
      attach: [],
    };
    check(
      Object.hasOwn(fields, request.operation) &&
        Object.keys(request).every((k) =>
          ["operation", "projectId", ...fields[request.operation]].includes(k),
        ),
      "invalid_command",
    );
    const project = this.project(request.projectId);
    if (request.operation === "inspect") return this.snapshot(project.projectId);
    check(this.state.status === "ready" && this.runtime.alive(), "native_lifetime_revoked");
    this.busy = true;
    try {
      if (!["refresh", "rejoin"].includes(request.operation)) this.lease(project);
      let entry = this.state.projects[project.projectId];
      if (request.operation === "ensureProject") {
        check(id(request.creationIntentId), "invalid_creation_intent");
        if (entry) {
          check(
            entry.creationIntentId === request.creationIntentId &&
              entry.repositoryId === project.repositoryId,
            "project_binding_conflict",
          );
          return this.snapshot(project.projectId);
        }
        check(Object.keys(this.state.projects).length < 32, "project_limit");
        entry = {
          repositoryId: project.repositoryId,
          creationIntentId: request.creationIntentId,
          phase: "creation-uncertain",
          threadId: null,
          serverInstanceId: this.state.serverInstanceId,
          attached: false,
        };
        this.state.projects[project.projectId] = entry;
        this.save(); // Durable intent BEFORE the non-idempotent native request.
        const started = await this.runtime.call("thread/start", {
          cwd: this.checkout(project),
          model: project.model,
          allowProviderModelFallback: false,
          config: { model_reasoning_effort: project.effort },
          historyMode: "paginated",
          ...(this.managerAdapter
            ? { dynamicTools: this.managerTools(project.projectId), experimentalRawEvents: true }
            : {}),
        });
        check(
          id(started?.thread?.id) &&
            started.thread.cwd === this.checkout(project) &&
            started.model === project.model &&
            started.reasoningEffort === project.effort,
          "native_thread_binding_mismatch",
        );
        check(
          !Object.values(this.state.projects).some(
            (other) => other !== entry && other.threadId === started.thread.id,
          ),
          "native_thread_already_bound",
        );
        entry.threadId = started.thread.id;
        entry.phase = "awaitingFirstTurn";
        this.save();
      } else {
        check(
          entry?.threadId && entry.repositoryId === project.repositoryId,
          "thread_binding_unavailable",
        );
        if (request.operation === "rejoin") {
          check(entry.phase !== "creation-uncertain", "creation_reconciliation_required");
          let resumed;
          try {
            resumed = await this.runtime.call("thread/resume", {
              threadId: entry.threadId,
              excludeTurns: true,
            });
          } catch {
            entry.phase = "historyRejoinUnsupported";
            this.save();
            throw new Error("history_rejoin_unsupported");
          }
          check(
            resumed?.thread?.id === entry.threadId &&
              resumed.thread.cwd ===
                join(this.home, "projects/.hive-managed/github", project.repositoryId, "checkout"),
            "native_thread_binding_mismatch",
          );
          entry.serverInstanceId = this.state.serverInstanceId;
          await this.refresh(entry);
        } else {
          check(entry.serverInstanceId === this.state.serverInstanceId, "explicit_rejoin_required");
          if (request.operation === "firstPrompt") {
            check(
              id(request.requestId) &&
                typeof request.text === "string" &&
                request.text.trim().length > 0 &&
                Buffer.byteLength(request.text) <= 32768 &&
                !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.text),
              "invalid_first_prompt",
            );
            const digest = hash(request.text);
            if (entry.firstPrompt) {
              check(
                entry.firstPrompt.requestId === request.requestId &&
                  entry.firstPrompt.digest === digest,
                "first_prompt_conflict",
              );
              return this.snapshot(project.projectId); // Never re-send an ambiguous request.
            }
            check(entry.phase === "awaitingFirstTurn", "first_prompt_not_available");
            entry.firstPrompt = {
              requestId: request.requestId,
              digest,
              phase: "submission-uncertain",
            };
            entry.phase = "firstPromptUncertain";
            this.save();
            const result = await this.runtime.call("turn/start", {
              threadId: entry.threadId,
              clientUserMessageId: request.requestId,
              input: [{ type: "text", text: request.text, text_elements: [] }],
            });
            check(id(result?.turn?.id), "invalid_native_turn");
            entry.firstPrompt.turnId = result.turn.id;
            entry.firstPrompt.phase = "accepted";
            entry.phase = "awaitingPersistence";
            this.save();
            await this.refresh(entry);
          } else if (request.operation === "refresh") await this.refresh(entry);
          else if (request.operation === "attach") {
            this.binding(project.projectId);
            await this.runtime.attach(entry.threadId, this.checkout(project), project.projectId);
            entry.attached = true;
            this.save();
          }
        }
      }
      return this.snapshot(project.projectId);
    } finally {
      this.busy = false;
    }
  }
  async refresh(entry) {
    const history = await this.runtime.call("thread/turns/list", {
      threadId: entry.threadId,
      limit: 1,
      sortDirection: "asc",
      itemsView: "full",
    });
    check(Array.isArray(history?.data), "invalid_native_history");
    if (history.data.length) {
      entry.phase = "persisted";
      this.save();
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.revoke();
    } finally {
      try {
        await this.runtime.close();
      } finally {
        closeSync(this.lock);
      }
    }
  }
}

/** Native server requests have a separate ID namespace from client responses.
 * Only the installed hive_delivery tool can be answered. Approval/input requests
 * remain unanswered; never confuse a server request with a pending client reply. */
export function createNativeManagerRouter(getAdapter, reply) {
  let active = 0;
  const failed = {
    contentItems: [
      { type: "inputText", text: "Delivery controller unavailable or request rejected." },
    ],
    success: false,
  };
  return (message) => {
    if (typeof message.method !== "string") return false;
    const adapter = getAdapter();
    if (["item/started", "item/completed", "rawResponseItem/completed"].includes(message.method)) {
      try {
        void Promise.resolve(
          adapter?.observe?.({ method: message.method, params: message.params }),
        ).catch(() => {});
      } catch {}
      return true;
    }
    if (message.method !== "item/tool/call" || !Object.hasOwn(message, "id")) return true;
    const params = message.params;
    if (
      !adapter ||
      !params ||
      params.tool !== "hive_delivery" ||
      (params.namespace !== null && params.namespace !== undefined) ||
      active >= 8
    ) {
      reply(message.id, failed);
      return true;
    }
    active++;
    let timer;
    void Promise.race([
      Promise.resolve().then(() => adapter.handleToolCall(params)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("manager_timeout")), 15000);
      }),
    ])
      .then((result) => {
        check(
          result &&
            typeof result.success === "boolean" &&
            Array.isArray(result.contentItems) &&
            result.contentItems.length <= 8 &&
            result.contentItems.every(
              (i) => i.type === "inputText" && typeof i.text === "string",
            ) &&
            Buffer.byteLength(JSON.stringify(result)) <= 65536,
          "invalid_manager_result",
        );
        reply(message.id, result);
      })
      .catch(() => reply(message.id, failed))
      .finally(() => {
        clearTimeout(timer);
        active--;
      });
    return true;
  };
}

export async function launchNative({ config, home, stateDirectory, lock }) {
  const executable = readFileSync(config.codexExecutable);
  check(
    realpathSync(config.codexExecutable) === config.codexExecutable &&
      executable.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      hash(executable) === config.codexSha256,
    "native_executable_changed",
  );
  const env = Object.fromEntries(
    ["PATH", "USER", "LANG", "SHELL"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  );
  Object.assign(env, { HOME: home, CODEX_HOME: join(home, ".codex"), TERM: "xterm-256color" });
  check(
    execFileSync(config.codexExecutable, ["--version"], {
      env,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === `codex-cli ${VERSION}`,
    "unsupported_native_runtime",
  );
  const reservation = createServer();
  await new Promise((r, j) => {
    reservation.once("error", j);
    reservation.listen(0, "127.0.0.1", r);
  });
  const endpoint = `ws://127.0.0.1:${reservation.address().port}`;
  await new Promise((r) => reservation.close(r));
  const token = randomBytes(32).toString("hex");
  const tokenPath = join(stateDirectory, "native-token");
  atomic(tokenPath, token, true);
  // Linux parent-death signal survives exec; inherited flock fd prevents a second
  // supervisor until this exact child exits, including abrupt supervisor death.
  const guardian =
    "import ctypes,os,signal,sys\np=int(sys.argv[1])\nr=ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)\nif r!=0 or os.getppid()!=p: sys.exit(1)\nos.execv(sys.argv[2],sys.argv[2:])";
  const child = spawn(
    "/usr/bin/python3",
    [
      "-c",
      guardian,
      String(process.pid),
      config.codexExecutable,
      "app-server",
      "--listen",
      endpoint,
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      tokenPath,
    ],
    { cwd: home, env, stdio: ["ignore", "ignore", "ignore", lock] },
  );
  let ws;
  let closing = false;
  let callback = () => {};
  let managerAdapter;
  const managerRouter = createNativeManagerRouter(
    () => managerAdapter,
    (id, result) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, result }));
    },
  );
  const pending = new Map();
  let next = 1;
  const revoke = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("native_disconnected"));
    }
    pending.clear();
    callback();
  };
  child.once("exit", revoke);
  child.once("error", revoke);
  const stop = async () => {
    closing = true;
    ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    for (let n = 0; n < 20 && child.exitCode === null && child.signalCode === null; n++)
      await sleep(50);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
    try {
      execFileSync("tmux", ["-S", join(stateDirectory, "tmux.sock"), "kill-server"], {
        env,
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {}
  };
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      check(child.exitCode === null && child.signalCode === null, "native_start_failed");
      try {
        ws = await new Promise((r, j) => {
          const s = new WebSocket(endpoint, {
            headers: { Authorization: `Bearer ${token}` },
            handshakeTimeout: 300,
            maxPayload: 1024 * 1024,
          });
          s.once("open", () => r(s));
          s.once("error", j);
        });
        break;
      } catch {
        await sleep(100);
      }
    }
    check(ws?.readyState === WebSocket.OPEN, "native_start_timeout");
    ws.on("close", revoke);
    ws.on("error", revoke);
    ws.on("message", (data, binary) => {
      try {
        check(!binary, "native_binary_frame");
        const message = JSON.parse(data.toString());
        if (managerRouter(message)) return;
        const p = pending.get(message.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(message.id);
          message.error
            ? p.reject(new Error("native_request_rejected"))
            : p.resolve(message.result);
        }
        // Server approval/input requests are intentionally never answered here.
      } catch {
        ws.terminate();
        revoke();
      }
    });
    const call = (method, params) =>
      new Promise((resolveCall, reject) => {
        if (closing || ws.readyState !== WebSocket.OPEN || pending.size >= 8) {
          reject(new Error("native_unavailable"));
          return;
        }
        const requestId = next++;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("native_request_timeout"));
        }, 5000);
        pending.set(requestId, { resolve: resolveCall, reject, timer });
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    const initialized = await call("initialize", {
      clientInfo: { name: "hive_project_supervisor", version: "1" },
      capabilities: { experimentalApi: true },
    });
    check(
      typeof initialized.userAgent === "string" &&
        /^[^/\s]+\/0\.165\.0(?:\s|$)/.test(initialized.userAgent),
      "unsupported_native_runtime",
    );
    ws.send(JSON.stringify({ method: "initialized" }));
    return {
      version: VERSION,
      setManagerAdapter: (adapter) => {
        check(!managerAdapter, "manager_adapter_already_installed");
        managerAdapter = adapter;
      },
      call,
      createReadSocket: () => {
        check(
          !closing &&
            child.exitCode === null &&
            child.signalCode === null &&
            ws.readyState === WebSocket.OPEN,
          "native_unavailable",
        );
        return new WebSocket(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          handshakeTimeout: 5000,
          maxPayload: 1024 * 1024,
          followRedirects: false,
          perMessageDeflate: false,
        });
      },
      alive: () =>
        !closing &&
        child.exitCode === null &&
        child.signalCode === null &&
        ws.readyState === WebSocket.OPEN,
      onClose: (fn) => {
        callback = fn;
      },
      close: stop,
      async attach(threadId, cwd, projectId) {
        const socket = join(stateDirectory, "tmux.sock");
        const name = `project-${hash(projectId).slice(0, 24)}`;
        const cliEnv = { ...env, HIVE_NATIVE_CODEX_TOKEN: token };
        try {
          execFileSync("tmux", ["-S", socket, "has-session", "-t", `=${name}`], {
            env: cliEnv,
            stdio: "ignore",
            timeout: 2000,
          });
          return;
        } catch {}
        execFileSync(
          "tmux",
          [
            "-f",
            "/dev/null",
            "-S",
            socket,
            "new-session",
            "-d",
            "-s",
            name,
            "-c",
            cwd,
            config.codexExecutable,
            "resume",
            "--remote",
            endpoint,
            "--remote-auth-token-env",
            "HIVE_NATIVE_CODEX_TOKEN",
            threadId,
          ],
          { env: cliEnv, stdio: "ignore", timeout: 5000 },
        );
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function main() {
  check(
    process.argv.length === 3 && process.env.HIVE_WORKSPACE_PROFILE === "software",
    "software_wrapper_required",
  );
  const path = resolve(process.argv[2]);
  privatePath(path);
  check(lstatSync(path).size <= 32768, "config_too_large");
  const supervisor = await openSupervisor(JSON.parse(readFileSync(path, "utf8")));
  let buffer = "";
  let queued = Promise.resolve();
  let count = 0;
  let inputClosed = false;
  const stop = () => {
    inputClosed = true;
    process.stdin.destroy();
    return supervisor.close();
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 65536) {
      void stop();
      return;
    }
    while (buffer.includes("\n")) {
      const offset = buffer.indexOf("\n");
      const line = buffer.slice(0, offset);
      buffer = buffer.slice(offset + 1);
      if (++count > 16) {
        void stop();
        return;
      }
      queued = queued.then(async () => {
        try {
          check(!inputClosed, "input_closed");
          const data = await supervisor.command(JSON.parse(line));
          process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
        } catch {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: "supervisor_command_rejected" })}\n`,
          );
        } finally {
          count--;
        }
      });
    }
  });
  process.stdin.once("end", () => {
    void queued.finally(stop);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("supervisor_start_rejected\n");
    process.exitCode = 1;
  });
