// Private installed observer journal. Not a CLI, HTTP dispatcher or model tool.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const check = (v, reason) => {
  if (!v) throw new Error(reason);
};
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
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
const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(canonical(v)))
    .digest("hex");
const uuid = (v) => {
  const h = hash(v);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const nativeSourceProofPayload = (value) => {
  const { proof: _proof, ...unsigned } = value;
  return `hive-delivery-native-v1\nPOST\n/api/delivery/native\n${JSON.stringify(canonical(unsigned))}`;
};
const withoutTime = (source) => {
  const { observedAt: _time, ...value } = source;
  return value;
};
export function createDeliveryNativeSpool(options) {
  const {
    stateDirectory,
    currentRegistration,
    currentServerInstanceId,
    registerChild,
    readNativeHistory,
    deliver,
    onHold,
  } = options;
  check(
    typeof currentServerInstanceId === "function" && typeof registerChild === "function",
    "native_observer_callbacks_required",
  );
  check(resolve(stateDirectory) === stateDirectory, "invalid_native_spool");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(stateDirectory);
  check(
    dir.isDirectory() &&
      dir.uid === process.getuid() &&
      (dir.mode & 0o077) === 0 &&
      realpathSync(stateDirectory) === stateDirectory,
    "unsafe_native_spool",
  );
  const path = join(stateDirectory, "source.json"),
    secret = hash(`hive-native-spool-v1\n${options.hostPrivateKeyPem}`);
  const mac = (value) => createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
  let state = { schemaVersion: 1, claims: {}, fragments: {}, events: [], blocked: {} },
    closed = false,
    busy = false,
    runningFlush = Promise.resolve();
  if (existsSync(path)) {
    const stat = lstatSync(path);
    check(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 4 * 1024 * 1024,
      "unsafe_native_spool",
    );
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const expected = mac(saved.state);
    check(
      typeof saved.signature === "string" &&
        saved.signature.length === 64 &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(saved.signature)),
      "native_spool_corrupt",
    );
    check(
      saved.state.schemaVersion === 1 &&
        Object.keys(saved.state.claims).length <= 32 &&
        Object.keys(saved.state.fragments).length <= 128 &&
        saved.state.events.length <= 1024,
      "native_spool_limit",
    );
    state = saved.state;
  }
  function save() {
    const encoded = JSON.stringify({ state, signature: mac(state) });
    check(Buffer.byteLength(encoded) <= 4 * 1024 * 1024, "native_spool_limit");
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, encoded);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const parent = openSync(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  function hold(managerThreadId, reason) {
    state.blocked[managerThreadId] = reason;
    save();
    try {
      onHold?.({ managerThreadId, reason });
    } catch {}
  }
  function claimFor(managerThreadId) {
    const claim = state.claims[managerThreadId];
    if (!claim || claim.serverInstanceId !== currentServerInstanceId()) return null;
    return claim;
  }
  function enqueue(claim, source) {
    const identity = [
      claim.managerBindingId,
      claim.attemptId,
      source.kind,
      source.childThreadId,
      source.childTurnId,
      source.kind === "command_completed" ? source.itemId : source.spawnCallId,
    ];
    const eventId = uuid(identity),
      existing = state.events.find((event) => event.input.eventId === eventId);
    if (existing) {
      if (hash(withoutTime(existing.input.source)) === hash(withoutTime(source))) return;
      hold(claim.managerThreadId, "native_source_conflict");
      if (state.events.some((event) => event.conflictFor === eventId)) return;
      check(state.events.length < 1024, "native_spool_limit");
      state.events.push({
        conflictFor: eventId,
        acknowledged: false,
        input: {
          ...existing.input,
          source: { ...source, observedAt: existing.input.source.observedAt },
        },
      });
      save();
      return;
    }
    check(state.events.length < 1024, "native_spool_limit");
    claim.sequence++;
    state.events.push({
      acknowledged: false,
      input: {
        schemaVersion: 1,
        eventId,
        managerBindingId: claim.managerBindingId,
        taskId: claim.taskId,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        leaseGeneration: claim.leaseGeneration,
        sequence: claim.sequence,
        source,
      },
      managerThreadId: claim.managerThreadId,
      checkoutBinding: claim.checkoutBinding,
      serverInstanceId: claim.serverInstanceId,
    });
    save();
  }
  function appendTurn(claim, fragment, turn) {
    if (!id(turn?.id)) return;
    const common = {
      parentTurnId: fragment.parentTurnId,
      spawnCallId: fragment.spawnCallId,
      childThreadId: fragment.childThreadId,
      childTurnId: turn.id,
      observedAt: new Date().toISOString(),
    };
    enqueue(claim, { ...common, kind: "started", ...fragment.requested, ...fragment.resolved });
    if (Array.isArray(turn.items))
      for (const item of turn.items) appendItem(claim, fragment, turn.id, item);
    if (["completed", "failed", "interrupted"].includes(turn.status))
      enqueue(claim, { ...common, kind: "turn_completed", status: turn.status });
  }
  function appendItem(claim, fragment, turnId, item) {
    if (
      item?.type !== "commandExecution" ||
      !["completed", "failed", "declined"].includes(item.status) ||
      !id(item.id)
    )
      return;
    check(
      typeof item.command === "string" &&
        Buffer.byteLength(item.command) <= 65536 &&
        (item.aggregatedOutput === null || typeof item.aggregatedOutput === "string"),
      "native_command_unavailable",
    );
    const output = item.aggregatedOutput ?? "";
    check(
      typeof output === "string" && Buffer.byteLength(output) <= 1024 * 1024,
      "native_command_output_limit",
    );
    check(
      item.exitCode === null || Number.isSafeInteger(item.exitCode),
      "native_command_invalid_exit",
    );
    enqueue(claim, {
      kind: "command_completed",
      parentTurnId: fragment.parentTurnId,
      spawnCallId: fragment.spawnCallId,
      childThreadId: fragment.childThreadId,
      childTurnId: turnId,
      itemId: item.id,
      commandDigest: hash(item.command),
      outputDigest: hash(output),
      exitCode: item.exitCode,
      status: item.status,
      observedAt: new Date().toISOString(),
    });
  }
  function fragmentReady(fragment, claim) {
    if (!fragment.requested || !fragment.resolved) return;
    fragment.childThreadId = fragment.resolved.childThreadId;
    registerChild(claim.managerThreadId, fragment.childThreadId, fragment.spawnCallId);
    save();
  }
  async function flushInner() {
    busy = true;
    try {
      for (const event of state.events.filter((value) => !value.acknowledged).slice(0, 8)) {
        if (closed) break;
        const claim = Object.values(state.claims).find(
          (value) =>
            value.managerBindingId === event.input.managerBindingId &&
            value.attemptId === event.input.attemptId,
        );
        if (!claim) throw new Error("native_spool_claim_missing");
        const registered = currentRegistration();
        if (!registered || registered.expiresAt <= Date.now()) break;
        if (
          currentServerInstanceId() !== claim.serverInstanceId ||
          registered.serverInstanceId !== claim.serverInstanceId
        ) {
          hold(claim.managerThreadId, "native_lifetime_changed");
          break;
        }
        if (!registered.threads.some((value) => value.threadId === claim.managerThreadId)) break;
        const value = {
          ...event.input,
          registrationId: registered.id,
          serverInstanceId: registered.serverInstanceId,
          managerThreadId: claim.managerThreadId,
          checkoutBinding: claim.checkoutBinding,
          issuedAt: Date.now(),
          expiresAt: Math.min(Date.now() + 30000, registered.expiresAt),
        };
        const result = await deliver(value);
        check(
          result &&
            result.sequence === event.input.sequence &&
            (result.accepted === true || result.blocked === true),
          "native_source_ack_invalid",
        );
        event.acknowledged = true;
        if (result.blocked) state.blocked[claim.managerThreadId] = "native_reconciliation_required";
        save();
      }
    } finally {
      busy = false;
    }
  }
  function flush() {
    if (closed) return Promise.resolve();
    if (busy) return runningFlush;
    runningFlush = flushInner();
    return runningFlush;
  }
  const timer = setInterval(() => {
    void flush().catch(() => {});
  }, 1000);
  timer.unref?.();
  function observeNative({ method, params } = {}) {
    if (closed || !params || !id(params.threadId)) return;
    const managerClaim = claimFor(params.threadId),
      item = params.item;
    const requested =
      method === "rawResponseItem/completed" &&
      item?.type === "function_call" &&
      item.namespace === "collaboration" &&
      item.name === "spawn_agent";
    const resolved =
      ["item/started", "item/completed"].includes(method) &&
      item?.type === "subAgentActivity" &&
      item.kind === "started";
    if (requested || resolved) {
      const registered = currentRegistration();
      const knownManager =
        managerClaim || registered?.threads.some((value) => value.threadId === params.threadId);
      if (!knownManager) return;
      if (!managerClaim || managerClaim.parentTurnId !== params.turnId) {
        hold(params.threadId, "native_spawn_without_claim");
        return;
      }
      const callId = requested ? item.call_id : item.id;
      check(id(callId), "native_spawn_invalid");
      const key = hash([params.threadId, params.turnId, callId]);
      if (!state.fragments[key]) {
        check(Object.keys(state.fragments).length < 128, "native_spool_limit");
        state.fragments[key] = {
          managerThreadId: params.threadId,
          parentTurnId: params.turnId,
          spawnCallId: callId,
        };
      }
      const fragment = state.fragments[key];
      const setting = (v) => {
        if (v === null || v === undefined) return null;
        check(id(v), "native_setting_invalid");
        return v;
      };
      if (requested) {
        check(
          typeof item.arguments === "string" && Buffer.byteLength(item.arguments) <= 32768,
          "native_spawn_invalid",
        );
        const args = JSON.parse(item.arguments);
        const value = {
          requestedModel: setting(args.model),
          requestedEffort: setting(args.reasoning_effort),
        };
        if (fragment.requested && hash(fragment.requested) !== hash(value)) {
          hold(params.threadId, "native_spawn_conflict");
          return;
        }
        fragment.requested = value;
      } else {
        check(
          id(item.agentThreadId) && item.agentThreadId !== params.threadId,
          "native_child_invalid",
        );
        const value = {
          childThreadId: item.agentThreadId,
          effectiveModel: setting(item.model),
          effectiveEffort: setting(item.reasoningEffort),
        };
        if (fragment.resolved && hash(fragment.resolved) !== hash(value)) {
          hold(params.threadId, "native_spawn_conflict");
          return;
        }
        fragment.resolved = value;
      }
      save();
      fragmentReady(fragment, managerClaim);
      return;
    }
    const fragment = Object.values(state.fragments).find(
      (value) => value.childThreadId === params.threadId,
    );
    if (!fragment) return;
    const claim = claimFor(fragment.managerThreadId);
    if (!claim) return;
    if (method === "turn/started" || method === "turn/completed")
      appendTurn(claim, fragment, params.turn);
    else if (method === "item/completed" && id(params.turnId)) {
      appendTurn(claim, fragment, { id: params.turnId, status: "inProgress", items: [] });
      appendItem(claim, fragment, params.turnId, item);
    }
  }
  return {
    recordClaim(params, command, result, checkoutBinding) {
      if (command.operation !== "claim_step") return;
      check(
        id(result?.attemptId) &&
          id(result.managerBindingId) &&
          Number.isSafeInteger(result.leaseGeneration),
        "native_claim_receipt_invalid",
      );
      const existing = state.claims[params.threadId];
      if (existing) {
        check(
          existing.attemptId === result.attemptId &&
            existing.managerBindingId === result.managerBindingId &&
            hash(existing.checkoutBinding) === hash(checkoutBinding),
          "native_claim_already_held",
        );
        return;
      }
      if (result.replayed || result.nativeSequence !== 0) {
        hold(params.threadId, "native_spool_missing_claim");
        throw new Error("native_spool_missing_claim");
      }
      check(Object.keys(state.claims).length < 32, "native_spool_limit");
      state.claims[params.threadId] = {
        managerThreadId: params.threadId,
        parentTurnId: params.turnId,
        claimCallId: params.callId,
        serverInstanceId: currentServerInstanceId(),
        checkoutBinding: structuredClone(checkoutBinding),
        managerBindingId: result.managerBindingId,
        taskId: command.payload.taskId,
        stepId: command.payload.stepId,
        attemptId: result.attemptId,
        leaseGeneration: result.leaseGeneration,
        sequence: 0,
      };
      save();
    },
    assertAvailable(managerThreadId, allowFailure = false) {
      check(!closed, "native_spool_closed");
      if (state.blocked[managerThreadId] && !allowFailure)
        throw new Error("native_reconciliation_required");
      const claim = state.claims[managerThreadId];
      if (claim && claim.serverInstanceId !== currentServerInstanceId())
        throw new Error("native_lifetime_changed");
    },
    observe(notification) {
      try {
        return observeNative(notification);
      } catch (error) {
        const threadId = notification?.params?.threadId;
        const parent = state.claims[threadId]
          ? threadId
          : Object.values(state.fragments).find((value) => value.childThreadId === threadId)
              ?.managerThreadId;
        if (parent) hold(parent, "native_observation_unavailable");
        throw error;
      }
    },
    async resume() {
      for (const fragment of Object.values(state.fragments)) {
        const claim = claimFor(fragment.managerThreadId);
        if (!claim || !fragment.requested || !fragment.resolved) continue;
        fragmentReady(fragment, claim);
        if (readNativeHistory) {
          let history;
          try {
            history = await readNativeHistory({
              managerThreadId: claim.managerThreadId,
              childThreadId: fragment.childThreadId,
              spawnCallId: fragment.spawnCallId,
            });
          } catch {
            hold(claim.managerThreadId, "native_history_unavailable");
            throw new Error("native_history_unavailable");
          }
          if (!Array.isArray(history?.data) || history.data.length > 20 || history.nextCursor) {
            hold(claim.managerThreadId, "native_history_incomplete");
            throw new Error("native_history_incomplete");
          }
          for (const turn of history.data) appendTurn(claim, fragment, turn);
        }
      }
      await flush();
    },
    flush,
    async close() {
      closed = true;
      clearInterval(timer);
      await runningFlush.catch(() => {});
    },
    inspect() {
      return {
        pending: state.events.filter((value) => !value.acknowledged).length,
        held: Object.keys(state.claims).length,
        blocked: Object.values(state.blocked).length,
      };
    },
  };
}
