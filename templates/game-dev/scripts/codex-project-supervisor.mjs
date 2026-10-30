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
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  NATIVE_PROFILE,
  prepareNativeNamespace,
  validateMetadataApproval,
} from "./codex-native-namespace.mjs";
import { processIdentity } from "./codex-process-identity.mjs";

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
      "executionMode",
      "metadataReadOnly",
    ]) &&
      raw.schemaVersion === 1 &&
      raw.profile === "software",
    "unsupported_configuration",
  );
  check(
    (raw.metadataReadOnly === undefined || typeof raw.metadataReadOnly === "boolean") &&
      (!raw.metadataReadOnly || raw.executionMode === "isolated"),
    "unsupported_metadata_mode",
  );
  for (const key of ["ownerId", "workspaceId", "buildId"]) check(id(raw[key]), "invalid_identity");
  check(
    raw.executionMode === undefined || ["direct", "isolated"].includes(raw.executionMode),
    "unsupported_execution_mode",
  );
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
  check(
    !config.metadataReadOnly || typeof dependencies.metadataAuthority === "function",
    "metadata_authority_required",
  );
  const executionAuthority = dependencies.executionAuthority;
  if (executionAuthority)
    check(
      typeof executionAuthority.assert === "function" &&
        typeof executionAuthority.fence === "function",
      "execution_authority_required",
    );
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
    check(
      !state.metadataLaunch || config.metadataReadOnly === true,
      "metadata_mode_downgrade_rejected",
    );
    const save = () => atomic(statePath, { state, signature: sign(state) });
    state.serverInstanceId = randomUUID();
    state.buildId = config.buildId;
    state.status = "starting";
    state.hostProcess = processIdentity(process.pid);
    state.nativeProcess = null;
    state.executionIdentity = null;
    for (const entry of Object.values(state.projects)) entry.attached = false;
    save();
    const supervisor = new ProjectSupervisor(config, home, stateDirectory, state, save, lock);
    supervisor.executionAuthority = executionAuthority;
    await executionAuthority?.fence();
    executionAuthority?.assert();
    let metadataApproval;
    if (config.metadataReadOnly) {
      check(!state.metadataLaunch, "metadata_launch_reconciliation_required");
      state.metadataLaunch = {
        phase: "reservationRequested",
        projectsDigest: hash(JSON.stringify(config.projects)),
      };
      save();
      let timer;
      try {
        metadataApproval = validateMetadataApproval(
          await Promise.race([
            Promise.resolve().then(() =>
              dependencies.metadataAuthority({ projects: structuredClone(config.projects) }),
            ),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("metadata_authority_timeout")), 5000);
            }),
          ]),
          config.projects,
        );
      } finally {
        clearTimeout(timer);
      }
      executionAuthority?.assert();
      state.metadataLaunch = { phase: "reserved", approval: metadataApproval };
      save();
    }
    runtime = await (dependencies.runtimeFactory ?? launchNative)({
      config,
      home,
      stateDirectory,
      lock,
      executionAuthority,
      metadataApproval,
    });
    executionAuthority?.assert();
    if (executionAuthority) {
      const nativeCall = runtime.call.bind(runtime);
      runtime.call = async (...args) => {
        executionAuthority.assert();
        const result = await nativeCall(...args);
        executionAuthority.assert();
        return result;
      };
    }
    supervisor.runtime = runtime;
    if (config.metadataReadOnly) {
      check(
        runtime.metadataPins?.metadataPolicyDigest === metadataApproval.metadataPolicyDigest,
        "metadata_protection_missing",
      );
      state.metadataLaunch = {
        ...state.metadataLaunch,
        phase: "started",
        pins: runtime.metadataPins,
      };
      save();
    }
    if (dependencies.managerAdapter) supervisor.setManagerAdapter(dependencies.managerAdapter);
    runtime.onClose(() => supervisor.revoke());
    check(runtime.version === VERSION && runtime.alive(), "unsupported_native_runtime");
    state.status = "ready";
    state.nativeProcess = runtime.processIdentity ?? null;
    state.executionIdentity = runtime.executionIdentity ?? {
      mode: "direct",
      native: state.nativeProcess,
    };
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
    this.executionRevocations = new Map();
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
    this.executionAuthority?.assert();
    check(!this.closed && !this.busy && this.state.status === "ready", "supervisor_busy_or_closed");
    const existing = this.config.projects.find((p) => p.projectId === project.projectId);
    if (existing) {
      check(JSON.stringify(existing) === JSON.stringify(project), "project_binding_conflict");
      // Existing durable enrollment also supports history-only recovery after
      // checkout cleanup. Every execution command independently verifies lease.
      return;
    }
    check(!this.config.metadataReadOnly, "metadata_inventory_fixed");
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
    check(!this.state.projects[project.projectId]?.executionRevoked, "project_execution_revoked");
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
  async revokeExecution(projectId, reason = "lease_renewal_failed") {
    const previous = this.executionRevocations.get(projectId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => this.stopProjectExecution(projectId, reason));
    this.executionRevocations.set(projectId, operation);
    try {
      return await operation;
    } finally {
      if (this.executionRevocations.get(projectId) === operation)
        this.executionRevocations.delete(projectId);
    }
  }
  async stopProjectExecution(projectId, reason) {
    this.project(projectId);
    const entry = this.state.projects[projectId];
    check(
      entry?.threadId && entry.serverInstanceId === this.state.serverInstanceId,
      "native_thread_unavailable",
    );
    entry.executionRevoked ??= { reason, at: Date.now(), reviewRequired: true };
    entry.executionRevoked.reviewRequired = true;
    this.save(); // Fence all new execution before any best-effort interruption.
    let interrupted = true,
      detached = false;
    const deadline = Date.now() + 10000;
    const targets = [
      entry.threadId,
      ...Object.entries(entry.children ?? {})
        .filter(([, child]) => child.serverInstanceId === this.state.serverInstanceId)
        .map(([threadId]) => threadId),
    ];
    for (const threadId of targets) {
      try {
        check(this.runtime.alive() && Date.now() < deadline, "native_lifetime_revoked");
        const latest = await this.runtime.call("thread/turns/list", {
          threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
        });
        check(Array.isArray(latest?.data) && latest.data.length <= 1, "invalid_native_history");
        const turn = latest.data[0];
        if (turn?.status === "inProgress") {
          check(id(turn.id), "invalid_native_turn");
          await this.runtime.call("turn/interrupt", { threadId, turnId: turn.id });
        } else
          check(
            !turn || ["completed", "interrupted", "failed"].includes(turn.status),
            "unknown_native_turn_state",
          );
      } catch {
        interrupted = false;
      }
    }
    try {
      check(Date.now() < deadline, "native_quiescence_unproven");
      // An interrupt acknowledgement alone does not establish child quiescence.
      // Unknown active threads retain the hold; never infer ownership from
      // sharing a native server with a registered project.
      const loaded = await this.runtime.call("thread/loaded/list", { limit: 64 });
      check(
        Array.isArray(loaded?.data) &&
          loaded.data.length <= 64 &&
          !loaded.nextCursor &&
          loaded.data.includes(entry.threadId) &&
          new Set(loaded.data).size === loaded.data.length,
        "native_thread_inventory_incomplete",
      );
      const otherProjects = new Set(
        Object.entries(this.state.projects)
          .filter(
            ([key, value]) =>
              key !== projectId && value.serverInstanceId === this.state.serverInstanceId,
          )
          .flatMap(([, value]) => [
            value.threadId,
            ...Object.entries(value.children ?? {})
              .filter(([, child]) => child.serverInstanceId === this.state.serverInstanceId)
              .map(([threadId]) => threadId),
          ]),
      );
      for (const threadId of loaded.data) {
        check(Date.now() < deadline, "native_quiescence_unproven");
        check(id(threadId), "invalid_native_thread");
        if (otherProjects.has(threadId)) continue;
        const result = await this.runtime.call("thread/read", { threadId, includeTurns: false });
        check(
          result?.thread?.id === threadId && result.thread.status?.type === "idle",
          "native_quiescence_unproven",
        );
      }
    } catch {
      interrupted = false;
    }
    try {
      if (entry.attached) await this.runtime.detach(projectId);
      detached = true;
      entry.attached = false;
    } catch {}
    entry.executionRevoked.reviewRequired = !interrupted || !detached;
    this.save();
    return entry.executionRevoked;
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
  async provePreExecution(projectId, creationIntentId) {
    check(
      !this.closed && !this.busy && this.state.status === "ready" && this.runtime.alive(),
      "retry_not_available",
    );
    const project = this.project(projectId);
    this.busy = true;
    try {
      this.lease(project);
      const entry = this.state.projects[projectId];
      if (!entry) return { threadId: null };
      check(
        entry.creationIntentId === creationIntentId &&
          entry.repositoryId === project.repositoryId &&
          entry.serverInstanceId === this.state.serverInstanceId &&
          entry.phase === "awaitingFirstTurn" &&
          !entry.firstPrompt &&
          !entry.executionRevoked &&
          id(entry.threadId),
        "retry_not_available",
      );
      const loaded = await this.runtime.call("thread/loaded/list", { limit: 64 });
      check(
        Array.isArray(loaded?.data) &&
          loaded.data.length <= 64 &&
          !loaded.nextCursor &&
          loaded.data.includes(entry.threadId),
        "retry_not_available",
      );
      const turns = await this.runtime
        .call("thread/turns/list", {
          threadId: entry.threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
        })
        .catch(() => {
          throw new Error("retry_history_unavailable");
        });
      check(
        Array.isArray(turns?.data) && turns.data.length === 0 && !turns.nextCursor,
        "retry_not_available",
      );
      return { threadId: entry.threadId };
    } finally {
      this.busy = false;
    }
  }
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
  // Installed observer only: these methods are absent from command() and the
  // browser RPC allowlist. The observer supplies native-proven spawn identity.
  registerChild(managerThreadId, childThreadId, spawnCallId) {
    check(
      !this.closed &&
        [managerThreadId, childThreadId, spawnCallId].every(id) &&
        managerThreadId !== childThreadId,
      "invalid_native_child",
    );
    const project = this.config.projects.find(
      (p) => this.state.projects[p.projectId]?.threadId === managerThreadId,
    );
    check(
      project && this.registrationBinding(project.projectId).threadId === managerThreadId,
      "manager_thread_unregistered",
    );
    const entry = this.state.projects[project.projectId];
    const existing = entry.children?.[childThreadId];
    if (existing) {
      check(
        existing.spawnCallId === spawnCallId &&
          existing.serverInstanceId === this.state.serverInstanceId,
        "native_child_conflict",
      );
      return;
    }
    check(
      Object.keys(entry.children ?? {}).length < 64 &&
        !Object.values(this.state.projects).some(
          (other) =>
            other.threadId === childThreadId ||
            Object.entries(other.children ?? {}).some(
              ([key, child]) =>
                key === childThreadId || (other === entry && child.spawnCallId === spawnCallId),
            ),
        ),
      "native_child_conflict",
    );
    entry.children ??= {};
    entry.children[childThreadId] = { spawnCallId, serverInstanceId: this.state.serverInstanceId };
    if (entry.executionRevoked) entry.executionRevoked.reviewRequired = true;
    this.save();
    // A delayed spawn observation after revocation must lose execution too.
    if (entry.executionRevoked) void this.revokeExecution(project.projectId).catch(() => {});
  }
  async readNativeHistory(request) {
    check(
      !this.closed &&
        exact(request, ["managerThreadId", "childThreadId", "spawnCallId"]) &&
        Object.keys(request).length === 3 &&
        Object.values(request).every(id),
      "invalid_native_child",
    );
    const project = this.config.projects.find(
      (p) => this.state.projects[p.projectId]?.threadId === request.managerThreadId,
    );
    const entry = project && this.state.projects[project.projectId],
      child = entry?.children?.[request.childThreadId];
    check(
      project &&
        child?.spawnCallId === request.spawnCallId &&
        child.serverInstanceId === this.state.serverInstanceId &&
        this.registrationBinding(project.projectId).threadId === request.managerThreadId,
      "native_child_unregistered",
    );
    const history = await this.runtime.call("thread/turns/list", {
      threadId: request.childThreadId,
      limit: 20,
      sortDirection: "asc",
      itemsView: "full",
    });
    check(
      Array.isArray(history?.data) &&
        history.data.length <= 20 &&
        Buffer.byteLength(JSON.stringify(history)) <= 2 * 1024 * 1024 &&
        (history.nextCursor == null || typeof history.nextCursor === "string"),
      "invalid_native_history",
    );
    return { data: history.data, nextCursor: history.nextCursor ?? null };
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
    if (adapter.progressionProtocol === 1) {
      check(
        typeof adapter.assertProgressionAuthority === "function",
        "manager_progression_authority_callback_required",
      );
      check(
        !Object.values(this.state.projects).some((entry) => entry.attached),
        "manager_cli_attachment_conflict",
      );
    }
    this.managerAdapter = adapter;
    this.runtime.setManagerAdapter({
      handleToolCall: async (params) => {
        await this.executionAuthority?.fence();
        this.executionAuthority?.assert();
        const project = this.config.projects.find(
          (p) => this.state.projects[p.projectId]?.threadId === params.threadId,
        );
        check(
          project && this.registrationBinding(project.projectId).threadId === params.threadId,
          "manager_thread_unregistered",
        );
        const result = await adapter.handleToolCall(params);
        this.executionAuthority?.assert();
        return result;
      },
      observe: adapter.observe
        ? (notification) => {
            const threadId = notification?.params?.threadId;
            const project = this.config.projects.find(
              (p) => this.state.projects[p.projectId]?.threadId === threadId,
            );
            if (project && this.registrationBinding(project.projectId).threadId === threadId)
              return adapter.observe(notification);
            if (
              !(
                adapter.progressionProtocol === 1
                  ? [
                      "turn/started",
                      "turn/completed",
                      "item/started",
                      "item/completed",
                      "rawResponseItem/completed",
                    ]
                  : ["turn/started", "turn/completed", "item/completed"]
              ).includes(notification.method)
            )
              return;
            const parent = this.config.projects.find((p) => {
              const entry = this.state.projects[p.projectId];
              return entry?.children?.[threadId]?.serverInstanceId === this.state.serverInstanceId;
            });
            if (parent && this.registrationBinding(parent.projectId))
              return adapter.observe(notification);
          }
        : undefined,
    });
  }
  // Installed protocol-one callbacks only. These are deliberately absent from
  // command(), the gateway and the browser/native read RPC allowlists.
  deliveryProgressionProject(request) {
    this.executionAuthority?.assert();
    check(
      this.managerAdapter?.progressionProtocol === 1 &&
        !this.closed &&
        this.state.status === "ready" &&
        this.runtime.alive(),
      "manager_progression_unavailable",
    );
    const project = this.config.projects.find(
      (value) => this.state.projects[value.projectId]?.threadId === request.managerThreadId,
    );
    check(project, "manager_thread_unregistered");
    const entry = this.state.projects[project.projectId];
    check(
      !entry.attached &&
        !entry.executionRevoked &&
        entry.serverInstanceId === this.state.serverInstanceId &&
        entry.phase === "persisted",
      "manager_input_admission_unavailable",
    );
    this.registrationBinding(project.projectId);
    const lease = this.lease(project),
      context = request.checkoutBinding;
    check(
      context?.projectId === project.projectId &&
        context.preparationIntentId === project.taskId &&
        context.repositoryId === project.repositoryId &&
        context.leaseId === project.leaseId &&
        context.leaseGeneration === project.leaseGeneration &&
        context.revision === lease.revision &&
        /^[a-f0-9]{40}$/.test(context.revision),
      "manager_progression_checkout_changed",
    );
    check(
      [request.parentTurnId, request.priorAttemptId, request.requestId].every(id) &&
        Number.isInteger(request.cursorVersion) &&
        request.cursorVersion > 0 &&
        Array.isArray(request.spawns) &&
        request.spawns.length <= 1 &&
        Array.isArray(request.cohort) &&
        request.cohort.length <= 20,
      "invalid_manager_progression_request",
    );
    this.managerAdapter.assertProgressionAuthority(request);
    return { project, entry };
  }
  async readDeliveryBoundary(request, { nextParentTurnId, excludeCall } = {}) {
    const { entry } = this.deliveryProgressionProject(request);
    check(
      typeof this.runtime.inspectManagerRouting === "function" &&
        typeof this.runtime.drainManagerRouting === "function",
      "manager_router_accounting_required",
    );
    const deadline = Date.now() + 10000;
    const read = async (method, params) => {
      check(Date.now() < deadline && this.runtime.alive(), "manager_boundary_deadline");
      return this.runtime.call(method, params);
    };
    const history = async (threadId) => {
      const result = [],
        cursors = new Set();
      let cursor;
      for (let page = 0; page < 8; page++) {
        const value = await read("thread/turns/list", {
          threadId,
          limit: 20,
          sortDirection: "asc",
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
        });
        check(
          Array.isArray(value?.data) &&
            value.data.length <= 20 &&
            Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024,
          "manager_history_incomplete",
        );
        for (const turn of value.data) {
          check(
            id(turn.id) &&
              turn.itemsView === "full" &&
              Array.isArray(turn.items) &&
              turn.items.length <= 512 &&
              !turn.truncated,
            "manager_history_incomplete",
          );
          const items = [],
            itemCursors = new Set();
          let itemCursor;
          for (let itemPage = 0; itemPage < 8; itemPage++) {
            const part = await read("thread/items/list", {
              threadId,
              turnId: turn.id,
              limit: 100,
              sortDirection: "asc",
              ...(itemCursor ? { cursor: itemCursor } : {}),
            });
            check(
              Array.isArray(part?.data) &&
                part.data.length <= 100 &&
                Buffer.byteLength(JSON.stringify(part)) <= 2 * 1024 * 1024,
              "manager_history_incomplete",
            );
            items.push(...part.data.map((value) => value.item));
            check(
              items.length <= 512 &&
                part.data.every(
                  (value) => value.turnId === turn.id && value.item && id(value.item.id),
                ),
              "manager_history_incomplete",
            );
            itemCursor = part.nextCursor;
            if (!itemCursor) break;
            check(
              typeof itemCursor === "string" && !itemCursors.has(itemCursor) && itemPage < 7,
              "manager_history_incomplete",
            );
            itemCursors.add(itemCursor);
          }
          check(
            new Set(items.map((item) => item.id)).size === items.length &&
              JSON.stringify(items.map((item) => item.id)) ===
                JSON.stringify(turn.items.map((item) => item.id)) &&
              JSON.stringify(items) === JSON.stringify(turn.items),
            "manager_history_incomplete",
          );
          result.push(turn);
          check(result.length <= 20, "manager_history_limit");
        }
        cursor = value.nextCursor;
        if (!cursor) return result;
        check(typeof cursor === "string" && !cursors.has(cursor), "manager_history_incomplete");
        cursors.add(cursor);
      }
      throw new Error("manager_history_incomplete");
    };
    for (let round = 0; round < 3; round++) {
      await this.runtime.drainManagerRouting({ excludeCall, timeoutMs: 5000 });
      const sequence = this.runtime.inspectManagerRouting({ excludeCall }).receiveSequence;
      const root = await history(request.managerThreadId);
      const previous = root.find((turn) => turn.id === request.parentTurnId);
      check(
        previous?.status === "completed" &&
          root.every((turn) => turn.id === nextParentTurnId || turn.status === "completed"),
        "manager_root_not_completed",
      );
      const priorRequestId =
        entry.firstPrompt?.turnId === request.parentTurnId
          ? entry.firstPrompt.requestId
          : Object.entries(entry.deliveryContinuations ?? {}).find(
              ([, value]) => value.receipt?.nextParentTurnId === request.parentTurnId,
            )?.[0];
      const priorInputs = previous.items.filter((item) => item.type === "userMessage");
      check(
        priorRequestId && priorInputs.length === 1 && priorInputs[0].clientId === priorRequestId,
        "manager_parallel_input_detected",
      );
      check(
        root.at(-1)?.id === (nextParentTurnId ?? request.parentTurnId),
        "manager_unexpected_root_turn",
      );
      if (nextParentTurnId) {
        const current = root.at(-1);
        const inputs = current.items.filter((item) => item.type === "userMessage");
        check(
          inputs.length === 1 && inputs[0].clientId === request.requestId,
          "manager_parallel_input_detected",
        );
        check(
          current.status === "inProgress" &&
            root.at(-2)?.id === request.parentTurnId &&
            current.items.every(
              (item) =>
                ["userMessage", "reasoning", "agentMessage"].includes(item.type) ||
                (item.type === "dynamicToolCall" &&
                  item.tool === "hive_delivery" &&
                  item.arguments?.operation === "claim_step" &&
                  item.id === excludeCall?.callId),
            ),
          "manager_work_before_claim_receipt",
        );
      }
      const spawns = previous.items.filter(
        (item) => item.type === "subAgentActivity" && item.kind === "started",
      );
      check(
        spawns.length === request.spawns.length &&
          !previous.items.some(
            (item) =>
              ![
                "userMessage",
                "agentMessage",
                "reasoning",
                "dynamicToolCall",
                "subAgentActivity",
              ].includes(item.type),
          ),
        "manager_spawn_history_incomplete",
      );
      for (const spawn of spawns) {
        const expected = request.spawns.find(
          (value) => value.spawnCallId === spawn.id && value.childThreadId === spawn.agentThreadId,
        );
        const mapped = entry.children?.[spawn.agentThreadId];
        check(
          expected &&
            mapped?.spawnCallId === spawn.id &&
            mapped.serverInstanceId === this.state.serverInstanceId &&
            spawn.model === expected.effectiveModel &&
            spawn.reasoningEffort === expected.effectiveEffort,
          "manager_spawn_history_incomplete",
        );
        const child = await history(spawn.agentThreadId);
        check(
          child.length === 1 &&
            child[0].id === expected.childTurnId &&
            child[0].status === "completed" &&
            !child[0].items.some(
              (item) => item.type === "subAgentActivity" || item.type === "dynamicToolCall",
            ),
          "manager_child_not_terminal",
        );
      }
      const historicSpawns = root.flatMap((turn) =>
        turn.items
          .filter((item) => item.type === "subAgentActivity" && item.kind === "started")
          .map((item) => ({ item, parentTurnId: turn.id })),
      );
      check(
        historicSpawns.length === request.cohort.length &&
          Object.keys(entry.children ?? {}).length === request.cohort.length,
        "manager_cohort_history_incomplete",
      );
      for (const childBinding of request.cohort) {
        const historic = historicSpawns.find(
          (value) =>
            value.parentTurnId === childBinding.parentTurnId &&
            value.item.id === childBinding.spawnCallId &&
            value.item.agentThreadId === childBinding.childThreadId,
        );
        check(
          historic &&
            historic.item.model === childBinding.effectiveModel &&
            historic.item.reasoningEffort === childBinding.effectiveEffort &&
            entry.children?.[childBinding.childThreadId]?.spawnCallId === childBinding.spawnCallId,
          "manager_cohort_history_incomplete",
        );
        if (request.spawns.some((value) => value.childThreadId === childBinding.childThreadId))
          continue;
        const child = await history(childBinding.childThreadId);
        check(
          child.length === 1 &&
            child[0].id === childBinding.childTurnId &&
            child[0].status === "completed" &&
            !child[0].items.some(
              (item) => item.type === "subAgentActivity" || item.type === "dynamicToolCall",
            ),
          "manager_old_child_not_terminal",
        );
      }
      const loaded = await read("thread/loaded/list", { limit: 64 });
      const allowed = new Set([entry.threadId, ...Object.keys(entry.children ?? {})]);
      check(
        Array.isArray(loaded?.data) &&
          loaded.data.length <= 64 &&
          !loaded.nextCursor &&
          new Set(loaded.data).size === loaded.data.length &&
          loaded.data.includes(entry.threadId) &&
          loaded.data.every((threadId) => allowed.has(threadId)),
        "manager_unknown_native_inventory",
      );
      await this.runtime.drainManagerRouting({ excludeCall, timeoutMs: 5000 });
      if (sequence !== this.runtime.inspectManagerRouting({ excludeCall }).receiveSequence)
        continue;
      this.deliveryProgressionProject(request); // Fresh lease/lifetime after all awaits.
      return {
        observedAt: new Date().toISOString(),
        historyDigest: hash(JSON.stringify(root)),
        receiveSequence: sequence,
      };
    }
    throw new Error("manager_history_changed_during_boundary");
  }
  async continueDeliveryRoot(request) {
    check(!this.busy, "supervisor_busy_or_closed");
    this.busy = true;
    try {
      const { entry } = this.deliveryProgressionProject(request);
      entry.deliveryContinuations ??= {};
      const digest = hash(JSON.stringify(request)),
        existing = entry.deliveryContinuations[request.requestId];
      if (existing) {
        check(
          existing.digest === digest &&
            existing.serverInstanceId === this.state.serverInstanceId &&
            existing.phase === "started",
          "manager_continuation_uncertain",
        );
        return structuredClone(existing.receipt);
      }
      check(
        Object.keys(entry.deliveryContinuations).length < 128 &&
          !Object.values(entry.deliveryContinuations).some(
            (value) => value.cursorVersion === request.cursorVersion,
          ),
        "manager_continuation_conflict",
      );
      const boundary = await this.readDeliveryBoundary(request);
      const pending = {
        digest,
        serverInstanceId: this.state.serverInstanceId,
        cursorVersion: request.cursorVersion,
        parentTurnId: request.parentTurnId,
        priorAttemptId: request.priorAttemptId,
        phase: "start-uncertain",
        boundary,
      };
      entry.deliveryContinuations[request.requestId] = pending;
      check(
        Buffer.byteLength(JSON.stringify(this.state)) <= 1024 * 1024,
        "manager_progression_journal_limit",
      );
      this.save(); // Durable before the only native start; never blind-resubmit.
      this.deliveryProgressionProject(request); // Recheck after fsync, immediately before native admission.
      const result = await this.runtime.call("turn/start", {
        threadId: request.managerThreadId,
        clientUserMessageId: request.requestId,
        input: [
          {
            type: "text",
            text: "Continue the same delivery task at the same source revision. Your first delivery operation must be hive_delivery claim_step for the next eligible step. Do not spawn agents, execute tools, report or complete work before the successful new claim receipt. Do not create another task or change source. If no eligible step remains, finish without doing more work.",
            text_elements: [],
          },
        ],
      });
      check(
        id(result?.turn?.id) && result.turn.id !== request.parentTurnId,
        "manager_continuation_start_invalid",
      );
      pending.acknowledgedTurnId = result.turn.id;
      this.save(); // Historical ACK survives a stale post-response authority check.
      this.deliveryProgressionProject(request);
      pending.phase = "started";
      pending.receipt = {
        requestId: request.requestId,
        parentTurnId: request.parentTurnId,
        nextParentTurnId: result.turn.id,
        priorAttemptId: request.priorAttemptId,
        cursorVersion: request.cursorVersion,
        serverInstanceId: this.state.serverInstanceId,
        historyDigest: boundary.historyDigest,
      };
      this.save();
      return structuredClone(pending.receipt);
    } finally {
      this.busy = false;
    }
  }
  async revalidateDeliveryBoundary(request, nextParentTurnId, excludeCall) {
    check(!this.busy, "supervisor_busy_or_closed");
    this.busy = true;
    try {
      const { entry } = this.deliveryProgressionProject(request);
      const saved = entry.deliveryContinuations?.[request.requestId];
      check(
        saved?.phase === "started" &&
          saved.digest === hash(JSON.stringify(request)) &&
          saved.receipt.nextParentTurnId === nextParentTurnId,
        "manager_continuation_receipt_missing",
      );
      return await this.readDeliveryBoundary(request, { nextParentTurnId, excludeCall });
    } finally {
      this.busy = false;
    }
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
    this.executionAuthority?.assert();
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
    await this.executionAuthority?.fence();
    this.executionAuthority?.assert();
    check(!this.closed && !this.busy, "supervisor_busy_or_closed");
    check(
      exact(request, ["operation", "projectId", "creationIntentId", "requestId", "text"]) &&
        id(request.projectId),
      "invalid_command",
    );
    if (this.managerAdapter?.progressionProtocol === 1)
      check(!["attach", "rejoin"].includes(request.operation), "manager_cli_attachment_forbidden");
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
          ...(this.config.executionMode === "isolated"
            ? { permissions: NATIVE_PROFILE, approvalPolicy: "never" }
            : {}),
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
        if (this.config.executionMode === "isolated")
          check(
            started.activePermissionProfile?.id === NATIVE_PROFILE &&
              started.approvalPolicy === "never",
            "native_permission_binding_mismatch",
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
              ...(this.config.executionMode === "isolated"
                ? { permissions: NATIVE_PROFILE, approvalPolicy: "never" }
                : {}),
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
          if (this.config.executionMode === "isolated")
            check(
              resumed.activePermissionProfile?.id === NATIVE_PROFILE &&
                resumed.approvalPolicy === "never",
              "native_permission_binding_mismatch",
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
                // biome-ignore lint/suspicious/noControlCharactersInRegex: Explicitly reject ASCII controls except tab, LF and CR before native input.
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
            check(
              this.managerAdapter?.progressionProtocol !== 1,
              "manager_cli_attachment_forbidden",
            );
            this.binding(project.projectId);
            await this.runtime.attach(entry.threadId, this.checkout(project), project.projectId);
            entry.attached = true;
            this.save();
          }
        }
      }
      this.executionAuthority?.assert();
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
        try {
          await Promise.allSettled([...this.executionRevocations.values()]);
          await this.managerAdapter?.close?.();
        } finally {
          await this.runtime.close();
        }
      } finally {
        closeSync(this.lock);
      }
    }
  }
  async closeAdmission(barrier) {
    const attached = Object.entries(this.state.projects).filter(([, entry]) => entry.attached);
    this.state.guardianBarrier = structuredClone(barrier);
    this.revoke(); // Synchronous input/read-ticket/PTY revocation before awaits.
    this.save();
    for (const [projectId] of attached) {
      check(typeof this.runtime.detach === "function", "cli_input_close_unavailable");
      await this.runtime.detach(projectId); // Fixed owned-session cleanup, never new admission.
    }
  }
}

