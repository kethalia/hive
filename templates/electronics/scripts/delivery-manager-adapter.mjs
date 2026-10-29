// Installed software-host adapter. Never load keys, origins or journal paths from
// native tool arguments. The read-only browser bridge cannot invoke this module.
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createDeliveryNativeSpool, nativeSourceProofPayload } from "./delivery-native-spool.mjs";

const check = (value, reason) => {
  if (!value) throw new Error(reason);
};
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const deliveryManagerToolSpec = {
  type: "function",
  name: "hive_delivery",
  description:
    "Record a delivery task, reserve a fenced step, submit an informational understand report, or complete a step referencing existing trusted evidence. Informational reports create no verification evidence. This tool grants no evidence-producer, release, deployment or native execution authority.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["create_task", "claim_step", "complete_step", "report_step", "fail_attempt"],
      },
      payload: { type: "object" },
    },
    required: ["operation", "payload"],
    additionalProperties: false,
  },
};
export function deliveryProofPayload(value) {
  const { proof: _proof, ...unsigned } = value;
  return `hive-delivery-host-v2\nPOST\n/api/delivery/host\n${JSON.stringify(canonical(unsigned))}`;
}
/** Reduce only native spawn/settings metadata. Prompt text and arbitrary raw
 * response bodies are discarded. Missing pairs remain unresolved, never guessed. */
