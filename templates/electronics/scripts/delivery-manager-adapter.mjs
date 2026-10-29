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
    "Record a delivery task, reserve a fenced step, or submit a structured report referencing existing trusted evidence. This tool grants no evidence-producer, release, deployment or native execution authority.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["create_task", "claim_step", "complete_step", "fail_attempt"],
      },
      payload: { type: "object" },
    },
    required: ["operation", "payload"],
    additionalProperties: false,
  },
};
export function deliveryProofPayload(value) {
  const { proof: _proof, ...unsigned } = value;
  return `hive-delivery-host-v1\nPOST\n/api/delivery/host\n${JSON.stringify(canonical(unsigned))}`;
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
async function readResponse(response) {
  check(response.status >= 200 && response.status < 300, "delivery_request_rejected");
  check(
    response.headers.get("content-type")?.split(";")[0] === "application/json",
    "invalid_delivery_response",
  );
  const reader = response.body?.getReader();
  check(reader, "invalid_delivery_response");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      check(size <= 65536, "delivery_response_limit");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
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
  const active = new Set();
  const nativeObserver = createNativeDelegationObserver((threadId) => {
    const registration = currentRegistration();
    return (
      registration?.expiresAt > Date.now() &&
      registration.threads.some((t) => t.threadId === threadId)
    );
  });
  return {
    tools: () => [structuredClone(deliveryManagerToolSpec)],
    observe(notification) {
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
      check(
        params?.tool === "hive_delivery" &&
          (params.namespace === null || params.namespace === undefined) &&
          id(params.threadId) &&
          id(params.turnId) &&
          id(params.callId),
        "invalid_delivery_native_call",
      );
      const registered = currentRegistration();
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
          ["create_task", "claim_step", "complete_step", "fail_attempt"].includes(
            command.operation,
          ),
        "invalid_delivery_command",
      );
      const encoded = JSON.stringify(canonical(command));
      check(Buffer.byteLength(encoded) <= 48 * 1024, "delivery_command_limit");
      const identity = JSON.stringify([
        registered.id,
        params.threadId,
        params.turnId,
        params.callId,
      ]);
      check(!active.has(identity), "delivery_call_busy");
      active.add(identity);
      try {
        const eventId = journal(stateDirectory, identity, hash(encoded));
        const now = Date.now();
        const value = {
          schemaVersion: 1,
          registrationId: registered.id,
          serverInstanceId: registered.serverInstanceId,
          eventId,
          managerThreadId: params.threadId,
          nativeTurnId: params.turnId,
          nativeCallId: params.callId,
          issuedAt: now,
          expiresAt: Math.min(now + 30_000, registered.expiresAt),
          command,
        };
        const proof = sign(null, Buffer.from(deliveryProofPayload(value)), key).toString(
          "base64url",
        );
        const response = await fetchImpl(`${hiveOrigin}/api/delivery/host`, {
          method: "POST",
          redirect: "manual",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...value, proof }),
          signal: AbortSignal.timeout(10_000),
        });
        const result = await readResponse(response);
        return {
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          success: true,
        };
      } finally {
        active.delete(identity);
      }
    },
  };
}
