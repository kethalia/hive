// Installed local composition. HTTP callers reach this only after a signed,
// independently bound project capability is verified by codex-project-discovery.
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processIdentity } from "./codex-process-identity.mjs";

const check = (v, code = "project_request_rejected") => {
  if (!v) throw new Error(code);
};
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const number = (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v);
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const projectScopes = Object.freeze({
  "/projects/discover": "projects:discover",
  "/projects/resolve": "projects:resolve",
  "/projects/open": "projects:open",
  "/projects/tasks/start": "projects:task:start",
  "/projects/tasks/status": "projects:task:read",
  "/projects/tasks/retry": "projects:task:retry",
});
export function validateProjectOperation(path, r) {
  const common = ["schemaVersion"];
  if (path === "/projects/discover")
    check(
      exact(r, [...common, "page", "perPage"]) &&
        r.schemaVersion === 1 &&
        Number.isInteger(r.page) &&
        r.page >= 1 &&
        r.page <= 10000 &&
        Number.isInteger(r.perPage) &&
        r.perPage >= 1 &&
        r.perPage <= 100,
    );
  else if (path === "/projects/resolve")
    check(
      exact(r, [...common, "repositoryId", "expectedAccountId"]) &&
        r.schemaVersion === 1 &&
        number(r.repositoryId) &&
        number(r.expectedAccountId),
    );
  else if (path === "/projects/open")
    check(
      exact(r, [...common, "repositoryId", "expectedAccountId", "projectId", "requestId"]) &&
        r.schemaVersion === 1 &&
        number(r.repositoryId) &&
        number(r.expectedAccountId) &&
        uuid(r.projectId) &&
        uuid(r.requestId),
    );
  else if (["/projects/tasks/status", "/projects/tasks/retry"].includes(path))
    check(
      exact(r, [...common, "projectId", "taskId", "requestId"]) &&
        r.schemaVersion === 1 &&
        [r.projectId, r.taskId, r.requestId].every(uuid),
    );
  else if (path === "/projects/tasks/start")
    check(
      exact(r, [
        ...common,
        "repositoryId",
        "expectedAccountId",
        "projectId",
        "taskId",
        "requestId",
        "revision",
        "model",
        "effort",
        "text",
      ]) &&
        r.schemaVersion === 1 &&
        number(r.repositoryId) &&
        number(r.expectedAccountId) &&
        [r.projectId, r.taskId, r.requestId].every(uuid) &&
        /^[a-f0-9]{40}$/.test(r.revision) &&
        typeof r.model === "string" &&
        /^[a-z0-9][a-z0-9._-]{0,99}$/.test(r.model) &&
        ["low", "medium", "high", "xhigh", "max", "ultra"].includes(r.effort) &&
        typeof r.text === "string" &&
        r.text.trim() &&
        Buffer.byteLength(r.text) <= 32768 &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Explicitly reject ASCII controls except tab, LF and CR before native input.
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(r.text),
    );
  else check(false);
  return r;
}
function privatePath(p, dir = false) {
  check(realpathSync(p) === p, "private_state_required");
  const s = lstatSync(p);
  check(
    s.uid === process.getuid() && !(s.mode & 0o077) && (dir ? s.isDirectory() : s.isFile()),
    "private_state_required",
  );
}
function writeAtomic(path, state) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    tmp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
/** Dependencies are installed functions, never HTTP parameters. openRuntime must
 * return the ONE supervisor plus its registration authority for this host. */