export function createNativeDelegationObserver(isManagerThread) {
  const pending = new Map();
  return function observe({ method, params } = {}) {
    if (!params || !isManagerThread(params.threadId) || !id(params.turnId)) return null;
    const item = params.item;
    if (!item || typeof item !== "object") return null;
    const requested =
      method === "rawResponseItem/completed" &&
      item.type === "function_call" &&
      item.namespace === "collaboration" &&
      item.name === "spawn_agent";
    const resolved =
      ["item/started", "item/completed"].includes(method) &&
      item.type === "subAgentActivity" &&
      item.kind === "started";
    if (!requested && !resolved) return null;
    const callId = requested ? item.call_id : item.id;
    if (!id(callId)) return null;
    const identity = JSON.stringify([params.threadId, params.turnId, callId]);
    if (!pending.has(identity)) {
      check(pending.size < 128, "native_delegation_observer_limit");
      pending.set(identity, {});
    }
    const entry = pending.get(identity);
    const setting = (v) => {
      if (v === null || v === undefined) return null;
      check(typeof v === "string" && v.length > 0 && v.length <= 160, "invalid_native_setting");
      return v;
    };
    if (requested) {
      check(
        typeof item.arguments === "string" && Buffer.byteLength(item.arguments) <= 32768,
        "invalid_native_spawn",
      );
      const args = JSON.parse(item.arguments);
      const values = {
        requestedModel: setting(args.model),
        requestedEffort: setting(args.reasoning_effort),
      };
      check(
        !entry.requested || JSON.stringify(entry.requested) === JSON.stringify(values),
        "native_delegation_conflict",
      );
      entry.requested = values;
    } else {
      check(
        id(item.agentThreadId) && item.agentThreadId !== params.threadId,
        "invalid_native_child",
      );
      const values = {
        childThreadId: item.agentThreadId,
        effectiveModel: setting(item.model),
        effectiveEffort: setting(item.reasoningEffort),
      };
      check(
        !entry.resolved || JSON.stringify(entry.resolved) === JSON.stringify(values),
        "native_delegation_conflict",
      );
      entry.resolved = values;
    }
    if (!entry.requested || !entry.resolved || entry.emitted) return null;
    entry.emitted = true;
    return {
      managerThreadId: params.threadId,
      parentTurnId: params.turnId,
      spawnCallId: callId,
      ...entry.requested,
      ...entry.resolved,
    };
  };
}
function journal(directory, key, digest) {
  check(resolve(directory) === directory, "invalid_delivery_journal");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  check(
    dir.isDirectory() &&
      !dir.isSymbolicLink() &&
      realpathSync(directory) === directory &&
      dir.uid === process.getuid() &&
      (dir.mode & 0o077) === 0,
    "unsafe_delivery_journal",
  );
  const path = join(directory, `${hash(key)}.json`);
  if (!existsSync(path)) {
    check(readdirSync(directory).length < 1024, "delivery_journal_limit");
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // Event identity survives loss of an unacknowledged local journal write.
      // Changed payload under that native call still conflicts at the controller.
      const hex = hash(key);
      const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      writeFileSync(fd, JSON.stringify({ digest, eventId }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  const stat = lstatSync(path);
  check(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0 &&
      stat.size <= 1024,
    "unsafe_delivery_journal",
  );
  const entry = JSON.parse(readFileSync(path, "utf8"));
  check(
    entry.digest === digest && /^[a-f0-9-]{36}$/.test(entry.eventId),
    "delivery_replay_conflict",
  );
  return entry.eventId;
}
async function readResponse(response, deadline = Date.now() + 10000) {
  check(response.status >= 200 && response.status < 300, "delivery_request_rejected");
  check(
    response.headers.get("content-type")?.split(";")[0] === "application/json",
    "invalid_delivery_response",
  );
  const reader = response.body?.getReader();
  check(reader, "invalid_delivery_response");
  const chunks = [];
  let size = 0;
  let active = true,
    timer;
  try {
    return await Promise.race([
      (async () => {
        for (let reads = 0; reads < 1024 && active; reads++) {
          const part = await reader.read();
          check(active, "delivery_response_timeout");
          if (part.done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
          size += part.value.length;
          check(size <= 65536, "delivery_response_limit");
          chunks.push(part.value);
        }
        throw new Error("delivery_response_limit");
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("delivery_response_timeout")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
    let cancellation;
    try {
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((done) => {
          cancellation = setTimeout(done, 100);
        }),
      ]);
    } finally {
      clearTimeout(cancellation);
    }
  }
}
/** currentRegistration is provided by trusted host registration/heartbeat state.
 * Its thread identities must come from the supervisor, never model arguments. */
export function createDeliveryManagerAdapter(options) {
  const {
    enabled = false,
    hiveOrigin,
    stateDirectory,
    hostPrivateKeyPem,
    currentRegistration,
    currentProjectContext,
    nativeEnabled = false,
    fetchImpl = fetch,
  } = options;
  if (!enabled)
    return {
      tools: () => [],
      handleToolCall: async () => {
        throw new Error("delivery_disabled");
      },
    };
  const origin = new URL(hiveOrigin);
  check(
    origin.protocol === "https:" &&
      origin.origin === hiveOrigin &&
      !origin.username &&
      !origin.password,
    "invalid_delivery_origin",
  );
  const key = createPrivateKey(hostPrivateKeyPem);
  check(key.asymmetricKeyType === "ed25519", "invalid_delivery_key");
  check(typeof currentProjectContext === "function", "trusted_checkout_context_required");
  const progression = options.progressionProtocol === 1;
  check(
    !progression ||
      (nativeEnabled &&
        typeof options.continueRoot === "function" &&
        typeof options.revalidateBoundary === "function" &&
        typeof options.drainNativeRouting === "function"),
    "trusted_progression_callbacks_required",
  );
  const nativeSpool = nativeEnabled
    ? createDeliveryNativeSpool({
        stateDirectory: join(stateDirectory, "native"),
        hostPrivateKeyPem,
        currentRegistration,
        currentServerInstanceId: options.currentServerInstanceId,
        registerChild: options.registerChild,
        readNativeHistory: options.readNativeHistory,
        progressionProtocol: progression ? 1 : 0,
        onHold: options.onObserverHold,
        deliver: async (value) => {
          const deadline = Date.now() + (progression ? 3000 : 10000);
          const proof = sign(null, Buffer.from(nativeSourceProofPayload(value)), key).toString(
            "base64url",
          );
          const response = await fetchImpl(`${hiveOrigin}/api/delivery/native`, {
            method: "POST",
            redirect: "manual",
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...value, proof }),
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
          return readResponse(response, deadline);
        },
      })
    : null;
  const active = new Set();
  const activeRoots = new Map();
  const continuationTasks = new Map();
  let closed = false;
  const assertAuthority = (expected, allowFailure = false) => {
    try {
      const fresh = currentRegistration();
      check(
        !closed &&
          fresh?.id === expected.registrationId &&
          fresh.expiresAt > Date.now() &&
          fresh.serverInstanceId === expected.serverInstanceId &&
          options.currentServerInstanceId() === expected.serverInstanceId &&
          fresh.threads.some(
            (value) =>
              value.threadId === expected.managerThreadId &&
              value.projectId === expected.checkoutBinding.projectId,
          ) &&
          hash(JSON.stringify(canonical(currentProjectContext(expected.managerThreadId)))) ===
            hash(JSON.stringify(canonical(expected.checkoutBinding))),
        "delivery_authority_changed",
      );
      nativeSpool.assertAvailable(expected.managerThreadId, allowFailure);
      return fresh;
    } catch {
      nativeSpool.hold(expected.managerThreadId, "native_progression_authority_changed");
      throw new Error("delivery_authority_changed");
    }
  };
  const continuationRequest = (claim) => ({
    managerThreadId: claim.managerThreadId,
    parentTurnId: claim.parentTurnId,
    priorAttemptId: claim.attemptId,
    cursorVersion: claim.cursorVersion,
    registrationId: claim.registrationId,
    serverInstanceId: claim.serverInstanceId,
    requestId: hash(
      JSON.stringify([
        "delivery-continuation-v1",
        claim.serverInstanceId,
        claim.managerBindingId,
        claim.attemptId,
        claim.cursorVersion,
      ]),
    ),
    checkoutBinding: structuredClone(claim.checkoutBinding),
    spawns: nativeSpool.boundarySpawns(claim.managerThreadId),
    cohort: nativeSpool.boundaryChildren(claim.managerThreadId),
  });
  const scheduleContinuation = (managerThreadId) => {
    if (!progression || closed || continuationTasks.has(managerThreadId)) return;
    const claim = nativeSpool.continuationCandidate(managerThreadId);
    if (!claim || nativeSpool.continuationStart(managerThreadId)) return;
    // Detach from the observer promise before asking the supervisor to drain
    // router work. Otherwise that drain would wait on this very observer.
    const operation = Promise.resolve()
      .then(async () => {
        const request = continuationRequest(claim),
          deadline = Date.now() + 5000;
        for (;;) {
          check(!closed, "delivery_closed");
          assertAuthority(request);
          try {
            const receipt = await options.continueRoot(request);
            nativeSpool.recordContinuationStart(managerThreadId, receipt);
            return;
          } catch (error) {
            if (error.message !== "supervisor_busy_or_closed" || closed || Date.now() >= deadline)
              throw error;
            await new Promise((done) => setTimeout(done, 20));
          }
        }
      })
      .catch(() => nativeSpool.hold(managerThreadId, "native_continuation_requires_reconciliation"))
      .finally(() => continuationTasks.delete(managerThreadId));
    continuationTasks.set(managerThreadId, operation);
  };
  const nativeObserver = createNativeDelegationObserver((threadId) => {
    const registration = currentRegistration();
    return (
      registration?.expiresAt > Date.now() &&
      registration.threads.some((t) => t.threadId === threadId)
    );
  });
  return {
    progressionProtocol: progression ? 1 : 0,
    assertProgressionAuthority(request) {
      check(progression && id(request?.managerThreadId), "native_progression_unavailable");
      const claim = nativeSpool.currentClaim(request.managerThreadId);
      check(
        claim?.attemptId === request.priorAttemptId &&
          claim.parentTurnId === request.parentTurnId &&
          claim.cursorVersion === request.cursorVersion &&
          claim.registrationId === request.registrationId &&
          claim.serverInstanceId === request.serverInstanceId,
        "native_progression_scope_changed",
      );
      return assertAuthority(request);
    },
    tools: () => [structuredClone(deliveryManagerToolSpec)],
    observe(notification) {
      nativeSpool?.observe(notification);
      if (progression && notification?.method === "turn/completed")
        scheduleContinuation(notification.params?.threadId);
      const observation = nativeObserver(notification);
      // A distinct trusted observer callback may persist metadata; native tool
      // arguments cannot call it or select a producer. No evidence is created.
      if (observation) {
        const pending = options.onDelegation?.(observation);
        if (pending && typeof pending.then === "function") return pending.then(() => observation);
      }
      return observation;
    },
    async handleToolCall(params) {
      check(!closed, "delivery_closed");
      const deadline = Date.now() + (progression ? 12000 : 10000);
      check(
        params?.tool === "hive_delivery" &&
          (params.namespace === null || params.namespace === undefined) &&
          id(params.threadId) &&
          id(params.turnId) &&
          id(params.callId),
        "invalid_delivery_native_call",
      );
      const observedRegistration = currentRegistration();
      const registered = progression ? structuredClone(observedRegistration) : observedRegistration;
      check(
        registered &&
          registered.expiresAt > Date.now() &&
          registered.threads.some((t) => t.threadId === params.threadId),
        "delivery_registration_unavailable",
      );
      const command = structuredClone(params.arguments);
      check(
        command &&
          typeof command === "object" &&
          !Array.isArray(command) &&
          Object.keys(command).sort().join(",") === "operation,payload" &&
          ["create_task", "claim_step", "complete_step", "report_step", "fail_attempt"].includes(
            command.operation,
          ),
        "invalid_delivery_command",
      );
      nativeSpool?.assertAvailable(params.threadId, command.operation === "fail_attempt");
      const checkoutBinding = structuredClone(currentProjectContext(params.threadId));
      const fields = [
        "projectId",
        "preparationIntentId",
        "repositoryId",
        "revision",
        "leaseId",
        "leaseGeneration",
      ];
      const uuid = (value) =>
        typeof value === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
      check(
        checkoutBinding &&
          typeof checkoutBinding === "object" &&
          Object.keys(checkoutBinding).length === fields.length &&
          Object.keys(checkoutBinding).every((field) => fields.includes(field)) &&
          [
            checkoutBinding.projectId,
            checkoutBinding.preparationIntentId,
            checkoutBinding.leaseId,
          ].every(uuid) &&
          /^[1-9][0-9]{0,19}$/.test(checkoutBinding.repositoryId) &&
          /^[a-f0-9]{40}$/.test(checkoutBinding.revision) &&
          Number.isSafeInteger(checkoutBinding.leaseGeneration) &&
          checkoutBinding.leaseGeneration > 0 &&
          registered.threads.some(
            (value) =>
              value.threadId === params.threadId && value.projectId === checkoutBinding.projectId,
          ),
        "delivery_checkout_context_invalid",
      );
      const encoded = JSON.stringify(canonical(command));
      check(Buffer.byteLength(encoded) <= 48 * 1024, "delivery_command_limit");
      const identity = JSON.stringify([
        registered.serverInstanceId,
        params.threadId,
        params.turnId,
        params.callId,
      ]);
      check(!active.has(identity), "delivery_call_busy");
      if (progression && activeRoots.has(params.threadId)) {
        nativeSpool.hold(params.threadId, "native_concurrent_delivery_calls");
        throw new Error("native_concurrent_delivery_calls");
      }
      active.add(identity);
      if (progression) activeRoots.set(params.threadId, identity);
      try {
        let continuation;
        if (progression) {
          await continuationTasks.get(params.threadId);
          nativeSpool.assertAvailable(params.threadId, command.operation === "fail_attempt");
          const current = nativeSpool.currentClaim(params.threadId);
          if (current && current.parentTurnId !== params.turnId) {
            check(command.operation === "claim_step", "native_first_operation_must_claim");
            const receipt = nativeSpool.continuationStart(params.threadId);
            check(
              receipt?.nextParentTurnId === params.turnId,
              "native_continuation_receipt_missing",
            );
            const request = continuationRequest(current);
            const checked = await options.revalidateBoundary(request, params.turnId, {
              threadId: params.threadId,
              turnId: params.turnId,
              callId: params.callId,
            });
            continuation = await nativeSpool.publishBoundary(
              params.threadId,
              params.turnId,
              checked.observedAt,
            );
          } else if (current && command.operation === "claim_step") {
            check(current.claimCallId === params.callId, "native_same_turn_claim_unavailable");
          }
        }
        if (progression && nativeSpool && command.operation === "complete_step") {
          await options.drainNativeRouting?.({
            excludeCall: {
              threadId: params.threadId,
              turnId: params.turnId,
              callId: params.callId,
            },
            timeoutMs: 5000,
          });
          await nativeSpool.requireCompletedChild(params.threadId, command.payload.attemptId);
        }
        nativeSpool?.assertAvailable(params.threadId, command.operation === "fail_attempt");
        const eventId = journal(
          stateDirectory,
          identity,
          hash(
            JSON.stringify(
              canonical({ command, checkoutBinding, ...(continuation ? { continuation } : {}) }),
            ),
          ),
        );
        const operationAuthority = {
          managerThreadId: params.threadId,
          registrationId: registered.id,
          serverInstanceId: registered.serverInstanceId,
          checkoutBinding,
        };
        nativeSpool?.beginClaim(
          params,
          command,
          eventId,
          checkoutBinding,
          continuation,
          operationAuthority,
        );
        let result;
        const attempts = progression && command.operation === "complete_step" ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
          check(!closed && Date.now() < deadline, "delivery_request_deadline");
          const fresh = progression
            ? assertAuthority(operationAuthority, command.operation === "fail_attempt")
            : registered;
          nativeSpool?.assertAvailable(params.threadId, command.operation === "fail_attempt");
          const now = Date.now(),
            value = {
              schemaVersion: 2,
              registrationId: fresh.id,
              serverInstanceId: fresh.serverInstanceId,
              eventId,
              managerThreadId: params.threadId,
              nativeTurnId: params.turnId,
              nativeCallId: params.callId,
              issuedAt: now,
              expiresAt: Math.min(now + 30_000, fresh.expiresAt),
              command,
              checkoutBinding,
              ...(continuation ? { continuation } : {}),
            };
          const proof = sign(null, Buffer.from(deliveryProofPayload(value)), key).toString(
            "base64url",
          );
          let response;
          try {
            response = await fetchImpl(`${hiveOrigin}/api/delivery/host`, {
              method: "POST",
              redirect: "manual",
              credentials: "omit",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...value, proof }),
              signal: AbortSignal.timeout(
                Math.max(1, Math.min(progression ? 3000 : 10000, deadline - Date.now())),
              ),
            });
          } catch (error) {
            if (attempt + 1 < attempts && Date.now() < deadline) continue;
            throw error;
          }
          if (response.status >= 500 && attempt + 1 < attempts && Date.now() < deadline) {
            void response.body?.cancel().catch(() => {});
            continue;
          }
          result = await readResponse(response, deadline);
          if (progression) {
            try {
              assertAuthority(operationAuthority, command.operation === "fail_attempt");
            } catch (error) {
              nativeSpool.recordUncertainResponse(params, command, result, operationAuthority);
              throw error;
            }
          }
          break;
        }
        try {
          nativeSpool?.recordClaim(params, command, result, checkoutBinding);
          nativeSpool?.recordTask(command, result);
          nativeSpool?.recordResult(params, command, result);
        } catch (error) {
          if (progression) nativeSpool.hold(params.threadId, "native_manager_receipt_conflict");
          throw error;
        }
        nativeSpool?.assertAvailable(params.threadId, command.operation === "fail_attempt");
        if (progression) {
          try {
            assertAuthority(operationAuthority, command.operation === "fail_attempt");
          } catch (error) {
            nativeSpool.recordUncertainResponse(params, command, result, operationAuthority);
            throw error;
          }
        }
        if (progression) scheduleContinuation(params.threadId);
        return {
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          success: true,
        };
      } finally {
        active.delete(identity);
        if (progression && activeRoots.get(params.threadId) === identity)
          activeRoots.delete(params.threadId);
      }
    },
    async resume() {
      await nativeSpool?.resume();
      // Restart never manufactures a runnable claim from a historical replay.
      // Existing acknowledged claims may reconcile their exact native history.
    },
    async flushNative() {
      await nativeSpool?.flush();
    },
    async close() {
      closed = true;
      await Promise.allSettled(continuationTasks.values());
      await nativeSpool?.close();
    },
    inspectNative() {
      return nativeSpool?.inspect() ?? null;
    },
  };
}
