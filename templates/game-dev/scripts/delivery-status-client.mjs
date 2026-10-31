// Installed host only: current-claim factual read, never a model-selected scope.
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  sourceCanonical as canonical,
  sourceUuid as uuid,
} from "./delivery-source-publisher-journal.mjs";

const PATH = "/api/delivery/host/status";
const check = (v) => {
  if (!v) throw new Error("delivery_status_unavailable");
};
const same = (a, b) => canonical(a) === canonical(b),
  copy = (v) => JSON.parse(canonical(v));
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === keys.slice().sort().join();
const positive = (v) => Number.isSafeInteger(v) && v > 0,
  nonnegative = (v) => Number.isSafeInteger(v) && v >= 0;
const label = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v),
  sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v),
  hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const source = (v) =>
  v === null ||
  (exact(v, ["revisionId", "version", "headSha"]) &&
    uuid(v.revisionId) &&
    positive(v.version) &&
    sha(v.headSha));
const physicalKeys = [
  "projectId",
  "preparationIntentId",
  "repositoryId",
  "revision",
  "leaseId",
  "leaseGeneration",
];
const admissionKeys = [
  "runtimeId",
  "runtimeGeneration",
  "admissionId",
  "admissionGeneration",
  "producerDigest",
  "checkoutIncarnation",
  "barrierGeneration",
];
const of = (v, keys) => Object.fromEntries(keys.map((key) => [key, v[key]]));
const blockers = new Set([
  "task_paused",
  "native_reconciliation_required",
  "preparation_held",
  "attempt_lease_expired",
  "attempt_not_running",
  "source_application_pending",
  "policy_unavailable",
  "acceptance_evaluator_unavailable",
  "acceptance_evaluator_provenance_pending",
  "evidence_missing",
  "evidence_invalid",
  "evidence_provenance_unavailable",
  "evidence_limit",
]);
function context(raw) {
  const c = copy(raw),
    p = c?.checkoutBinding,
    r = c?.registration;
  check(
    [c.ownerId, c.managerBindingId, c.taskId, c.stepId, c.attemptId].every(uuid) &&
      positive(c.attemptLeaseGeneration) &&
      sha(c.inputSourceSha) &&
      source(c.sourceContext ?? null),
  );
  check(
    exact(r, ["id", "serverInstanceId", "expiresAt"]) &&
      uuid(r.id) &&
      label(r.serverInstanceId) &&
      positive(r.expiresAt) &&
      r.expiresAt > Date.now(),
  );
  check(
    exact(p, physicalKeys) &&
      [p.projectId, p.preparationIntentId, p.leaseId].every(uuid) &&
      /^[1-9][0-9]{0,19}$/.test(p.repositoryId) &&
      sha(p.revision) &&
      positive(p.leaseGeneration),
  );
  check(typeof c.checkoutPath === "string" && realpathSync(c.checkoutPath) === c.checkoutPath);
  return {
    ...of(c, [
      "ownerId",
      "managerBindingId",
      "taskId",
      "stepId",
      "attemptId",
      "attemptLeaseGeneration",
      "inputSourceSha",
      "checkoutPath",
    ]),
    sourceContext: c.sourceContext ?? null,
    checkoutBinding: p,
    registration: r,
  };
}
function metadata(raw, c) {
  const m = copy(raw);
  check(
    exact(m, [
      ...admissionKeys,
      "metadataPins",
      "metadataPinsDigest",
      "metadataPolicyDigest",
      "namespaceReceiptDigest",
    ]) &&
      [m.runtimeId, m.admissionId, m.checkoutIncarnation].every(uuid) &&
      [m.runtimeGeneration, m.admissionGeneration].every(positive) &&
      nonnegative(m.barrierGeneration) &&
      [
        m.producerDigest,
        m.metadataPinsDigest,
        m.metadataPolicyDigest,
        m.namespaceReceiptDigest,
      ].every(hex),
  );
  check(exact(m.metadataPins, ["checkout", "git"]));
  for (const [key, path] of [
    ["checkout", c.checkoutPath],
    ["git", `${c.checkoutPath}/.git`],
  ]) {
    const pin = m.metadataPins[key],
      stat = lstatSync(path, { bigint: true });
    check(
      exact(pin, ["device", "inode"]) &&
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        same(pin, { device: String(stat.dev), inode: String(stat.ino) }),
    );
  }
  return m;
}
function validate(v, input, c, m) {
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
      "task",
      "step",
      "attempt",
      "source",
      "evidence",
      "blockers",
      "executionAuthorized",
      "publicationAuthorized",
      "cleanupAuthorized",
    ]) &&
      v.schemaVersion === 1 &&
      v.action === input.action &&
      v.requestId === input.requestId &&
      [v.executionAuthorized, v.publicationAuthorized, v.cleanupAuthorized].every(
        (x) => x === false,
      ),
  );
  check(
    nonnegative(v.observedAt) &&
      v.observedAt <= Date.now() &&
      positive(v.expiresAt) &&
      v.expiresAt > Date.now() &&
      v.expiresAt <= input.expiresAt &&
      v.expiresAt <= c.registration.expiresAt &&
      v.expiresAt - v.observedAt <= 30000,
  );
  const scope = {
    ownerId: c.ownerId,
    registrationId: input.registrationId,
    serverInstanceId: input.serverInstanceId,
    managerThreadId: input.managerThreadId,
    managerBindingId: c.managerBindingId,
    checkoutBindingDigest: v.scope?.checkoutBindingDigest,
    checkoutBinding: c.checkoutBinding,
    taskId: c.taskId,
    stepId: c.stepId,
    attemptId: c.attemptId,
    attemptLeaseGeneration: c.attemptLeaseGeneration,
    inputSourceSha: c.inputSourceSha,
    inputSourceContext: c.sourceContext,
  };
  check(
    hex(v.scope?.checkoutBindingDigest) &&
      same(v.scope, scope) &&
      same(v.admission, of(m, admissionKeys)) &&
      same(v.metadata, {
        pins: m.metadataPins,
        pinsDigest: m.metadataPinsDigest,
        policyDigest: m.metadataPolicyDigest,
        namespaceReceiptDigest: m.namespaceReceiptDigest,
      }),
  );
  check(
    exact(v.task, ["version", "pauseRequested", "schedulingPaused"]) &&
      nonnegative(v.task.version) &&
      typeof v.task.pauseRequested === "boolean" &&
      typeof v.task.schedulingPaused === "boolean",
  );
  check(
    exact(v.step, [
      "kind",
      "state",
      "version",
      "acceptancePhase",
      "criterionIds",
      "requiredEvidenceKinds",
    ]) &&
      [v.step.kind, v.step.state, v.step.acceptancePhase].every(label) &&
      nonnegative(v.step.version) &&
      Array.isArray(v.step.criterionIds) &&
      v.step.criterionIds.length <= 64 &&
      v.step.criterionIds.every(label) &&
      Array.isArray(v.step.requiredEvidenceKinds) &&
      v.step.requiredEvidenceKinds.length <= 32 &&
      v.step.requiredEvidenceKinds.every(label),
  );
  check(
    exact(v.attempt, ["outcome", "leaseExpiresAt"]) &&
      label(v.attempt.outcome) &&
      nonnegative(v.attempt.leaseExpiresAt),
  );
  check(
    exact(v.source, [
      "physicalBase",
      "headSha",
      "sourceContext",
      "applicationPhase",
      "operationId",
      "pullNumber",
    ]) &&
      v.source.physicalBase === c.checkoutBinding.revision &&
      sha(v.source.headSha) &&
      source(v.source.sourceContext) &&
      v.source.headSha === (v.source.sourceContext?.headSha ?? v.source.physicalBase) &&
      ["base", "accepted", "pending", "applied"].includes(v.source.applicationPhase) &&
      (v.source.operationId === null || uuid(v.source.operationId)) &&
      (v.source.pullNumber === null || positive(v.source.pullNumber)),
  );
  const e = v.evidence;
  check(
    exact(e, ["policyVersion", "requirementStatus", "referenceIds", "observations"]) &&
      (e.policyVersion === null ||
        (typeof e.policyVersion === "string" &&
          e.policyVersion.length > 0 &&
          e.policyVersion.length <= 160)) &&
      ["satisfied", "missing", "held", "informational"].includes(e.requirementStatus) &&
      Array.isArray(e.referenceIds) &&
      e.referenceIds.length <= 40 &&
      e.referenceIds.every(uuid) &&
      Array.isArray(e.observations) &&
      e.observations.length <= 40,
  );
  check(
    e.observations.every(
      (o) =>
        exact(o, [
          "id",
          "kind",
          "status",
          "verificationMode",
          "sourceSha",
          "observedAt",
          "invalidatedAt",
        ]) &&
        uuid(o.id) &&
        [o.kind, o.status, o.verificationMode].every(label) &&
        o.sourceSha === v.source.headSha &&
        nonnegative(o.observedAt) &&
        (o.invalidatedAt === null || nonnegative(o.invalidatedAt)),
    ),
  );
  check(
    Array.isArray(v.blockers) &&
      v.blockers.length <= 16 &&
      v.blockers.every((b) => blockers.has(b)),
  );
}
export function deliveryStatusClientProofPayload(value) {
  const { proof: _proof, ...unsigned } = value;
  return `hive-delivery-status-v1\nPOST\n${PATH}\n${canonical(unsigned)}`;
}
export function createDeliveryStatusClient(options = {}) {
  if (options.enabled !== true)
    return {
      read: async () => {
        throw new Error("delivery_status_disabled");
      },
      close: async () => {},
    };
  const {
    hiveOrigin,
    hostPrivateKeyPem,
    currentContext,
    authorizeMetadata,
    fetchImpl = fetch,
    timeoutMs = 8000,
  } = options;
  const url = new URL(hiveOrigin),
    key = createPrivateKey(hostPrivateKeyPem);
  check(
    url.origin === hiveOrigin &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      key.asymmetricKeyType === "ed25519" &&
      typeof currentContext === "function" &&
      typeof authorizeMetadata === "function" &&
      positive(timeoutMs) &&
      timeoutMs <= 10000,
  );
  let closed = false;
  const pending = new Set(),
    controllers = new Set();
  async function read(thread, signal) {
    check(label(thread));
    const guarded = async (fn) => {
      signal.throwIfAborted();
      let abort;
      try {
        return await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => {
            abort = () => reject(new Error("delivery_status_unavailable"));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    };
    const c = context(await guarded(() => currentContext(thread))),
      m = metadata(await guarded(() => authorizeMetadata(copy(c))), c),
      now = Date.now();
    const input = {
      schemaVersion: 1,
      action: "read_delivery_status",
      requestId: randomUUID(),
      registrationId: c.registration.id,
      serverInstanceId: c.registration.serverInstanceId,
      managerThreadId: thread,
      checkoutBinding: c.checkoutBinding,
      ...of(c, [
        "managerBindingId",
        "taskId",
        "stepId",
        "attemptId",
        "attemptLeaseGeneration",
        "inputSourceSha",
      ]),
      inputSourceContext: c.sourceContext,
      issuedAt: now,
      expiresAt: Math.min(now + 30000, c.registration.expiresAt),
    };
    const body = canonical({
      ...input,
      proof: sign(null, Buffer.from(deliveryStatusClientProofPayload(input)), key).toString(
        "base64url",
      ),
    });
    check(Buffer.byteLength(body) <= 16384);
    const response = await guarded(async () => {
      const r = await fetchImpl(hiveOrigin + PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "manual",
        signal,
      });
      if (signal.aborted) {
        void r.body?.cancel().catch(() => {});
        throw new Error("delivery_status_unavailable");
      }
      return r;
    });
    check(
      response.status === 200 &&
        (!response.url || response.url === hiveOrigin + PATH) &&
        response.headers.get("content-type")?.split(";")[0] === "application/json",
    );
    const reader = response.body?.getReader();
    check(reader);
    let value;
    try {
      const chunks = [];
      let size = 0;
      for (let i = 0; i < 1024; i++) {
        const part = await guarded(() => reader.read());
        if (part.done) {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          break;
        }
        size += part.value.length;
        check(size <= 32768);
        chunks.push(part.value);
      }
      check(value);
    } finally {
      void reader.cancel().catch(() => {});
    }
    validate(value, input, c, m);
    const after = context(await guarded(() => currentContext(thread))),
      latest = metadata(await guarded(() => authorizeMetadata(copy(after))), after);
    check(
      !closed &&
        !signal.aborted &&
        same(
          {
            ...after,
            registration: { ...after.registration, expiresAt: c.registration.expiresAt },
          },
          c,
        ) &&
        same(latest, m),
    );
    validate(value, input, after, latest);
    return copy(value);
  }
  return {
    read(thread) {
      check(!closed && pending.size < 4);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), timeoutMs);
      controllers.add(controller);
      const promise = read(thread, controller.signal)
        .catch(() => {
          throw new Error("delivery_status_unavailable");
        })
        .finally(() => {
          clearTimeout(timer);
          controller.abort();
          controllers.delete(controller);
          pending.delete(promise);
        });
      pending.add(promise);
      return promise;
    },
    async close() {
      closed = true;
      for (const c of controllers) c.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
