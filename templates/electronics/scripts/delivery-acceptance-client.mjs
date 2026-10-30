// Fixed registered-host transport. Never accepts model-selected identity or URL.
import { createPrivateKey, randomUUID, sign } from "node:crypto";

const PATH = "/api/delivery/host/acceptance";
const canonical = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const same = (a, b) => canonical(a) === canonical(b);
const sameContext = (a, b) =>
  b.registration?.expiresAt > Date.now() &&
  same(
    { ...a, registration: { ...a.registration, expiresAt: 0 } },
    { ...b, registration: { ...b.registration, expiresAt: 0 } },
  );
const check = (v) => {
  if (!v) throw new Error("acceptance_transport_unavailable");
};
const actions = {
  prepare_review: ["candidate"],
  repair_prepare: [],
  complete_verified: ["terminal"],
  repair_ready: ["repairId"],
  claim_acceptance: [],
  read_acceptance_plan: [],
  read_acceptance: ["jobId"],
  start_acceptance: ["jobId", "leaseId", "leaseGeneration", "threadId"],
  finish_acceptance: ["jobId", "leaseId", "leaseGeneration", "receipt", "output"],
};
export function createAcceptanceClient({
  hiveOrigin,
  hostPrivateKeyPem,
  currentContext,
  authorizeMetadata,
  fetchImpl = fetch,
  signal: lifetime,
}) {
  const origin = new URL(hiveOrigin);
  check(
    origin.protocol === "https:" &&
      origin.origin === hiveOrigin &&
      !origin.username &&
      !origin.password,
  );
  const key = createPrivateKey(hostPrivateKeyPem);
  check(key.asymmetricKeyType === "ed25519");
  async function execute(action, fields, signal) {
    signal.throwIfAborted();
    check(
      actions[action] &&
        Object.keys(fields).sort().join() === actions[action].slice().sort().join(),
    );
    const c = structuredClone(currentContext());
    check(c.registration.expiresAt > Date.now());
    const metadata = await authorizeMetadata(c);
    signal.throwIfAborted();
    check(sameContext(c, currentContext()));
    const issuedAt = Date.now();
    const unsigned = {
      schemaVersion: 1,
      action,
      requestId: randomUUID(),
      registrationId: c.registration.id,
      serverInstanceId: c.registration.serverInstanceId,
      managerThreadId: c.managerThreadId,
      checkoutBinding: c.checkoutBinding,
      issuedAt,
      expiresAt: Math.min(issuedAt + 30000, c.registration.expiresAt),
      ...fields,
    };
    const proof = sign(
      null,
      Buffer.from(`hive-delivery-acceptance-v1\nPOST\n${PATH}\n${canonical(unsigned)}`),
      key,
    ).toString("base64url");
    const body = canonical({ ...unsigned, proof });
    check(Buffer.byteLength(body) <= 262144);
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 10000);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let reader, onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(new Error("acceptance_transport_unavailable"));
      combined.addEventListener("abort", onAbort, { once: true });
    });
    try {
      combined.throwIfAborted();
      const response = await Promise.race([
        fetchImpl(`${hiveOrigin}${PATH}`, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body,
          signal: combined,
        }),
        stopped,
      ]);
      check(response.status === 200 && response.body && !response.redirected);
      reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      for (;;) {
        const item = await Promise.race([reader.read(), stopped]);
        if (item.done) break;
        size += item.value.length;
        check(size <= 400000);
        chunks.push(Buffer.from(item.value));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      check(
        value.schemaVersion === 1 &&
          value.action === action &&
          value.requestId === unsigned.requestId &&
          value.expiresAt > Date.now() &&
          value.expiresAt <= unsigned.expiresAt &&
          value.observedAt >= issuedAt - 5000,
      );
      for (const [k, v] of Object.entries({
        ownerId: c.ownerId,
        projectId: c.checkoutBinding.projectId,
        preparationIntentId: c.checkoutBinding.preparationIntentId,
        registrationId: c.registration.id,
        serverInstanceId: c.registration.serverInstanceId,
        managerThreadId: c.managerThreadId,
      }))
        check(value[k] === v);
      check(
        value.executionAuthorized === false &&
          value.publicationAuthorized === false &&
          value.cleanupAuthorized === false &&
          same(value.producer, metadata),
      );
      check(
        !combined.aborted &&
          sameContext(c, currentContext()) &&
          same(metadata, await authorizeMetadata(c)) &&
          sameContext(c, currentContext()),
      );
      signal.throwIfAborted();
      return value.result;
    } finally {
      clearTimeout(timeout);
      combined.removeEventListener("abort", onAbort);
      void reader?.cancel().catch(() => {});
    }
  }
  async function request(action, fields) {
    const deadline = new AbortController(),
      timer = setTimeout(() => deadline.abort(), 10000);
    const signal = AbortSignal.any([deadline.signal, ...(lifetime ? [lifetime] : [])]);
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(new Error("acceptance_transport_unavailable"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      signal.throwIfAborted();
      return await Promise.race([execute(action, fields, signal), stopped]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return { request };
}
