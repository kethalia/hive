// Owner-authenticated recovery only. Inspection is not execution authority.
import { createHash } from "node:crypto";

const check = (v) => {
  if (!v) throw new Error("retry_not_available");
};
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === keys.sort().join();
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
export const recoveryDigest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
export const recoveryScopes = Object.freeze({
  "/projects/tasks/recovery-inspect": "projects:task:recovery-inspect",
  "/projects/tasks/recovery-consume": "projects:task:recovery-consume",
});
export function validateRecoveryRequest(path, request) {
  check(Object.hasOwn(recoveryScopes, path));
  check(
    exact(
      request,
      path.endsWith("inspect")
        ? ["schemaVersion", "scope"]
        : ["schemaVersion", "scope", "authorization"],
    ) && request.schemaVersion === 1,
  );
  const s = request.scope;
  check(
    exact(s, [
      "recoveryId",
      "ownerId",
      "coderOwnerId",
      "projectId",
      "taskId",
      "workspaceId",
      "originalRequestId",
      "intentVersion",
      "intentDigest",
      "hostRequestDigest",
      "repositoryId",
      "providerAccountId",
      "revision",
    ]),
  );
  check(
    [
      s.recoveryId,
      s.ownerId,
      s.coderOwnerId,
      s.projectId,
      s.taskId,
      s.workspaceId,
      s.originalRequestId,
    ].every(uuid) &&
      [s.intentDigest, s.hostRequestDigest].every(hex) &&
      typeof s.intentVersion === "string" &&
      s.intentVersion.length <= 64 &&
      [s.repositoryId, s.providerAccountId].every(
        (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v),
      ) &&
      /^[a-f0-9]{40}$/.test(s.revision),
  );
  if (request.authorization) {
    const a = request.authorization;
    check(
      exact(a, ["inspectionDigest", "authorizedVersion", "buildId", "lifetimeId", "expiresAt"]) &&
        hex(a.inspectionDigest) &&
        typeof a.authorizedVersion === "string" &&
        a.authorizedVersion.length <= 64 &&
        uuid(a.buildId) &&
        uuid(a.lifetimeId) &&
        Number.isSafeInteger(a.expiresAt),
    );
  }
}
export const recoveryHeld = (p) => p?.recovery && p.recovery.phase !== "consumed";

export function projectRecovery({
  config,
  guardian,
  buildId,
  save,
  taskDigest,
  prove,
  absent,
  fence,
  schedule,
}) {
  const scope = (p, s) => {
    check(
      guardian &&
        typeof guardian.identity === "function" &&
        guardian.state.phase === "open" &&
        uuid(buildId),
    );
    check(
      s.coderOwnerId === config.ownerId &&
        s.workspaceId === config.workspaceId &&
        s.projectId === p.projectId &&
        s.repositoryId === p.repositoryId &&
        s.providerAccountId === p.expectedAccountId,
    );
    if (p.task)
      check(
        p.task.taskId === s.taskId &&
          p.task.request.requestId === s.originalRequestId &&
          p.task.digest === s.hostRequestDigest &&
          taskDigest(p.task.request) === s.hostRequestDigest &&
          p.task.request.revision === s.revision,
      );
  };
  const facts = async (p, s) => {
    scope(p, s);
    const outcome = p.task ? "existing_preexecution" : "task_absent";
    if (p.task) await prove(p);
    else await absent(p, s);
    return {
      outcome,
      taskFingerprint: recoveryDigest(p.task ?? null),
      buildId,
      lifetimeId: guardian.state.lifetimeId,
      guardianGeneration: guardian.state.generation,
    };
  };
  return async (path, p, request) => {
    validateRecoveryRequest(path, request);
    const s = request.scope;
    scope(p, s);
    if (p.recovery?.phase === "consumed" && p.recovery.scope.recoveryId === s.recoveryId) {
      check(
        path.endsWith("consume") &&
          recoveryDigest(p.recovery.scope) === recoveryDigest(s) &&
          p.recovery.receipt.authorizationDigest === recoveryDigest(request.authorization),
      );
      return structuredClone(p.recovery.receipt); // Historical ACK; never schedule again.
    }
    check(
      !p.recovery ||
        p.recovery.phase === "consumed" ||
        recoveryDigest(p.recovery.scope) === recoveryDigest(s),
    );
    if (path.endsWith("inspect")) {
      check(recoveryHeld(p) || (p.recoveryCount ?? 0) < 32);
      if (!recoveryHeld(p)) {
        p.recovery = { phase: "inspecting", scope: structuredClone(s) };
        p.recoveryCount = (p.recoveryCount ?? 0) + 1;
        save(); // Gate every input/spawn before any asynchronous inspection.
      }
      check(["inspecting", "inspected"].includes(p.recovery.phase));
      const inspected = await facts(p, s);
      if (p.recovery.inspection)
        check(recoveryDigest(inspected) === recoveryDigest(p.recovery.inspection));
      const identity = await guardian.identity(recoveryDigest({ scope: s, inspection: inspected })); // Refuses outer uncertainty; no authority is renewed.
      check(
        identity.identity.lifetimeId === inspected.lifetimeId &&
          identity.startup.generation === inspected.guardianGeneration,
      );
      p.recovery.inspection = inspected;
      p.recovery.phase = "inspected";
      save();
      return { schemaVersion: 1, scope: s, inspection: inspected, identity };
    }
    const a = request.authorization,
      r = p.recovery;
    check(
      r?.phase === "inspected" &&
        a.inspectionDigest === recoveryDigest(r.inspection) &&
        a.buildId === buildId &&
        a.lifetimeId === guardian.state.lifetimeId &&
        Date.now() < a.expiresAt &&
        a.expiresAt <= Date.now() + 60000,
    );
    check(recoveryDigest(await facts(p, s)) === a.inspectionDigest);
    try {
      r.phase = "consuming";
      r.authorization = structuredClone(a);
      save();
      if (p.task) {
        p.task.phase = "preparing";
        save(); // The durable gate remains closed while obtaining a fresh fence.
        await fence(p, Boolean(p.task.prepared));
      } else await guardian.identity(recoveryDigest(s));
      check(Date.now() < a.expiresAt && guardian.state.lifetimeId === a.lifetimeId);
      r.receipt = {
        schemaVersion: 1,
        recoveryId: s.recoveryId,
        scopeDigest: recoveryDigest(s),
        inspectionDigest: a.inspectionDigest,
        authorizationDigest: recoveryDigest(a),
        outcome: r.inspection.outcome,
        buildId,
        lifetimeId: a.lifetimeId,
      };
      r.phase = "consumed";
      if (p.task) p.task.reason = null;
      save(); // An ACK loss replays this receipt; it cannot repeat the first prompt.
      if (p.task) schedule(p);
      return structuredClone(r.receipt);
    } catch (error) {
      r.phase = "held";
      if (p.task) p.task.phase = "blocked";
      save();
      throw error;
    }
  };
}
