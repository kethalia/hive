// Fixed factual readback only. Independent input/apply authority remains external.
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  sourceCanonical as canonical,
  sourceCheck as check,
  sourceUuid as uuid,
} from "./delivery-source-publisher-journal.mjs";

const PATH = "/api/delivery/source-publication/state";
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === keys.slice().sort().join(",");
const same = (a, b) => canonical(a) === canonical(b),
  copy = (v) => JSON.parse(canonical(v));
const hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
  sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v),
  label = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v),
  provider = (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v),
  positive = (v) => Number.isSafeInteger(v) && v > 0;
const admissionKeys = [
  "runtimeId",
  "runtimeGeneration",
  "admissionId",
  "admissionGeneration",
  "producerDigest",
  "checkoutIncarnation",
  "barrierGeneration",
];
const admissionOf = (v) => Object.fromEntries(admissionKeys.map((k) => [k, v[k]]));
function admission(v) {
  check(
    exact(v, admissionKeys) &&
      [v.runtimeId, v.admissionId, v.checkoutIncarnation].every(uuid) &&
      [v.runtimeGeneration, v.admissionGeneration].every(positive) &&
      hex(v.producerDigest) &&
      Number.isSafeInteger(v.barrierGeneration) &&
      v.barrierGeneration >= 0,
    "source_state_scope_invalid",
  );
  return v;
}
const source = (v) =>
  exact(v, ["revisionId", "version", "headSha"]) &&
  uuid(v.revisionId) &&
  positive(v.version) &&
  sha(v.headSha);