/** Native server requests have a separate ID namespace from client responses.
 * Only the installed hive_delivery tool can be answered. Approval/input requests
 * remain unanswered; never confuse a server request with a pending client reply. */
export function createNativeManagerRouter(getAdapter, reply) {
  const handlers = new Map(),
    observers = new Set(),
    failures = new Set();
  let receiveSequence = 0;
  const failed = {
    contentItems: [
      { type: "inputText", text: "Delivery controller unavailable or request rejected." },
    ],
    success: false,
  };
  const sameCall = (value, excluded) =>
    excluded &&
    value.threadId === excluded.threadId &&
    value.turnId === excluded.turnId &&
    value.callId === excluded.callId;
  const route = (message) => {
    if (typeof message.method !== "string") return false;
    // RPC history/read responses never advance this notification counter.
    receiveSequence++;
    const adapter = getAdapter();
    if (
      [
        "item/started",
        "item/completed",
        "rawResponseItem/completed",
        "turn/started",
        "turn/completed",
      ].includes(message.method)
    ) {
      try {
        const operation = Promise.resolve(
          adapter?.observe?.({ method: message.method, params: message.params }),
        );
        observers.add(operation);
        void operation
          .catch(() => failures.add(message.params?.threadId ?? "unknown"))
          .finally(() => observers.delete(operation));
      } catch {
        failures.add(message.params?.threadId ?? "unknown");
      }
      return true;
    }
    if (message.method !== "item/tool/call" || !Object.hasOwn(message, "id")) return true;
    const params = message.params;
    const key = `${typeof message.id}:${message.id}`;
    if (
      !adapter ||
      !params ||
      params.tool !== "hive_delivery" ||
      (params.namespace !== null && params.namespace !== undefined) ||
      handlers.size >= 8 ||
      handlers.has(key)
    ) {
      reply(message.id, failed);
      return true;
    }
    const work = Promise.resolve().then(() => adapter.handleToolCall(params));
    handlers.set(key, { ...params, work });
    // The underlying handler remains tracked even if its model-facing reply
    // times out. A timeout is not evidence that late I/O/effects have drained.
    void work.catch(() => {}).finally(() => handlers.delete(key));
    let timer;
    void Promise.race([
      work,
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
      .finally(() => clearTimeout(timer));
    return true;
  };
  route.inspect = ({ excludeCall } = {}) => ({
    receiveSequence,
    pendingObservers: observers.size,
    activeHandlers: [...handlers.values()].filter((value) => !sameCall(value, excludeCall)).length,
    observerFailures: [...failures],
  });
  route.drain = async ({ excludeCall, timeoutMs = 5000 } = {}) => {
    check(
      Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000,
      "invalid_manager_drain_bound",
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      check(!failures.size, "manager_observer_failed");
      const work = [
        ...observers,
        ...[...handlers.values()]
          .filter((value) => !sameCall(value, excludeCall))
          .map((value) => value.work),
      ];
      if (!work.length) return route.inspect({ excludeCall });
      check(Date.now() < deadline, "manager_drain_timeout");
      let timer;
      try {
        await Promise.race([
          Promise.allSettled(work),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("manager_drain_timeout")),
              deadline - Date.now(),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  return route;
}

export const NATIVE_STARTUP_TIMEOUT_MS = 20000;

// One process, one monotonic listener deadline. Durable initialization on the
// workspace volume can exceed the old forty short connection-refusal attempts.
// A failed attempt never starts another process or relaxes native authorization.
export async function waitForNativeSocket({
  child,
  endpoint,
  token,
  executionAuthority,
  deadline,
  signal,
  stop,
}) {
  check(
    Number.isFinite(deadline) && deadline <= performance.now() + NATIVE_STARTUP_TIMEOUT_MS,
    "invalid_native_start_deadline",
  );
  let socket;
  let failure;
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => {
    rejectInterrupted = reject;
  });
  void interrupted.catch(() => {});
  const interrupt = (error) => {
    if (failure) return;
    failure = error;
    socket?.terminate();
    rejectInterrupted(error);
  };
  const exited = () => interrupt(new Error("native_start_failed"));
  const cancelled = () => interrupt(new Error("native_start_cancelled"));
  const assertCurrent = () => {
    if (failure) throw failure;
    check(!signal?.aborted, "native_start_cancelled");
    check(child.exitCode === null && child.signalCode === null, "native_start_failed");
    check(performance.now() < deadline, "native_start_timeout");
    executionAuthority?.assert();
  };
  const guarded = (operation) => Promise.race([operation, interrupted]);
  const timer = setTimeout(
    () => interrupt(new Error("native_start_timeout")),
    Math.max(0, deadline - performance.now()),
  );
  const authorityTimer = setInterval(() => {
    try {
      assertCurrent();
    } catch (error) {
      interrupt(error);
    }
  }, 50);
  child.once("exit", exited);
  child.once("error", exited);
  signal?.addEventListener("abort", cancelled, { once: true });
  try {
    for (;;) {
      assertCurrent();
      await guarded(Promise.resolve().then(() => executionAuthority?.fence()));
      assertCurrent();
      try {
        socket = new WebSocket(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          handshakeTimeout: Math.max(1, Math.min(300, Math.ceil(deadline - performance.now()))),
          maxPayload: 1024 * 1024,
          followRedirects: false,
          perMessageDeflate: false,
        });
        await guarded(
          new Promise((resolveOpen, reject) => {
            socket.once("open", resolveOpen);
            socket.once("error", reject);
            socket.once("unexpected-response", (_request, response) => {
              response.destroy();
              reject(new Error("native_handshake_rejected"));
            });
          }),
        );
      } catch (error) {
        socket?.terminate();
        assertCurrent();
        if (error.message === "native_handshake_rejected") throw error;
        // Only connection failures retry; deadline, authority and cancellation
        // failures escape through assertCurrent and stop this exact lifetime.
        await guarded(sleep(Math.min(100, Math.max(0, deadline - performance.now()))));
        continue;
      }
      await guarded(Promise.resolve().then(() => executionAuthority?.fence()));
      assertCurrent();
      check(socket.readyState === WebSocket.OPEN, "native_disconnected");
      return socket;
    }
  } catch (error) {
    socket?.terminate();
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(authorityTimer);
    child.removeListener("exit", exited);
    child.removeListener("error", exited);
    signal?.removeEventListener("abort", cancelled);
  }
}

export async function launchNative({
  config,
  home,
  stateDirectory,
  lock,
  fixtureProvider,
  executionAuthority,
  metadataApproval,
  signal,
}) {
  check(
    !config.metadataReadOnly || config.executionMode === "isolated",
    "unsupported_metadata_mode",
  );
  const approvedMetadata = config.metadataReadOnly
    ? validateMetadataApproval(metadataApproval, config.projects)
    : undefined;
  await executionAuthority?.fence();
  executionAuthority?.assert();
  check(!signal?.aborted, "native_start_cancelled");
  const executable = readFileSync(config.codexExecutable);
  check(
    realpathSync(config.codexExecutable) === config.codexExecutable &&
      executable.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      hash(executable) === config.codexSha256,
    "native_executable_changed",
  );
  let env = Object.fromEntries(
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
  executionAuthority?.assert();
  const token = randomBytes(32).toString("hex");
  const tokenPath = join(stateDirectory, "native-token");
  atomic(tokenPath, token, true);
  const namespace =
    config.executionMode === "isolated"
      ? prepareNativeNamespace({
          home,
          stateDirectory,
          codexExecutable: config.codexExecutable,
          fixtureProvider,
          metadataApproval: approvedMetadata,
        })
      : null;
  if (namespace) env = namespace.env;
  const nativeArgs = [
    "app-server",
    "--listen",
    endpoint,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    tokenPath,
  ];
  let nativeCommand;
  try {
    nativeCommand = namespace
      ? namespace.command(nativeArgs, { holdLock: true })
      : [config.codexExecutable, ...nativeArgs];
    executionAuthority?.assert();
    check(!signal?.aborted, "native_start_cancelled");
  } catch (error) {
    namespace?.close();
    throw error;
  }
  // Linux parent-death signal survives exec; inherited flock fd prevents a second
  // supervisor until this exact child exits, including abrupt supervisor death.
  const guardian =
    "import ctypes,os,signal,sys\np=int(sys.argv[1])\nr=ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)\nif r!=0 or os.getppid()!=p: sys.exit(1)\nos.execv(sys.argv[2],sys.argv[2:])";
  const startupDeadline = performance.now() + NATIVE_STARTUP_TIMEOUT_MS;
  const child = spawn("/usr/bin/python3", ["-c", guardian, String(process.pid), ...nativeCommand], {
    cwd: home,
    env,
    stdio: ["ignore", "ignore", "ignore", lock],
  });
  let ws;
  let closing = false;
  let callback = () => {};
  let managerAdapter;
  const managerRouter = createNativeManagerRouter(
    () => managerAdapter,
    (id, result) => {
      try {
        executionAuthority?.assert();
      } catch {
        return;
      }
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
  let stopPromise;
  const stop = () => (stopPromise ??= stopRuntime());
  const stopRuntime = async () => {
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
    namespace?.close();
  };
  try {
    ws = await waitForNativeSocket({
      child,
      endpoint,
      token,
      executionAuthority,
      deadline: startupDeadline,
      signal,
      stop,
    });
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
    const call = async (method, params) => {
      await executionAuthority?.fence();
      executionAuthority?.assert();
      const result = await new Promise((resolveCall, reject) => {
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
      executionAuthority?.assert();
      return result;
    };
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
    if (namespace) await namespace.verify(call, namespace.verificationCwd);
    const executionIdentity = namespace
      ? namespace.attest(child.pid)
      : { mode: "direct", native: processIdentity(child.pid) };
    executionAuthority?.assert();
    return {
      version: VERSION,
      processIdentity: executionIdentity.native,
      metadataPins: namespace?.metadataPins ?? null,
      executionIdentity,
      setManagerAdapter: (adapter) => {
        check(!managerAdapter, "manager_adapter_already_installed");
        managerAdapter = adapter;
      },
      inspectManagerRouting: (options) => managerRouter.inspect(options),
      drainManagerRouting: (options) => managerRouter.drain(options),
      call,
      createReadSocket: () => {
        executionAuthority?.assert();
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
      async detach(projectId) {
        check(id(projectId), "invalid_project");
        const socket = join(stateDirectory, "tmux.sock"),
          name = `project-${hash(projectId).slice(0, 24)}`;
        execFileSync("/usr/bin/tmux", ["-S", socket, "kill-session", "-t", `=${name}`], {
          env,
          stdio: "ignore",
          timeout: 2000,
        });
      },
      async attach(threadId, cwd, projectId) {
        await executionAuthority?.fence();
        executionAuthority?.assert();
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
        const cliArgs = [
          "resume",
          "--remote",
          endpoint,
          "--remote-auth-token-env",
          "HIVE_NATIVE_CODEX_TOKEN",
          threadId,
        ];
        const cliCommand = namespace
          ? namespace.command(cliArgs, { cwd })
          : [config.codexExecutable, ...cliArgs];
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
            ...cliCommand,
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
