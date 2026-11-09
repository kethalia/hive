// Phase B browser transport guard; scope is supplied by the primary's private plan.
import { isNativeScope, originForScope, parseScope, permitted as phaseA } from "./policy.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{40}$/;
const shortId = /^[A-Za-z0-9_.:-]{1,160}$/;
export function parsePhaseB(raw) {
  const {
    attemptId,
    projectId,
    taskId,
    ownerId,
    buildId,
    serverInstanceId,
    threadId,
    marker,
    start,
    incrementalBudget,
    delivery,
    ...base
  } = raw ?? {};
  const original = parseScope({ ...base, priorForwarded: 0 }, { allowNative: true });
  if (
    !Number.isSafeInteger(base.priorForwarded) ||
    base.priorForwarded < 0 ||
    base.priorForwarded > 1000000
  )
    throw Error("phase_b_scope_rejected");
  if (!Number.isSafeInteger(incrementalBudget) || incrementalBudget < 2 || incrementalBudget > 200)
    throw Error("phase_b_scope_rejected");
  if (isNativeScope(base) && base.priorForwarded + incrementalBudget > 200)
    throw Error("phase_b_scope_rejected");
  if (
    ![attemptId, projectId, ownerId, buildId].every((x) => typeof x === "string" && uuid.test(x)) ||
    !(start === null
      ? typeof taskId === "string" &&
        uuid.test(taskId) &&
        typeof serverInstanceId === "string" &&
        uuid.test(serverInstanceId) &&
        typeof threadId === "string" &&
        shortId.test(threadId)
      : taskId === null && serverInstanceId === null && threadId === null) ||
    typeof marker !== "string" ||
    !(
      /^HIVE_PILOT_[A-Z0-9_]{8,80}$/.test(marker) ||
      (base.workspaceId === "35dded27-d8bd-479c-a44a-f20b766349af" &&
        marker === "HIVE_MANAGED_PILOT_20261107_20G")
    )
  )
    throw Error("phase_b_scope_rejected");
  if (
    delivery != null &&
    (!delivery ||
      Array.isArray(delivery) ||
      Object.keys(delivery).sort().join() !== "eventId,reportId,taskId" ||
      ![delivery.taskId, delivery.reportId, delivery.eventId].every(
        (value) => typeof value === "string" && uuid.test(value),
      ))
  )
    throw Error("phase_b_scope_rejected");
  if (
    start !== null &&
    (!start ||
      Object.keys(start).sort().join() !== "expectedRevision,text" ||
      !sha.test(start.expectedRevision) ||
      typeof start.text !== "string" ||
      !start.text.trim() ||
      Buffer.byteLength(start.text) > 4096)
  )
    throw Error("phase_b_scope_rejected");
  return {
    ...original,
    priorForwarded: base.priorForwarded,
    attemptId,
    projectId,
    taskId,
    ownerId,
    buildId,
    serverInstanceId,
    threadId,
    marker,
    start,
    incrementalBudget,
    delivery: delivery ?? null,
  };
}
export function phaseBPermit(scope, input, method, headers = {}, body = "") {
  try {
    const {
      attemptId,
      projectId,
      taskId,
      ownerId,
      buildId,
      serverInstanceId,
      threadId,
      marker,
      start,
      delivery,
      ...base
    } = scope;
    const u = new URL(input);
    if (isNativeScope(scope) && u.pathname === "/api/auth/logout") return false;
    if (
      delivery &&
      u.origin === originForScope(scope) &&
      !u.hash &&
      !u.username &&
      !u.password &&
      method === "GET" &&
      !new Headers(headers).has("Next-Action") &&
      !new Headers(headers).has("Authorization") &&
      !new Headers(headers).has("Content-Encoding") &&
      !new Headers(headers).has("Upgrade")
    ) {
      const report = u.searchParams.get("report"),
        exactReport =
          [...u.searchParams.keys()].join() === "report" && report === delivery.reportId;
      if (u.pathname === "/api/delivery/tasks") return !u.search;
      if (u.pathname === `/api/delivery/tasks/${delivery.taskId}`) return !u.search || exactReport;
      if (u.pathname === "/workspaces")
        return (
          [...u.searchParams.keys()].sort().join() === "panel,report,task" &&
          u.searchParams.get("panel") === "delivery" &&
          u.searchParams.get("task") === delivery.taskId &&
          report === delivery.reportId
        );
    }
    if (phaseA(base, input, method, headers, body)) return true;
    const h = new Headers(headers),
      prefix = `/api/projects/${projectId}`;
    if (
      u.origin !== originForScope(scope) ||
      u.search ||
      u.hash ||
      u.username ||
      u.password ||
      method !== "POST" ||
      h.has("Next-Action") ||
      h.has("Authorization") ||
      h.has("Content-Encoding") ||
      h.has("Upgrade")
    )
      return false;
    if ([`${prefix}/session-grant`, `${prefix}/terminal-grant`].includes(u.pathname))
      return body === "";
    const data = JSON.parse(body);
    if (!data || Array.isArray(data) || !uuid.test(data.requestId)) return false;
    if (u.pathname === `${prefix}/tasks/status`)
      return (
        Object.keys(data).sort().join() === "requestId,taskId,workspaceId" &&
        data.workspaceId === scope.workspaceId &&
        data.taskId === taskId
      );
    if (u.pathname === `${prefix}/tasks/start` && start)
      return (
        Object.keys(data).sort().join() === "expectedRevision,requestId,text,workspaceId" &&
        data.workspaceId === scope.workspaceId &&
        data.expectedRevision === start.expectedRevision &&
        data.text === start.text
      );
    return false;
  } catch {
    return false;
  }
}
export function phaseBSocket(scope, input) {
  try {
    const u = new URL(input),
      origin = new URL(originForScope(scope));
    return (
      u.protocol === "wss:" &&
      u.host === origin.host &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password &&
      ["session", "terminal"].some(
        (kind) => u.pathname === `/api/projects/${scope.projectId}/${kind}`,
      )
    );
  } catch {
    return false;
  }
}
export function phaseBFrame(kind, data) {
  try {
    if (typeof data !== "string" || Buffer.byteLength(data) > 65536) return false;
    const v = JSON.parse(data);
    if (!v || Array.isArray(v)) return false;
    if (v.type === "authenticate" || v.type === "renew")
      return (
        Object.keys(v).sort().join() === "ticket,type" &&
        typeof v.ticket === "string" &&
        v.ticket.length <= 8192
      );
    if (kind === "terminal")
      return (
        v.type === "resize" &&
        Object.keys(v).sort().join() === "cols,rows,type" &&
        Number.isInteger(v.cols) &&
        v.cols >= 2 &&
        v.cols <= 500 &&
        Number.isInteger(v.rows) &&
        v.rows >= 2 &&
        v.rows <= 500
      );
    return ["initialize", "initialized", "thread/resume", "thread/turns/list"].includes(v.method);
  } catch {
    return false;
  }
}