function context(raw) {
  const value = copy(raw),
    registration = value?.registration,
    p = value?.checkoutBinding;
  check(
    [value.ownerId, value.managerBindingId, value.taskId].every(uuid) &&
      exact(registration, ["id", "serverInstanceId", "expiresAt"]) &&
      uuid(registration.id) &&
      label(registration.serverInstanceId) &&
      positive(registration.expiresAt) &&
      registration.expiresAt > Date.now(),
    "source_state_context_invalid",
  );
  check(
    exact(p, [
      "projectId",
      "preparationIntentId",
      "repositoryId",
      "revision",
      "leaseId",
      "leaseGeneration",
    ]) &&
      [p.projectId, p.preparationIntentId, p.leaseId].every(uuid) &&
      provider(p.repositoryId) &&
      sha(p.revision) &&
      positive(p.leaseGeneration),
    "source_state_context_invalid",
  );
  check(
    typeof value.checkoutPath === "string" &&
      resolve(value.checkoutPath) === value.checkoutPath &&
      realpathSync(value.checkoutPath) === value.checkoutPath,
    "source_state_context_invalid",
  );
  return {
    ownerId: value.ownerId,
    managerBindingId: value.managerBindingId,
    taskId: value.taskId,
    registration,
    checkoutBinding: p,
    checkoutPath: value.checkoutPath,
  };
}
const identity = (c, historical) => ({
  ownerId: c.ownerId,
  managerBindingId: c.managerBindingId,
  ...(!historical ? { taskId: c.taskId } : {}),
  registration: { id: c.registration.id, serverInstanceId: c.registration.serverInstanceId },
  checkoutBinding: c.checkoutBinding,
  checkoutPath: c.checkoutPath,
});
function metadata(raw, c) {
  const v = copy(raw);
  check(
    exact(v, [
      ...admissionKeys,
      "metadataPins",
      "metadataPinsDigest",
      "metadataPolicyDigest",
      "namespaceReceiptDigest",
    ]),
    "source_state_metadata_invalid",
  );
  admission(admissionOf(v));
  check(
    [v.metadataPinsDigest, v.metadataPolicyDigest, v.namespaceReceiptDigest].every(hex) &&
      exact(v.metadataPins, ["checkout", "git"]),
    "source_state_metadata_invalid",
  );
  for (const [key, path] of [
    ["checkout", c.checkoutPath],
    ["git", `${c.checkoutPath}/.git`],
  ]) {
    const pins = v.metadataPins[key];
    check(
      exact(pins, ["device", "inode"]) &&
        Object.values(pins).every(
          (n) => typeof n === "string" && /^(0|[1-9][0-9]{0,19})$/.test(n) && BigInt(n) < 2n ** 64n,
        ),
      "source_state_metadata_invalid",
    );
    const stat = lstatSync(path, { bigint: true });
    check(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.dev.toString() === pins.device &&
        stat.ino.toString() === pins.inode,
      "source_state_metadata_changed",
    );
  }
  return v;
}
export function sourceStateClientProofPayload(value) {
  const { proof: _proof, ...unsigned } = value;
  return `hive-source-transport-v1\nPOST\n${PATH}\n${canonical(unsigned)}`;
}
async function active(operation, signal) {
  check(!signal.aborted, "source_state_timeout");
  let abort;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        abort = () => reject(new Error("source_state_timeout"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function bounded(response, signal) {
  check(
    response.status >= 200 &&
      response.status < 300 &&
      response.headers.get("content-type")?.split(";")[0] === "application/json",
    "source_state_request_rejected",
  );
  const reader = response.body?.getReader();
  check(reader, "source_state_response_invalid");
  try {
    const chunks = [];
    let size = 0;
    for (let i = 0; i < 1024; i++) {
      const part = await active(() => reader.read(), signal);
      if (part.done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      size += part.value.length;
      check(size <= 65536, "source_state_response_limit");
      chunks.push(part.value);
    }
    throw new Error("source_state_response_limit");
  } finally {
    let timer;
    try {
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((done) => {
          timer = setTimeout(done, 100);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
function validateResponse(v, input, c, meta, historical) {
  check(
    exact(v, [
      "schemaVersion",
      "action",
      "requestId",
      "observedAt",
      "expiresAt",
      "scope",
      "admission",
      "metadata",
      "accepted",
      "current",
      "isCurrent",
      "publicationAuthorized",
      "executionAuthorized",
    ]) &&
      v.schemaVersion === 1 &&
      v.action === "read_source_state" &&
      v.requestId === input.requestId &&
      v.publicationAuthorized === false &&
      v.executionAuthorized === false &&
      typeof v.isCurrent === "boolean",
    "source_state_response_invalid",
  );
  const now = Date.now();
  check(
    Number.isSafeInteger(v.observedAt) &&
      v.observedAt >= 0 &&
      v.observedAt <= now &&
      positive(v.expiresAt) &&
      v.expiresAt > now &&
      v.expiresAt - v.observedAt <= 30000 &&
      v.expiresAt <= input.expiresAt &&
      v.expiresAt <= c.registration.expiresAt,
    "source_state_response_stale",
  );
  check(
    exact(v.scope, [
      "ownerId",
      "registrationId",
      "serverInstanceId",
      "managerThreadId",
      "managerBindingId",
      "checkoutBindingDigest",
      "checkoutBinding",
      "taskId",
    ]) &&
      v.scope.ownerId === c.ownerId &&
      v.scope.registrationId === c.registration.id &&
      v.scope.serverInstanceId === c.registration.serverInstanceId &&
      v.scope.managerThreadId === input.managerThreadId &&
      v.scope.managerBindingId === c.managerBindingId &&
      v.scope.taskId === input.taskId &&
      same(v.scope.checkoutBinding, c.checkoutBinding) &&
      hex(v.scope.checkoutBindingDigest),
    "source_state_scope_changed",
  );
  admission(v.admission);
  check(
    same(v.admission, admissionOf(meta)) &&
      exact(v.metadata, ["pins", "pinsDigest", "policyDigest", "namespaceReceiptDigest"]) &&
      same(v.metadata.pins, meta.metadataPins) &&
      v.metadata.pinsDigest === meta.metadataPinsDigest &&
      v.metadata.policyDigest === meta.metadataPolicyDigest &&
      v.metadata.namespaceReceiptDigest === meta.namespaceReceiptDigest,
    "source_state_metadata_changed",
  );
  const a = v.accepted,
    current = v.current;
  check(
    exact(a, [
      "operationId",
      "sourceContext",
      "previousRevisionId",
      "parentSha",
      "treeSha",
      "manifestDigest",
      "repositoryId",
      "providerAccountId",
      "fullName",
      "branch",
      "baseBranch",
      "pullRequestId",
      "pullNumber",
      "producingAttemptId",
      "stepId",
      "proofDigest",
    ]) &&
      a.operationId === input.operationId &&
      source(a.sourceContext) &&
      (!input.revisionId || a.sourceContext.revisionId === input.revisionId) &&
      sha(a.parentSha) &&
      sha(a.treeSha) &&
      hex(a.manifestDigest) &&
      a.repositoryId === c.checkoutBinding.repositoryId &&
      provider(a.providerAccountId) &&
      typeof a.fullName === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(a.fullName) &&
      a.branch === `codex/delivery/${input.taskId}/${input.operationId}` &&
      typeof a.baseBranch === "string" &&
      a.baseBranch.length > 0 &&
      a.baseBranch.length <= 255 &&
      provider(a.pullRequestId) &&
      positive(a.pullNumber) &&
      a.pullNumber <= 2147483647 &&
      [a.producingAttemptId, a.stepId].every(uuid) &&
      hex(a.proofDigest),
    "source_state_accepted_invalid",
  );
  check(
    a.sourceContext.version === 1
      ? a.previousRevisionId === null && a.parentSha === c.checkoutBinding.revision
      : uuid(a.previousRevisionId),
    "source_state_chain_invalid",
  );
  check(
    exact(current, ["sourceContext", "headSha", "version", "physicalBase", "branch"]) &&
      source(current.sourceContext) &&
      current.headSha === current.sourceContext.headSha &&
      current.version === current.sourceContext.version &&
      current.version >= a.sourceContext.version &&
      current.physicalBase === c.checkoutBinding.revision &&
      typeof current.branch === "string" &&
      current.branch.length > 0 &&
      current.branch.length <= 255 &&
      v.isCurrent === (current.sourceContext.revisionId === a.sourceContext.revisionId) &&
      (!v.isCurrent ||
        (same(current.sourceContext, a.sourceContext) && current.branch === a.branch)),
    "source_state_chain_invalid",
  );
  if (!historical)
    check(
      v.isCurrent &&
        same(a.sourceContext, current.sourceContext) &&
        current.headSha === a.sourceContext.headSha,
      "source_state_historical_not_applicable",
    );
  return v;
}

export function createDeliverySourceStateClient(options = {}) {
  if (options.enabled !== true)
    return {
      readForApply: async () => {
        throw new Error("source_state_disabled");
      },
      readHistorical: async () => {
        throw new Error("source_state_disabled");
      },
      close: async () => {},
    };
  const {
      hiveOrigin,
      hostPrivateKeyPem,
      currentContext,
      authorizeMetadata,
      fetchImpl = fetch,
      timeoutMs = 10000,
    } = options,
    origin = new URL(hiveOrigin),
    key = createPrivateKey(hostPrivateKeyPem);
  check(
    origin.protocol === "https:" &&
      origin.origin === hiveOrigin &&
      !origin.username &&
      !origin.password &&
      key.asymmetricKeyType === "ed25519" &&
      typeof currentContext === "function" &&
      typeof authorizeMetadata === "function" &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 10000,
    "source_state_configuration_invalid",
  );
  const pending = new Set(),
    controllers = new Set();
  let closed = false;
  async function read(thread, query, historical, signal) {
    check(
      label(thread) &&
        exact(query, [
          "operationId",
          ...(query?.revisionId ? ["revisionId"] : []),
          ...(historical ? ["taskId"] : []),
        ]) &&
        uuid(query.operationId) &&
        (!query.revisionId || uuid(query.revisionId)) &&
        (!historical || uuid(query.taskId)),
      "source_state_query_invalid",
    );
    const c = context(await active(() => currentContext(thread), signal)),
      meta = metadata(await active(() => authorizeMetadata(copy(c)), signal), c),
      now = Date.now(),
      input = {
        schemaVersion: 1,
        action: "read_source_state",
        requestId: randomUUID(),
        registrationId: c.registration.id,
        serverInstanceId: c.registration.serverInstanceId,
        managerThreadId: thread,
        checkoutBinding: c.checkoutBinding,
        taskId: historical ? query.taskId : c.taskId,
        operationId: query.operationId,
        ...(query.revisionId ? { revisionId: query.revisionId } : {}),
        issuedAt: now,
        expiresAt: Math.min(now + 55000, c.registration.expiresAt),
      };
    const envelope = {
        ...input,
        proof: sign(null, Buffer.from(sourceStateClientProofPayload(input)), key).toString(
          "base64url",
        ),
      },
      wire = canonical(envelope);
    check(Buffer.byteLength(wire) <= 16384, "source_state_request_limit");
    const response = await active(
      () =>
        fetchImpl(hiveOrigin + PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: wire,
          redirect: "manual",
          signal,
        }),
      signal,
    );
    if (response.url) check(response.url === hiveOrigin + PATH, "source_state_response_invalid");
    const value = await bounded(response, signal);
    validateResponse(value, input, c, meta, historical);
    const after = context(await active(() => currentContext(thread), signal)),
      latest = metadata(await active(() => authorizeMetadata(copy(after)), signal), after);
    check(
      same(identity(after, historical), identity(c, historical)) &&
        same(latest, meta) &&
        Date.now() < value.expiresAt,
      "source_state_scope_changed",
    );
    return copy(value);
  }
  const begin = (thread, query, historical) => {
    check(!closed, "source_state_closed");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeoutMs);
    controllers.add(controller);
    const promise = read(thread, query, historical, controller.signal)
      .catch((error) => {
        throw new Error(
          /^source_state_[a-z0-9_]+$/.test(error?.message ?? "")
            ? error.message
            : "source_state_unavailable",
        );
      })
      .finally(() => {
        clearTimeout(timer);
        controller.abort();
        controllers.delete(controller);
        pending.delete(promise);
      });
    pending.add(promise);
    return promise;
  };
  return {
    readForApply: (thread, query) => begin(thread, query, false),
    readHistorical: (thread, query) => begin(thread, query, true),
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