export function createProjectController(config, deps) {
  check(exact(config, ["stateDirectory", "ownerId", "workspaceId", "model", "effort"]));
  check(
    uuid(config.ownerId) &&
      uuid(config.workspaceId) &&
      typeof config.model === "string" &&
      ["low", "medium", "high", "xhigh", "max", "ultra"].includes(config.effort),
  );
  const guardian = deps.guardian;
  if (guardian)
    check(
      uuid(deps.guardianBuildId) &&
        ["admit", "executionFence", "assertAdmission"].every(
          (name) => typeof guardian[name] === "function",
        ) &&
        guardian.state?.phase === "open",
      "guardian_dependency_rejected",
    );
  privatePath(config.stateDirectory, true);
  const lock = openSync(
    join(config.stateDirectory, "controller.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false,
    queue = Promise.resolve(),
    runtime = null;
  const admissions = new Map();
  const pending = new Set();
  const historyRecovered = new Set();
  const statePath = join(config.stateDirectory, "projects.json"),
    keyPath = join(config.stateDirectory, "projects.key");
  let state, key;
  try {
    const st = fstatSync(lock);
    check(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077));
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
    });
    if (!existsSync(keyPath)) {
      check(!existsSync(statePath), "journal_key_missing");
      const fd = openSync(
        keyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
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
    key = readFileSync(keyPath);
    check(key.length === 32);
    state = {
      schemaVersion: 1,
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      projects: {},
    };
    if (existsSync(statePath)) {
      privatePath(statePath);
      check(lstatSync(statePath).size <= 4 * 1024 * 1024);
      const saved = JSON.parse(readFileSync(statePath));
      const expected = createHmac("sha256", key).update(JSON.stringify(saved.state)).digest("hex");
      check(
        typeof saved.signature === "string" &&
          saved.signature.length === expected.length &&
          timingSafeEqual(Buffer.from(saved.signature), Buffer.from(expected)),
        "journal_signature_invalid",
      );
      state = saved.state;
      check(
        state.schemaVersion === 1 &&
          state.ownerId === config.ownerId &&
          state.workspaceId === config.workspaceId &&
          Object.keys(state.projects).length <= 32,
        "journal_identity_changed",
      );
    }
  } catch (error) {
    closeSync(lock);
    throw error;
  }
  function save() {
    writeAtomic(statePath, {
      state,
      signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
    });
    const fd = openSync(config.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  if (guardian) {
    // A new guardian must not retroactively certify an earlier worker's tasks.
    try {
      check(
        !state.guardianBarrier &&
          (!state.guardianLifetimeId || state.guardianLifetimeId === guardian.state.lifetimeId) &&
          !Object.values(state.projects).some(
            (p) =>
              p.task &&
              !p.task.guardianPreparation &&
              (p.task.prepared || p.task.nativeCreationAttempted),
          ),
        "guardian_restart_reconciliation_required",
      );
    } catch (error) {
      closeSync(lock);
      throw error;
    }
    state.guardianLifetimeId = guardian.state.lifetimeId;
  }
  state.hostProcess = processIdentity(process.pid);
  save();
  function assertOpen() {
    check(!closed && !state.guardianBarrier, "controller_admission_closed");
    if (guardian) check(guardian.state.phase === "open", "controller_admission_closed");
  }
  function assertAdmission(projectId) {
    assertOpen();
    if (guardian) {
      const token = admissions.get(projectId);
      check(token, "guardian_project_not_admitted");
      guardian.assertAdmission(token);
    }
  }
  async function admitPreparation(p) {
    assertOpen();
    if (!guardian) return;
    const t = p.task;
    check(t && t.digest === digest(t.request), "task_identity_conflict");
    const preparation = {
      schemaVersion: 1,
      stage: "preparation",
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      buildId: deps.guardianBuildId,
      projectId: p.projectId,
      repositoryId: p.repositoryId,
      providerAccountId: p.expectedAccountId,
      taskId: t.taskId,
      requestId: t.request.requestId,
      baseSha: t.request.revision,
      requestDigest: t.digest,
    };
    check(
      !t.guardianPreparation || digest(t.guardianPreparation) === digest(preparation),
      "guardian_preparation_identity_changed",
    );
    if (!t.guardianPreparation) {
      t.guardianPreparation = preparation;
      save(); // Before admission and every Git/helper spawn, not after checkout preparation.
    }
    if (!admissions.has(p.projectId)) {
      const token = await guardian.admit({
        projectId: p.projectId,
        bindingDigest: digest(preparation),
      });
      assertOpen();
      guardian.assertAdmission(token);
      admissions.set(p.projectId, token);
      t.guardianAdmission = structuredClone(token); // Historical ACK, never restart authority.
      save();
    }
  }
  async function fence(p, prepared = false) {
    assertOpen();
    if (!guardian) return;
    await admitPreparation(p);
    if (prepared) check(p.task.guardianPrepared, "guardian_prepared_binding_missing");
    const token = await guardian.executionFence(admissions.get(p.projectId));
    assertOpen();
    guardian.assertAdmission(token);
    admissions.set(p.projectId, token);
    // Appending another project changes the shared ownership generation. Refresh
    // existing opaque tokens before any shared worker/helper assertion; an old
    // token is never silently treated as current authority.
    for (const [projectId, other] of admissions) {
      if (other.generation === guardian.state.generation) continue;
      const refreshed = await guardian.executionFence(other);
      assertOpen();
      guardian.assertAdmission(refreshed);
      admissions.set(projectId, refreshed);
    }
  }
  function bindPrepared(p) {
    if (!guardian) return;
    assertAdmission(p.projectId);
    const t = p.task;
    const binding = {
      schemaVersion: 1,
      preparationDigest: digest(t.guardianPreparation),
      projectId: p.projectId,
      repositoryId: p.repositoryId,
      taskId: t.taskId,
      revision: t.request.revision,
      leaseId: t.prepared.leaseId,
      leaseGeneration: t.prepared.leaseGeneration,
      checkoutIncarnation: t.checkoutIncarnation,
      checkoutIdentity: t.checkoutIdentity,
    };
    check(
      typeof binding.checkoutIncarnation === "string" &&
        binding.checkoutIncarnation.length > 0 &&
        binding.checkoutIdentity &&
        Object.keys(binding.checkoutIdentity).sort().join() === "device,inode" &&
        /^[0-9]{1,24}$/.test(binding.checkoutIdentity.device) &&
        /^[1-9][0-9]{0,24}$/.test(binding.checkoutIdentity.inode) &&
        (!t.guardianPrepared || digest(t.guardianPrepared) === digest(binding)),
      "guardian_prepared_identity_changed",
    );
    if (!t.guardianPrepared) {
      t.guardianPrepared = binding;
      save(); // Separate immutable actual binding; never rewrites the earlier admission digest.
    }
  }
  function project(id) {
    const p = state.projects[id];
    check(p, "project_not_enrolled");
    return p;
  }
  function status(p) {
    const t = p.task;
    return {
      schemaVersion: 1,
      projectId: p.projectId,
      taskId: t.taskId,
      phase: t.phase,
      nativeThreadId: t.nativeThreadId ?? null,
      terminalSessionName: t.terminalSessionName ?? null,
      reason: t.reason ?? null,
    };
  }
  async function resolve(r) {
    assertOpen();
    const result = await deps.resolveRepository({
      schemaVersion: 1,
      operation: "resolve",
      repositoryId: r.repositoryId,
      expectedAccountId: r.expectedAccountId,
    });
    assertOpen();
    if (result?.error)
      throw new Error(
        result.error === "github_auth_required"
          ? "github_auth_required"
          : "repository_identity_changed",
      );
    check(
      result?.schemaVersion === 1 &&
        result.providerAccountId === r.expectedAccountId &&
        result.repository?.providerRepositoryId === r.repositoryId &&
        /^[a-f0-9]{40}$/.test(result.defaultRevision),
      "repository_identity_changed",
    );
    return result;
  }
  function blocked(t, error) {
    if (state.guardianBarrier) return; // Preserve the exact durable closed-barrier snapshot.
    const known = new Set([
      "github_auth_required",
      "repository_identity_changed",
      "checkout_busy",
      "checkout_unavailable",
      "revision_unavailable",
      "model_unavailable",
      "native_unavailable",
      "registration_unavailable",
      "prompt_submission_uncertain",
      "task_identity_conflict",
    ]);
    t.phase = "blocked";
    t.reason = known.has(error?.message) ? error.message : "native_unavailable";
    save();
  }
  async function advance(p) {
    const t = p.task;
    if (closed || !t || (t.phase === "blocked" && !(t.executionRevoked && t.prepared))) return;
    if (t.executionRevoked) historyRecovered.add(p.projectId);
    try {
      await fence(p);
      assertAdmission(p.projectId);
      if (!t.prepared) {
        const resolved = await resolve(t.request);
        await fence(p);
        assertAdmission(p.projectId);
        check(
          resolved.repository.permissions?.push === true && !resolved.repository.archived,
          "repository_identity_changed",
        );
        const inspected = await deps.inspectCheckout(p.repositoryId);
        await fence(p);
        assertAdmission(p.projectId);
        let ready;
        if (
          inspected?.status === "ready" &&
          inspected.lease?.taskId === t.taskId &&
          inspected.revision === t.request.revision &&
          inspected.checkoutVerified === true &&
          inspected.lease.expiresAt > Date.now() / 1000
        )
          ready = inspected;
        else {
          check(!inspected?.lease || inspected.lease.taskId === t.taskId, "checkout_busy");
          ready = await deps.prepareCheckout({
            ...t.request,
            ...(inspected?.lease
              ? { leaseId: inspected.lease.id, generation: inspected.lease.generation }
              : {}),
          });
          await fence(p);
          assertAdmission(p.projectId);
        }
        check(
          ready?.status === "ready" &&
            ready.lease?.taskId === t.taskId &&
            ready.lease.expiresAt > Date.now() / 1000,
          "checkout_unavailable",
        );
        t.checkoutIncarnation = ready.checkoutIncarnation;
        if (guardian) t.checkoutIdentity = structuredClone(ready.checkoutIdentity);
        t.renewalSequence = ready.renewalSequence ?? 0;
        t.prepared = {
          projectId: p.projectId,
          repositoryId: p.repositoryId,
          taskId: t.taskId,
          leaseId: ready.lease.id,
          leaseGeneration: ready.lease.generation,
          model: t.request.model,
          effort: t.request.effort,
        };
        save();
      }
      bindPrepared(p);
      await fence(p, true);
      assertAdmission(p.projectId);
      if (!runtime)
        runtime = await deps.openRuntime(
          Object.values(state.projects).flatMap((q) => (q.task?.prepared ? [q.task.prepared] : [])),
        );
      await fence(p, true);
      assertAdmission(p.projectId);
      const supervisor = runtime.supervisor;
      supervisor.enrollPreparedProject(t.prepared);
      let snap = supervisor.snapshot(p.projectId);
      if (snap.phase === "not-created") {
        check(!t.executionRevoked, "native_unavailable");
        t.nativeCreationAttempted = true;
        save();
        snap = await supervisor.command({
          operation: "ensureProject",
          projectId: p.projectId,
          creationIntentId: t.taskId,
        });
        await fence(p, true);
        assertAdmission(p.projectId);
      }
      if (snap.phase === "rejoinRequired")
        snap = await supervisor.command({ operation: "rejoin", projectId: p.projectId });
      await fence(p, true);
      assertAdmission(p.projectId);
      check(
        snap.threadId && (!t.nativeThreadId || t.nativeThreadId === snap.threadId),
        "native_unavailable",
      );
      if (t.executionRevoked) check(snap.phase === "persisted", "native_unavailable");
      t.nativeThreadId = snap.threadId;
      t.nativeServerInstanceId = snap.serverInstanceId;
      const active = runtime.registration.currentRegistration();
      if (
        !active ||
        active.serverInstanceId !== snap.serverInstanceId ||
        !active.threads.some((x) => x.projectId === p.projectId && x.threadId === snap.threadId)
      ) {
        t.phase = "awaitingRegistration";
        save();
        return;
      }
      if (t.executionRevoked) {
        t.phase = "blocked";
        t.reason = "checkout_unavailable";
        t.terminalSessionName = null;
        save();
        return;
      }
      if (snap.phase === "firstPromptUncertain") {
        throw new Error("prompt_submission_uncertain");
      }
      if (snap.phase === "awaitingFirstTurn") {
        t.phase = "awaitingFirstPrompt";
        t.firstPromptSubmissionAttempted = true;
        save();
        snap = await supervisor.command({
          operation: "firstPrompt",
          projectId: p.projectId,
          requestId: t.request.requestId,
          text: t.request.text,
        });
        await fence(p, true);
        assertAdmission(p.projectId);
      }
      if (snap.phase === "awaitingPersistence")
        snap = await supervisor.command({ operation: "refresh", projectId: p.projectId });
      await fence(p, true);
      assertAdmission(p.projectId);
      if (snap.phase === "persisted") {
        snap = await supervisor.command({ operation: "attach", projectId: p.projectId });
        await fence(p, true);
        assertAdmission(p.projectId);
        t.phase = "running";
        t.terminalSessionName = snap.attached
          ? `project-${createHash("sha256").update(p.projectId).digest("hex").slice(0, 24)}`
          : null;
      } else t.phase = "awaitingFirstPrompt";
      save();
    } catch (error) {
      blocked(t, error);
    }
  }
  function schedule(p) {
    if (
      closed ||
      state.guardianBarrier ||
      pending.has(p.projectId) ||
      (p.task?.phase === "blocked" &&
        !(
          p.task.executionRevoked &&
          p.task.prepared &&
          p.task.nativeThreadId &&
          !historyRecovered.has(p.projectId)
        ))
    )
      return;
    pending.add(p.projectId);
    queue = queue.then(() => advance(p)).finally(() => pending.delete(p.projectId));
  }
  function retry(p, request) {
    // Serialize proof, durable acceptance and scheduling with every transition.
    const operation = queue.then(async () => {
      assertOpen();
      const t = p.task;
      check(
        t && t.taskId === request.taskId && t.digest === digest(t.request),
        "task_identity_conflict",
      );
      check(!t.executionRevoked, "retry_not_available");
      await fence(p, Boolean(t.prepared));
      assertAdmission(p.projectId);
      if (t.phase === "running" || t.retries?.some((r) => r.requestId === request.requestId))
        return status(p);
      check(
        t.phase === "blocked" &&
          [
            "github_auth_required",
            "checkout_busy",
            "checkout_unavailable",
            "revision_unavailable",
            "native_unavailable",
            "registration_unavailable",
          ].includes(t.reason),
        "retry_not_available",
      );
      check(
        t.firstPromptSubmissionAttempted === false &&
          typeof t.nativeCreationAttempted === "boolean",
        "retry_not_available",
      );
      const inspected = await deps.inspectCheckout(p.repositoryId);
      await fence(p, Boolean(t.prepared));
      assertAdmission(p.projectId);
      if (!t.prepared) {
        check(
          !t.nativeCreationAttempted &&
            !t.nativeThreadId &&
            inspected?.status === "not_created" &&
            inspected.lease === null,
          "retry_not_available",
        );
      } else {
        check(
          runtime &&
            inspected?.status === "ready" &&
            inspected.checkoutVerified === true &&
            inspected.revision === t.request.revision &&
            inspected.checkoutIncarnation === t.checkoutIncarnation &&
            inspected.lease?.taskId === t.taskId &&
            inspected.lease.id === t.prepared.leaseId &&
            inspected.lease.generation === t.prepared.leaseGeneration &&
            inspected.lease.expiresAt > Date.now() / 1000,
          "retry_not_available",
        );
        let proof;
        try {
          proof = await runtime.supervisor.provePreExecution(p.projectId, t.taskId);
          await fence(p, true);
          assertAdmission(p.projectId);
        } catch (error) {
          // Native 0.165 cannot read rollout history for some empty loaded
          // threads. Missing history is not evidence that no input occurred.
          if (error?.message === "retry_history_unavailable") return status(p);
          throw error;
        }
        check(
          proof.threadId === (t.nativeThreadId ?? null) &&
            (proof.threadId || t.nativeCreationAttempted === false),
          "retry_not_available",
        );
      }
      check((t.retries?.length ?? 0) < 32, "retry_limit");
      t.retries ??= [];
      t.retries.push({
        requestId: request.requestId,
        acceptedAt: Date.now(),
        intentDigest: t.digest,
      });
      t.phase = "preparing";
      t.reason = null;
      save(); // A lost reply can replay this receipt, never the first prompt.
      schedule(p);
      return status(p);
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  return {
    async handle(path, r) {
      assertOpen();
      validateProjectOperation(path, r);
      if (path === "/projects/resolve") return resolve(r);
      if (path === "/projects/open") {
        const verified = await resolve(r);
        let p = state.projects[r.projectId];
        if (p)
          check(
            p.repositoryId === r.repositoryId && p.expectedAccountId === r.expectedAccountId,
            "repository_identity_changed",
          );
        else {
          check(
            Object.keys(state.projects).length < 32 &&
              !Object.values(state.projects).some((q) => q.repositoryId === r.repositoryId),
            "project_limit_or_identity_conflict",
          );
          p = {
            projectId: r.projectId,
            repositoryId: r.repositoryId,
            expectedAccountId: r.expectedAccountId,
            createdAt: Date.now(),
            task: null,
          };
          state.projects[r.projectId] = p;
          save();
        }
        if (p.task) schedule(p);
        return {
          ...verified,
          projectId: p.projectId,
          phase: p.task?.phase ?? "awaitingTask",
          currentTaskId: p.task?.taskId ?? null,
          nativeThreadId: p.task?.nativeThreadId ?? null,
          terminalSessionName: p.task?.terminalSessionName ?? null,
        };
      }
      const p = project(r.projectId);
      if (path === "/projects/tasks/start") {
        check(
          p.repositoryId === r.repositoryId && p.expectedAccountId === r.expectedAccountId,
          "repository_identity_changed",
        );
        check(r.model === config.model && r.effort === config.effort, "model_unavailable");
        if (p.task)
          check(
            p.task.taskId === r.taskId && p.task.digest === digest(r),
            "task_identity_conflict",
          );
        else {
          p.task = {
            taskId: r.taskId,
            digest: digest(r),
            request: structuredClone(r),
            phase: "preparing",
            createdAt: Date.now(),
            nativeThreadId: null,
            terminalSessionName: null,
            reason: null,
            nativeCreationAttempted: false,
            firstPromptSubmissionAttempted: false,
            retries: [],
          };
          save();
        }
      } else check(p.task?.taskId === r.taskId, "task_identity_conflict");
      if (path === "/projects/tasks/retry") return retry(p, r);
      schedule(p);
      return status(p);
    },
    renewLeases() {
      if (closed || state.guardianBarrier || !runtime) return;
      for (const p of Object.values(state.projects)) {
        if (
          !p.task?.prepared ||
          !p.task.nativeThreadId ||
          p.task.executionRevoked ||
          pending.has(p.projectId)
        )
          continue;
        pending.add(p.projectId);
        queue = queue
          .then(async () => {
            if (closed) return;
            const t = p.task;
            if (t.executionRevoked) return;
            try {
              await fence(p, true);
              assertAdmission(p.projectId);
              // Phase transitions never exempt a live native task from expiry.
              // Inspection also fails closed on changed checkout provenance.
              const lease = runtime.supervisor.lease(t.prepared);
              check(lease?.lease?.expiresAt > Date.now() / 1000, "checkout_unavailable");
              if (
                !["running", "awaitingFirstPrompt"].includes(t.phase) ||
                typeof deps.renewLease !== "function"
              )
                return;
              const binding = runtime.supervisor.registrationBinding(p.projectId),
                active = runtime.registration.currentRegistration();
              check(
                active?.serverInstanceId === binding.serverInstanceId &&
                  active.threads.some(
                    (x) => x.projectId === p.projectId && x.threadId === binding.threadId,
                  ),
                "registration_unavailable",
              );
              if (lease.lease.expiresAt * 1000 - Date.now() > 15 * 60 * 1000) return;
              check(typeof t.checkoutIncarnation === "string", "checkout_unavailable");
              const next = await deps.renewLease(p.projectId);
              await fence(p, true);
              assertAdmission(p.projectId);
              check(
                next?.checkoutIncarnation === t.checkoutIncarnation &&
                  next.revision === t.request.revision &&
                  next.lease?.id === t.prepared.leaseId &&
                  next.lease.taskId === t.taskId &&
                  next.lease.generation === t.prepared.leaseGeneration &&
                  next.lease.expiresAt > Date.now() / 1000 &&
                  Number.isSafeInteger(next.renewalSequence) &&
                  next.renewalSequence > t.renewalSequence,
                "checkout_unavailable",
              );
              t.renewalSequence = next.renewalSequence;
              save();
            } catch {
              if (state.guardianBarrier) return;
              t.executionRevoked = { reason: "lease_renewal_failed", at: Date.now() };
              t.phase = "blocked";
              t.reason = "checkout_unavailable";
              t.terminalSessionName = null;
              save();
              await runtime.supervisor.revokeExecution(p.projectId).catch(() => {});
            }
          })
          .finally(() => pending.delete(p.projectId));
      }
    },
    currentProjectContext(threadId) {
      assertOpen();
      check(runtime, "native_unavailable");
      const p = Object.values(state.projects).find(
        (value) => value.task?.nativeThreadId === threadId,
      );
      check(p?.task?.prepared, "task_identity_conflict");
      if (guardian) {
        check(p.task.guardianPrepared, "guardian_prepared_binding_missing");
        assertAdmission(p.projectId);
      }
      const binding = runtime.supervisor.registrationBinding(p.projectId);
      const registration = runtime.registration.currentRegistration();
      check(
        binding.threadId === threadId &&
          registration?.serverInstanceId === binding.serverInstanceId &&
          registration.threads.some((t) => t.projectId === p.projectId && t.threadId === threadId),
        "registration_unavailable",
      );
      runtime.supervisor.lease(p.task.prepared);
      return {
        projectId: p.projectId,
        preparationIntentId: p.task.taskId,
        repositoryId: p.repositoryId,
        revision: p.task.request.revision,
        leaseId: p.task.prepared.leaseId,
        leaseGeneration: p.task.prepared.leaseGeneration,
      };
    },
    resumePending() {
      if (closed || state.guardianBarrier) return;
      for (const p of Object.values(state.projects))
        if (p.task && (!runtime || p.task.phase !== "running")) schedule(p);
    },
    async drain() {
      await queue;
    },
    assertExecution(projectId) {
      const p = project(projectId);
      if (guardian) check(p.task?.guardianPrepared, "guardian_prepared_binding_missing");
      assertAdmission(projectId);
    },
    executionFence: (projectId) => fence(project(projectId), true),
    assertRuntimeExecution() {
      assertOpen();
      if (guardian)
        for (const p of Object.values(state.projects))
          if (p.task?.guardianPreparation) assertAdmission(p.projectId);
    },
    async fenceRuntimeExecution() {
      assertOpen();
      if (guardian)
        for (const p of Object.values(state.projects))
          if (p.task?.guardianPreparation) {
            await fence(p, Boolean(p.task.prepared));
            assertAdmission(p.projectId);
          }
    },
    closeAdmission(barrier) {
      check(guardian && !state.guardianBarrier, "guardian_barrier_rejected");
      // This is deliberately synchronous: never await an outer RPC from inside
      // its close barrier. The FD client has already closed local admission.
      state.guardianBarrier = structuredClone(barrier);
      save();
      const current = guardian.state;
      const enrolled = Object.values(state.projects).filter((p) => p.task?.guardianPreparation);
      check(
        current.phase === "closed" &&
          barrier?.lifetimeId === current.lifetimeId &&
          barrier.bindingDigest === current.bindingDigest &&
          Number.isSafeInteger(barrier.generation) &&
          barrier.generation >= current.generation &&
          /^[a-f0-9]{64}$/.test(barrier.ownershipDigest) &&
          uuid(barrier.barrierId) &&
          Array.isArray(barrier.projects) &&
          barrier.projects.length === enrolled.length &&
          new Set(barrier.projects.map((p) => p.projectId)).size === enrolled.length &&
          enrolled.every(
            (p) =>
              p.task.guardianAdmission &&
              p.task.guardianPrepared &&
              barrier.projects.some(
                (candidate) =>
                  candidate.projectId === p.projectId &&
                  candidate.bindingDigest === digest(p.task.guardianPreparation),
              ),
          ),
        "guardian_barrier_preparation_uncertain",
      );
      return { closed: true, barrierId: barrier.barrierId, journalDigest: digest(state) };
    },
    loseAdmission() {
      if (!guardian || state.guardianBarrier) return;
      state.guardianBarrier = {
        reason: "guardian_channel_lost",
        lifetimeId: state.guardianLifetimeId,
        at: Date.now(),
      };
      save();
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      closeSync(lock);
    },
  };
}