/** Extract only immutable turn/item identifiers from a bounded history response. */
export function phaseBMarkerItems(frame, marker) {
  if (typeof frame !== "string" || Buffer.byteLength(frame) > 1048576) return [];
  try {
    const value = JSON.parse(frame);
    const turns = value?.result?.data;
    if (!Array.isArray(turns) || turns.length > 100) return [];
    const matches = [];
    for (const turn of turns) {
      if (
        typeof turn?.id !== "string" ||
        turn.id.length > 200 ||
        !Array.isArray(turn.items) ||
        turn.items.length > 1000
      )
        return [];
      for (const item of turn.items)
        if (
          item?.type === "agentMessage" &&
          typeof item.text === "string" &&
          item.text.includes(marker) &&
          typeof item.id === "string" &&
          item.id.length <= 200
        )
          matches.push([turn.id, item.id]);
    }
    return matches;
  } catch {
    return [];
  }
}

/** Preserve earlier usage while reserving the final new exchange for logout. */
export function phaseBHasBudget(scope, forwarded, cleanup = false) {
  return (
    Number.isSafeInteger(forwarded) &&
    forwarded >= scope.priorForwarded &&
    forwarded < scope.priorForwarded + scope.incrementalBudget - (cleanup ? 0 : 1)
  );
}
