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
  const progression = options.progressionProtocol === 1;
  const sourceProtocol = options.sourceProtocol === 1;
  check(!sourceProtocol || progression, "native_source_protocol_requires_progression");
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
  // Optional protocol-one state is additive. Legacy thread claims retain their
  // original format and physical anchor; only the logical cursor moves.
  if (progression) {
    for (const name of [
      "attempts",
      "cursors",
      "claimIntents",
      "continuations",
      "results",
      "rootTurns",
      "violations",
      "taskPlans",
      "uncertainAcknowledgements",
    ])
      state[name] ??= {};
    check(
      Object.keys(state.attempts).length <= 128 &&
        Object.keys(state.claimIntents).length <= 256 &&
        Object.keys(state.continuations).length <= 128,
      "native_spool_limit",
    );
  }
  check(sourceProtocol || state.sourceProtocol !== 1, "native_source_protocol_required");
  if (sourceProtocol) {
    state.sourceProtocol = 1;
    state.sourcePublications ??= {};
    check(Object.keys(state.sourcePublications).length <= 128, "native_spool_limit");
  }
  const contextEqual = (a, b) => hash(a ?? null) === hash(b ?? null);
  const validContext = (c) =>
    c === undefined ||
    (c &&
      Object.keys(c).sort().join(",") === "headSha,revisionId,version" &&
      id(c.revisionId) &&
      Number.isSafeInteger(c.version) &&
      c.version > 0 &&
      /^[a-f0-9]{40}$/.test(c.headSha));
  const inputContext = (claim) => claim.sourceContext;
  const acceptedContext = (claim) =>
    state.sourcePublications?.[claim.attemptId]?.sourceContext ?? inputContext(claim);
  function outputRecord(claim, value) {
    const a = value?.accepted,
      scope = value?.scope;
    check(
      value?.isCurrent === true &&
        value.publicationAuthorized === false &&
        value.executionAuthorized === false &&
        scope?.managerBindingId === claim.managerBindingId &&
        scope.taskId === claim.taskId &&
        scope.managerThreadId === claim.managerThreadId &&
        scope.registrationId === claim.registrationId &&
        scope.serverInstanceId === claim.serverInstanceId &&
        hash(scope.checkoutBinding) === hash(claim.checkoutBinding) &&
        a?.producingAttemptId === claim.attemptId &&
        a.stepId === claim.stepId &&
        validContext(a.sourceContext) &&
        a.sourceContext &&
        contextEqual(value.current?.sourceContext, a.sourceContext) &&
        value.current.headSha === a.sourceContext.headSha &&
        a.parentSha === claim.inputSourceSha &&
        a.previousRevisionId === (claim.sourceContext?.revisionId ?? null) &&
        a.sourceContext.version === (claim.sourceContext?.version ?? 0) + 1 &&
        id(a.operationId),
      "native_publication_scope_invalid",
    );
    return {
      operationId: a.operationId,
      sourceContext: structuredClone(a.sourceContext),
      parentSha: a.parentSha,
      previousRevisionId: a.previousRevisionId,
      treeSha: a.treeSha,
      manifestDigest: a.manifestDigest,
      proofDigest: a.proofDigest,
    };
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
  function claimFor(managerThreadId, parentTurnId) {
    const cursor = progression && state.cursors[managerThreadId];
    const claim = cursor
      ? parentTurnId
        ? Object.values(state.attempts).find(
            (value) =>
              value.managerThreadId === managerThreadId && value.parentTurnId === parentTurnId,
          )
        : state.attempts[cursor.attemptId]
      : state.claims[managerThreadId];
    if (!claim || claim.serverInstanceId !== currentServerInstanceId()) return null;
    return claim;
  }
  function fragmentClaim(fragment) {
    const claim = fragment.attemptId
      ? state.attempts?.[fragment.attemptId]
      : claimFor(fragment.managerThreadId);
    return claim?.serverInstanceId === currentServerInstanceId() ? claim : null;
  }
  const intentKey = (params, lifetime = currentServerInstanceId()) =>
    hash([lifetime, params.threadId, params.turnId, params.callId]);
  function enqueue(claim, source, sourceContext = inputContext(claim)) {
    const identity =
      source.kind === "root_boundary"
        ? [
            claim.managerBindingId,
            claim.attemptId,
            source.kind,
            source.parentTurnId,
            source.nextParentTurnId,
            source.cursorVersion,
          ]
        : [
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
      if (
        hash(withoutTime(existing.input.source)) === hash(withoutTime(source)) &&
        (!sourceProtocol || contextEqual(existing.input.sourceContext, sourceContext))
      )
        return existing;
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
    if (
      sourceProtocol &&
      source.kind !== "root_boundary" &&
      state.sourcePublications[claim.attemptId]
    )
      hold(claim.managerThreadId, "native_work_after_publication");
    check(state.events.length < 1024, "native_spool_limit");
    const cursor = progression && state.cursors[claim.managerThreadId];
    if (cursor) {
      if (cursor.attemptId !== claim.attemptId)
        hold(claim.managerThreadId, "native_late_previous_attempt_fact");
      claim.sequence = ++cursor.sequence;
    } else claim.sequence++;
    const event = {
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
        ...(sourceProtocol && sourceContext
          ? { sourceContext: structuredClone(sourceContext) }
          : {}),
      },
      managerThreadId: claim.managerThreadId,
      checkoutBinding: claim.checkoutBinding,
      serverInstanceId: claim.serverInstanceId,
    };
    state.events.push(event);
    save();
    return event;
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
        const claim = [...Object.values(state.claims), ...Object.values(state.attempts ?? {})].find(
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
        event.acknowledgement = {
          sequence: result.sequence,
          blocked: result.blocked === true,
          ...(result.boundaryEventId
            ? { boundaryEventId: result.boundaryEventId, cursorVersion: result.cursorVersion }
            : {}),
        };
        const cursor = progression && state.cursors[claim.managerThreadId];
        if (cursor)
          cursor.acknowledgedSequence = Math.max(cursor.acknowledgedSequence, result.sequence);
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
  async function drainAcknowledgements(managerThreadId, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (let batch = 0; batch < 128; batch++) {
      check(
        !closed && Date.now() < deadline && !state.blocked[managerThreadId],
        "native_flush_not_ready",
      );
      const remaining = state.events.filter(
        (event) => event.managerThreadId === managerThreadId && !event.acknowledged,
      );
      if (!remaining.length) return;
      await flush();
      // Registration offline must not spin or be treated as acknowledgement.
      check(
        state.events.filter(
          (event) => event.managerThreadId === managerThreadId && !event.acknowledged,
        ).length < remaining.length,
        "native_flush_not_ready",
      );
    }
    throw new Error("native_flush_limit");
  }
  function unadmitted(params, item, reason) {
    const callId = item?.call_id ?? item?.id ?? "unknown";
    const key = hash([params.threadId, params.turnId, callId]);
    check(
      Object.keys(state.violations).length < 128 || state.violations[key],
      "native_spool_limit",
    );
    // Retain the original identity without assigning it to a later attempt.
    state.violations[key] ??= {
      managerThreadId: params.threadId,
      parentTurnId: params.turnId ?? null,
      callId,
      kind: item?.name ?? item?.type ?? null,
      attemptId: null,
      nativeThreadId: params.sourceThreadId ?? params.threadId,
    };
    if (id(item?.agentThreadId)) state.violations[key].childThreadId = item.agentThreadId;
    hold(params.threadId, reason);
  }
  function observeNative({ method, params } = {}) {
    if (closed || !params || !id(params.threadId)) return;
    const managerClaim = claimFor(params.threadId, params.turnId),
      item = params.item;
    if (
      progression &&
      currentRegistration()?.threads.some((value) => value.threadId === params.threadId)
    ) {
      if (["turn/started", "turn/completed"].includes(method) && id(params.turn?.id)) {
        const key = hash([params.threadId, params.turn.id]);
        check(
          Object.keys(state.rootTurns).length < 256 || state.rootTurns[key],
          "native_spool_limit",
        );
        const prior = state.rootTurns[key];
        if (prior?.status === "completed" && params.turn.status !== "completed")
          hold(params.threadId, "native_root_turn_regressed");
        state.rootTurns[key] = {
          managerThreadId: params.threadId,
          parentTurnId: params.turn.id,
          status: params.turn.status,
        };
        save();
      }
      if (
        method === "rawResponseItem/completed" &&
        item?.type === "function_call" &&
        (!managerClaim || managerClaim.parentTurnId !== params.turnId)
      ) {
        let claimCall = false;
        try {
          claimCall =
            item.name === "hive_delivery" &&
            !item.namespace &&
            JSON.parse(item.arguments).operation === "claim_step";
        } catch {}
        // First-turn task creation remains allowed. A continuation's first
        // delivery operation is claim_step; any other work retains a hold.
        const firstCreation = !state.cursors[params.threadId] && item.name === "hive_delivery";
        if (!claimCall && !firstCreation)
          unadmitted(params, item, "native_work_before_claim_receipt");
      }
      if (
        ["item/started", "item/completed"].includes(method) &&
        item &&
        (!managerClaim || managerClaim.parentTurnId !== params.turnId)
      ) {
        const permitted =
          ["userMessage", "agentMessage", "reasoning"].includes(item.type) ||
          (item.type === "dynamicToolCall" &&
            item.tool === "hive_delivery" &&
            (item.arguments?.operation === "claim_step" || !state.cursors[params.threadId]));
        if (!permitted && !(item.type === "subAgentActivity" && item.kind === "completed"))
          unadmitted(params, item, "native_work_before_claim_receipt");
      }
    }
    if (sourceProtocol && managerClaim && state.sourcePublications[managerClaim.attemptId]) {
      const delivery =
        item?.type === "function_call" && item.name === "hive_delivery" && !item.namespace;
      let permitted = false;
      if (delivery)
        try {
          permitted = ["complete_step", "report_step", "fail_attempt", "publish_source"].includes(
            JSON.parse(item.arguments).operation,
          );
        } catch {}
      if (method === "rawResponseItem/completed" && item?.type === "function_call" && !permitted)
        unadmitted(params, item, "native_work_after_publication");
      if (["item/started", "item/completed"].includes(method) && item?.type === "commandExecution")
        unadmitted(params, item, "native_work_after_publication");
    }
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
      if (!knownManager) {
        const parent =
          progression &&
          Object.values(state.fragments).find(
            (fragment) => fragment.childThreadId === params.threadId,
          );
        if (parent) {
          unadmitted(
            { ...params, sourceThreadId: params.threadId, threadId: parent.managerThreadId },
            item,
            "native_nested_spawn_unadmitted",
          );
        }
        return;
      }
      if (!managerClaim || managerClaim.parentTurnId !== params.turnId) {
        if (progression) unadmitted(params, item, "native_spawn_without_claim");
        else hold(params.threadId, "native_spawn_without_claim");
        return;
      }
      const callId = requested ? item.call_id : item.id;
      check(id(callId), "native_spawn_invalid");
      const key = hash([params.threadId, params.turnId, callId]);
      if (progression && state.cursors[params.threadId]?.attemptId !== managerClaim.attemptId)
        hold(params.threadId, "native_late_previous_attempt_spawn");
      if (
        sourceProtocol &&
        state.sourcePublications[managerClaim.attemptId] &&
        !state.fragments[key]
      ) {
        unadmitted(params, item, "native_spawn_after_publication");
        return;
      }
      if (!state.fragments[key]) {
        check(Object.keys(state.fragments).length < 128, "native_spool_limit");
        state.fragments[key] = {
          managerThreadId: params.threadId,
          parentTurnId: params.turnId,
          spawnCallId: callId,
          ...(progression ? { attemptId: managerClaim.attemptId } : {}),
        };
      }
      const fragment = state.fragments[key];
      if (
        progression &&
        state.blocked[params.threadId] &&
        !fragment.requested &&
        !fragment.resolved
      ) {
        delete state.fragments[key];
        unadmitted(params, item, "native_spawn_while_held");
        return;
      }
      if (progression && fragment.attemptId !== managerClaim.attemptId) {
        hold(params.threadId, "native_fragment_attempt_conflict");
        return;
      }
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
    const claim = fragmentClaim(fragment);
    if (!claim) return;
    if (method === "turn/started" || method === "turn/completed")
      appendTurn(claim, fragment, params.turn);
    else if (method === "item/completed" && id(params.turnId)) {
      appendTurn(claim, fragment, { id: params.turnId, status: "inProgress", items: [] });
      appendItem(claim, fragment, params.turnId, item);
    }
  }
  return {
    progressionProtocol: progression ? 1 : 0,
    sourceApplicationSnapshot(managerThreadId, request) {
      check(
        sourceProtocol && !state.blocked[managerThreadId],
        "native_source_snapshot_unavailable",
      );
      const claim = claimFor(managerThreadId),
        cursor = state.cursors[managerThreadId],
        publication = claim && state.sourcePublications[claim.attemptId],
        root = claim && state.rootTurns[hash([managerThreadId, claim.parentTurnId])];
      check(
        claim &&
          cursor &&
          publication &&
          state.results[claim.attemptId] &&
          root?.status === "completed" &&
          request?.managerThreadId === managerThreadId &&
          request.managerBindingId === claim.managerBindingId &&
          request.taskId === claim.taskId &&
          request.stepId === claim.stepId &&
          request.priorAttemptId === claim.attemptId &&
          request.parentTurnId === claim.parentTurnId &&
          request.cursorVersion === cursor.cursorVersion &&
          request.registrationId === claim.registrationId &&
          request.serverInstanceId === claim.serverInstanceId &&
          hash(request.checkoutBinding) === hash(claim.checkoutBinding) &&
          request.inputSourceSha === claim.inputSourceSha &&
          contextEqual(request.inputSourceContext, claim.sourceContext),
        "native_source_snapshot_scope_changed",
      );
      const pending = state.events.filter(
          (v) => v.managerThreadId === managerThreadId && !v.acknowledged,
        ),
        unknown = Object.values(state.violations).filter(
          (v) => v.managerThreadId === managerThreadId,
        );
      check(
        !pending.length && !unknown.length && cursor.sequence === cursor.acknowledgedSequence,
        "native_source_snapshot_not_drained",
      );
      const cohort = this.boundaryChildren(managerThreadId),
        spawns = this.boundarySpawns(managerThreadId);
      check(
        hash(cohort) === hash(request.cohort) && hash(spawns) === hash(request.spawns),
        "native_source_snapshot_scope_changed",
      );
      for (const child of cohort)
        check(
          state.events.some(
            (v) =>
              v.acknowledged &&
              v.managerThreadId === managerThreadId &&
              v.input.source.kind === "turn_completed" &&
              v.input.source.childThreadId === child.childThreadId &&
              v.input.source.childTurnId === child.childTurnId &&
              v.input.source.status === "completed",
          ),
          "native_source_snapshot_child_unfinished",
        );
      const info = lstatSync(path, { bigint: true });
      check(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1n &&
          info.uid === BigInt(process.getuid()) &&
          !(info.mode & 0o077n),
        "native_source_snapshot_journal_invalid",
      );
      const encoded = readFileSync(path, "utf8"),
        saved = JSON.parse(encoded);
      check(
        saved.signature === mac(state) && hash(saved.state) === hash(state),
        "native_source_snapshot_journal_changed",
      );
      return {
        schemaVersion: 1,
        scope: "native_observer_journal_only",
        managerThreadId,
        managerBindingId: claim.managerBindingId,
        taskId: claim.taskId,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        parentTurnId: claim.parentTurnId,
        registrationId: claim.registrationId,
        serverInstanceId: claim.serverInstanceId,
        checkoutBinding: structuredClone(claim.checkoutBinding),
        checkoutBindingDigest: claim.checkoutBindingDigest,
        cursorVersion: cursor.cursorVersion,
        nativeSequence: cursor.acknowledgedSequence,
        inputSourceSha: claim.inputSourceSha,
        ...(claim.sourceContext
          ? { inputSourceContext: structuredClone(claim.sourceContext) }
          : {}),
        operationId: publication.operationId,
        acceptedSourceContext: structuredClone(publication.sourceContext),
        sourceJournalDigest: hash(encoded),
        sourceJournalIdentity: { device: info.dev.toString(), inode: info.ino.toString() },
        pendingSourceEvents: 0,
        unknownInputs: 0,
        writerHeld: true,
        quiescenceAuthority: false,
        metadataApplyAuthorized: false,
      };
    },
    sourcePublication(managerThreadId) {
      const claim = claimFor(managerThreadId);
      return claim && state.sourcePublications?.[claim.attemptId]
        ? structuredClone(state.sourcePublications[claim.attemptId])
        : null;
    },
    recordPublication(managerThreadId, value) {
      check(sourceProtocol, "native_source_protocol_disabled");
      const claim = claimFor(managerThreadId);
      check(claim && !state.blocked[managerThreadId], "native_source_unavailable");
      const record = outputRecord(claim, value),
        old = state.sourcePublications[claim.attemptId];
      if (old) {
        const { applied: _applied, ...previous } = old;
        check(hash(previous) === hash(record), "native_publication_replay_conflict");
      } else state.sourcePublications[claim.attemptId] = record;
      save();
      return structuredClone(record);
    },
    recordAppliedSource(managerThreadId, value) {
      check(sourceProtocol, "native_source_protocol_disabled");
      const claim = claimFor(managerThreadId),
        old = claim && state.sourcePublications[claim.attemptId];
      check(
        old &&
          hash(outputRecord(claim, value)) === hash((({ applied: _applied, ...v }) => v)(old)) &&
          !state.blocked[managerThreadId],
        "native_applied_source_mismatch",
      );
      old.applied = true;
      save();
    },
    sourceBoundaryCandidate(managerThreadId) {
      if (!sourceProtocol || state.blocked[managerThreadId]) return null;
      const claim = claimFor(managerThreadId),
        publication = claim && state.sourcePublications[claim.attemptId],
        root = claim && state.rootTurns[hash([managerThreadId, claim.parentTurnId])];
      return claim &&
        publication &&
        !publication.applied &&
        state.results[claim.attemptId] &&
        root?.status === "completed"
        ? structuredClone(claim)
        : null;
    },
    assertAppliedSource(managerThreadId, sourceContext) {
      check(validContext(sourceContext), "native_source_context_invalid");
      const claim = claimFor(managerThreadId),
        publication = claim && state.sourcePublications?.[claim.attemptId];
      if (publication)
        check(
          publication.applied && contextEqual(publication.sourceContext, sourceContext),
          "native_source_not_applied",
        );
      else if (claim)
        check(contextEqual(claim.sourceContext, sourceContext), "native_source_context_changed");
    },
    currentClaim(managerThreadId) {
      const claim = claimFor(managerThreadId);
      return claim ? structuredClone(claim) : null;
    },
    continuationCandidate(managerThreadId) {
      if (!progression || state.blocked[managerThreadId]) return null;
      const claim = claimFor(managerThreadId),
        cursor = state.cursors[managerThreadId];
      const result = claim && state.results[claim.attemptId];
      const root = claim && state.rootTurns[hash([managerThreadId, claim.parentTurnId])];
      if (!claim || !cursor || !result || root?.status !== "completed") return null;
      const plan = state.taskPlans[claim.taskId];
      if (
        plan?.stepIds.every((stepId) =>
          Object.values(state.attempts).some(
            (attempt) =>
              attempt.taskId === claim.taskId &&
              attempt.stepId === stepId &&
              state.results[attempt.attemptId],
          ),
        )
      )
        return null;
      return structuredClone({
        ...claim,
        cursorVersion: cursor.cursorVersion,
        resultEventId: result.eventId,
      });
    },
    recordTask(command, result) {
      if (!progression || command.operation !== "create_task") return;
      check(
        result?.taskId === command.payload.id &&
          Array.isArray(command.payload.steps) &&
          command.payload.steps.length > 0 &&
          command.payload.steps.length <= 32 &&
          command.payload.steps.every((step) => id(step.id)),
        "native_task_receipt_invalid",
      );
      const plan = { stepIds: command.payload.steps.map((step) => step.id) };
      check(
        !state.taskPlans[result.taskId] || hash(state.taskPlans[result.taskId]) === hash(plan),
        "native_task_plan_conflict",
      );
      check(
        state.taskPlans[result.taskId] || Object.keys(state.taskPlans).length < 32,
        "native_spool_limit",
      );
      state.taskPlans[result.taskId] = plan;
      save();
    },
    recordResult(params, command, result) {
      if (!progression || !["complete_step", "report_step"].includes(command.operation)) return;
      const claim = claimFor(params.threadId);
      check(
        claim &&
          claim.parentTurnId === params.turnId &&
          claim.attemptId === command.payload.attemptId &&
          claim.taskId === command.payload.taskId &&
          claim.stepId === command.payload.stepId &&
          id(result?.eventId) &&
          id(result.reportId),
        "native_result_receipt_mismatch",
      );
      const entry = {
        eventId: result.eventId,
        reportId: result.reportId,
        operation: command.operation,
        parentTurnId: params.turnId,
      };
      check(
        !state.results[claim.attemptId] || hash(state.results[claim.attemptId]) === hash(entry),
        "native_result_replay_conflict",
      );
      state.results[claim.attemptId] = entry;
      save();
    },
    recordContinuationStart(managerThreadId, receipt) {
      check(progression && !state.blocked[managerThreadId], "native_progression_unavailable");
      const claim = claimFor(managerThreadId),
        cursor = state.cursors[managerThreadId];
      check(
        claim &&
          cursor &&
          receipt.parentTurnId === claim.parentTurnId &&
          receipt.priorAttemptId === claim.attemptId &&
          receipt.cursorVersion === cursor.cursorVersion &&
          receipt.serverInstanceId === claim.serverInstanceId &&
          id(receipt.nextParentTurnId) &&
          receipt.nextParentTurnId !== claim.parentTurnId,
        "native_continuation_start_mismatch",
      );
      const key = hash([managerThreadId, cursor.cursorVersion]),
        existing = state.continuations[key];
      if (existing) {
        check(hash(existing.startReceipt) === hash(receipt), "native_continuation_start_conflict");
        return;
      }
      check(Object.keys(state.continuations).length < 128, "native_spool_limit");
      state.continuations[key] = {
        startReceipt: structuredClone(receipt),
        parentTurnId: claim.parentTurnId,
        nextParentTurnId: receipt.nextParentTurnId,
        priorAttemptId: claim.attemptId,
        cursorVersion: cursor.cursorVersion,
      };
      save();
    },
    continuationStart(managerThreadId) {
      if (!progression) return null;
      const cursor = state.cursors[managerThreadId];
      return cursor
        ? structuredClone(
            state.continuations[hash([managerThreadId, cursor.cursorVersion])] ?? null,
          )
        : null;
    },
    boundarySpawns(managerThreadId) {
      check(progression, "native_progression_unavailable");
      const claim = claimFor(managerThreadId);
      check(claim, "native_claim_missing");
      return Object.values(state.fragments)
        .filter((fragment) => fragment.attemptId === claim.attemptId)
        .map((fragment) => {
          check(
            fragment.requested && fragment.resolved && id(fragment.childThreadId),
            "native_spawn_unresolved",
          );
          const childTurnIds = [
            ...new Set(
              state.events
                .filter(
                  (event) =>
                    event.input.attemptId === claim.attemptId &&
                    event.input.source.childThreadId === fragment.childThreadId,
                )
                .map((event) => event.input.source.childTurnId)
                .filter(Boolean),
            ),
          ];
          check(childTurnIds.length === 1, "native_child_turn_unresolved");
          return structuredClone({
            spawnCallId: fragment.spawnCallId,
            childThreadId: fragment.childThreadId,
            childTurnId: childTurnIds[0],
            ...fragment.requested,
            ...fragment.resolved,
          });
        });
    },
    boundaryChildren(managerThreadId) {
      check(progression, "native_progression_unavailable");
      return Object.values(state.fragments)
        .filter((fragment) => fragment.managerThreadId === managerThreadId)
        .map((fragment) => {
          check(
            fragment.requested &&
              fragment.resolved &&
              fragment.attemptId &&
              id(fragment.childThreadId),
            "native_spawn_unresolved",
          );
          const turns = [
            ...new Set(
              state.events
                .filter(
                  (event) =>
                    event.input.attemptId === fragment.attemptId &&
                    event.input.source.childThreadId === fragment.childThreadId,
                )
                .map((event) => event.input.source.childTurnId)
                .filter(Boolean),
            ),
          ];
          check(turns.length === 1, "native_child_turn_unresolved");
          return structuredClone({
            parentTurnId: fragment.parentTurnId,
            spawnCallId: fragment.spawnCallId,
            childThreadId: fragment.childThreadId,
            childTurnId: turns[0],
            ...fragment.requested,
            ...fragment.resolved,
          });
        });
    },
    async publishBoundary(managerThreadId, nextParentTurnId, observedAt) {
      check(progression && !state.blocked[managerThreadId], "native_progression_unavailable");
      const claim = claimFor(managerThreadId),
        cursor = state.cursors[managerThreadId];
      const receipt = cursor && state.continuations[hash([managerThreadId, cursor.cursorVersion])];
      check(
        claim && receipt?.nextParentTurnId === nextParentTurnId && state.results[claim.attemptId],
        "native_boundary_receipt_missing",
      );
      await drainAcknowledgements(managerThreadId);
      const publication = state.sourcePublications?.[claim.attemptId];
      check(!sourceProtocol || !publication || publication.applied, "native_source_not_applied");
      const event = enqueue(
        claim,
        {
          kind: "root_boundary",
          parentTurnId: claim.parentTurnId,
          nextParentTurnId,
          cursorVersion: cursor.cursorVersion,
          observedAt,
        },
        sourceProtocol ? acceptedContext(claim) : undefined,
      );
      await drainAcknowledgements(managerThreadId);
      check(
        event.acknowledged &&
          event.acknowledgement?.boundaryEventId === event.input.eventId &&
          event.acknowledgement.cursorVersion === cursor.cursorVersion &&
          !event.acknowledgement.blocked,
        "native_boundary_ack_invalid",
      );
      receipt.boundaryEventId = event.input.eventId;
      receipt.sequence = event.input.sequence;
      save();
      return {
        boundaryEventId: event.input.eventId,
        priorAttemptId: claim.attemptId,
        cursorVersion: cursor.cursorVersion,
        parentTurnId: claim.parentTurnId,
        nextParentTurnId,
        sequence: event.input.sequence,
      };
    },
    async requireCompletedChild(managerThreadId, attemptId) {
      const claim = claimFor(managerThreadId);
      check(
        claim?.attemptId === attemptId && !state.blocked[managerThreadId],
        "native_completion_not_ready",
      );
      const fragments = Object.values(state.fragments).filter((fragment) =>
        progression
          ? fragment.attemptId === attemptId
          : fragment.managerThreadId === managerThreadId,
      );
      check(
        fragments.length === 1 &&
          fragments[0].requested &&
          fragments[0].resolved &&
          typeof readNativeHistory === "function",
        "native_completion_not_ready",
      );
      const fragment = fragments[0];
      const history = await readNativeHistory({
        managerThreadId,
        childThreadId: fragment.childThreadId,
        spawnCallId: fragment.spawnCallId,
      });
      check(
        Array.isArray(history?.data) &&
          history.data.length > 0 &&
          history.data.length <= 20 &&
          !history.nextCursor &&
          history.data.every(
            (turn) =>
              turn.status === "completed" &&
              Array.isArray(turn.items) &&
              (!progression || turn.itemsView === "full"),
          ),
        "native_completion_not_ready",
      );
      for (const turn of history.data) appendTurn(claim, fragment, turn);
      await drainAcknowledgements(managerThreadId);
    },
    hold,
    beginClaim(params, command, eventId, checkoutBinding, continuation, authority) {
      if (!progression || command.operation !== "claim_step") return;
      const pinned = authority ?? {
        registrationId: currentRegistration()?.id,
        serverInstanceId: currentServerInstanceId(),
      };
      check(
        id(pinned.registrationId) && pinned.serverInstanceId === currentServerInstanceId(),
        "native_claim_authority_missing",
      );
      const key = intentKey(params),
        digest = hash({
          command,
          checkoutBinding,
          continuation: continuation ?? null,
          ...(sourceProtocol
            ? { sourceContext: pinned.sourceContext ?? null, inputSourceSha: pinned.inputSourceSha }
            : {}),
        });
      const existing = state.claimIntents[key];
      if (existing) {
        check(
          existing.eventId === eventId &&
            existing.digest === digest &&
            existing.registrationId === pinned.registrationId &&
            existing.serverInstanceId === pinned.serverInstanceId,
          "native_claim_intent_conflict",
        );
        return;
      }
      check(Object.keys(state.claimIntents).length < 256, "native_spool_limit");
      state.claimIntents[key] = {
        eventId,
        digest,
        parentTurnId: params.turnId,
        callId: params.callId,
        managerThreadId: params.threadId,
        continuation: continuation ?? null,
        ...(sourceProtocol
          ? {
              sourceContext: structuredClone(pinned.sourceContext),
              inputSourceSha: pinned.inputSourceSha,
            }
          : {}),
        registrationId: pinned.registrationId,
        serverInstanceId: pinned.serverInstanceId,
      };
      save();
    },
    recordUncertainResponse(params, command, result, authority) {
      if (!progression) return;
      const key = intentKey(params, authority.serverInstanceId);
      check(
        state.uncertainAcknowledgements[key] ||
          Object.keys(state.uncertainAcknowledgements).length < 256,
        "native_spool_limit",
      );
      state.uncertainAcknowledgements[key] = {
        operation: command.operation,
        responseDigest: hash(result),
        registrationId: authority.registrationId,
        serverInstanceId: authority.serverInstanceId,
        parentTurnId: params.turnId,
        callId: params.callId,
        ...(id(result?.attemptId) ? { attemptId: result.attemptId } : {}),
      };
      hold(params.threadId, "native_positive_response_authority_stale");
    },
    recordClaim(params, command, result, checkoutBinding) {
      if (command.operation !== "claim_step") return;
      check(
        id(result?.attemptId) &&
          id(result.managerBindingId) &&
          Number.isSafeInteger(result.leaseGeneration),
        "native_claim_receipt_invalid",
      );
      if (progression) {
        const intent = state.claimIntents[intentKey(params)],
          cursor = state.cursors[params.threadId];
        check(
          intent &&
            intent.serverInstanceId === currentServerInstanceId() &&
            intent.registrationId === currentRegistration()?.id &&
            currentRegistration()?.expiresAt > Date.now() &&
            result.progressionProtocol === 1 &&
            Number.isSafeInteger(result.cursorVersion) &&
            result.cursorVersion > 0 &&
            Number.isSafeInteger(result.nativeSequence) &&
            /^[a-f0-9]{64}$/.test(result.checkoutBindingDigest ?? ""),
          "native_protocol_one_receipt_invalid",
        );
        check(
          intent.digest ===
            hash({
              command,
              checkoutBinding,
              continuation: intent.continuation ?? null,
              ...(sourceProtocol
                ? {
                    sourceContext: intent.sourceContext ?? null,
                    inputSourceSha: intent.inputSourceSha,
                  }
                : {}),
            }),
          "native_claim_intent_conflict",
        );
        if (sourceProtocol)
          check(
            validContext(intent.sourceContext) &&
              contextEqual(result.sourceContext, intent.sourceContext) &&
              result.inputSourceSha === intent.inputSourceSha &&
              intent.inputSourceSha === (intent.sourceContext?.headSha ?? checkoutBinding.revision),
            "native_claim_source_mismatch",
          );
        if (result.replayed === true || result.needsReconciliation === true) {
          intent.historicalReceipt = {
            attemptId: result.attemptId,
            managerBindingId: result.managerBindingId,
            cursorVersion: result.cursorVersion,
            nativeSequence: result.nativeSequence,
          };
          hold(params.threadId, "native_claim_replay_requires_reconciliation");
          return;
        }
        if (
          !(
            result.replayed === false &&
            result.outcome === "running" &&
            result.canRun === false &&
            result.needsRuntimeBinding === true &&
            result.needsReconciliation === false
          )
        ) {
          hold(params.threadId, "native_claim_receipt_authority_unknown");
          throw new Error("native_claim_receipt_authority_unknown");
        }
        const prior = state.attempts[result.attemptId];
        if (prior) {
          check(
            prior.parentTurnId === params.turnId &&
              prior.claimCallId === params.callId &&
              prior.managerBindingId === result.managerBindingId &&
              prior.cursorVersion === result.cursorVersion &&
              hash(prior.checkoutBinding) === hash(checkoutBinding),
            "native_claim_replay_conflict",
          );
          return;
        }
        check(!state.claims[params.threadId] || cursor, "native_legacy_claim_not_upgraded");
        if (cursor) {
          const previous = state.attempts[cursor.attemptId],
            receipt = state.continuations[hash([params.threadId, cursor.cursorVersion])];
          check(
            previous &&
              result.managerBindingId === previous.managerBindingId &&
              result.checkoutBindingDigest === previous.checkoutBindingDigest &&
              command.payload.taskId === previous.taskId &&
              hash(checkoutBinding) === hash(previous.checkoutBinding) &&
              result.cursorVersion === cursor.cursorVersion + 1 &&
              result.nativeSequence === cursor.acknowledgedSequence &&
              cursor.sequence === cursor.acknowledgedSequence &&
              receipt?.nextParentTurnId === params.turnId &&
              intent.continuation?.boundaryEventId === receipt.boundaryEventId,
            "native_continuation_receipt_mismatch",
          );
        } else {
          check(Object.keys(state.claims).length < 32, "native_spool_limit");
          check(
            result.cursorVersion === 1 && result.nativeSequence === 0 && !intent.continuation,
            "native_first_claim_mismatch",
          );
        }
        check(Object.keys(state.attempts).length < 128, "native_spool_limit");
        const claim = {
          managerThreadId: params.threadId,
          parentTurnId: params.turnId,
          claimCallId: params.callId,
          serverInstanceId: intent.serverInstanceId,
          registrationId: intent.registrationId,
          checkoutBinding: structuredClone(checkoutBinding),
          ...(sourceProtocol
            ? {
                sourceContext: structuredClone(intent.sourceContext),
                inputSourceSha: intent.inputSourceSha,
              }
            : {}),
          checkoutBindingDigest: result.checkoutBindingDigest,
          managerBindingId: result.managerBindingId,
          taskId: command.payload.taskId,
          stepId: command.payload.stepId,
          attemptId: result.attemptId,
          leaseGeneration: result.leaseGeneration,
          sequence: result.nativeSequence,
          cursorVersion: result.cursorVersion,
          progressionProtocol: 1,
        };
        state.attempts[claim.attemptId] = claim;
        state.claims[params.threadId] ??= claim; // Physical writer anchor is never cleared.
        state.cursors[params.threadId] = {
          attemptId: claim.attemptId,
          cursorVersion: claim.cursorVersion,
          sequence: result.nativeSequence,
          acknowledgedSequence: result.nativeSequence,
        };
        intent.attemptId = claim.attemptId;
        save();
        // Reservation only: never promote canRun. Native binding/settings and
        // controller evidence gates remain required for the proposed child.
        return;
      }
      check(result.progressionProtocol !== 1, "native_progression_not_enabled");
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
      const claim =
        progression && state.cursors[managerThreadId]
          ? state.attempts[state.cursors[managerThreadId].attemptId]
          : state.claims[managerThreadId];
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
        const claim = fragmentClaim(fragment);
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
        ...(progression
          ? {
              attempts: Object.keys(state.attempts).length,
              currentCursors: structuredClone(state.cursors),
              violations: Object.values(state.violations).length,
              uncertainAcknowledgements: Object.keys(state.uncertainAcknowledgements).length,
            }
          : {}),
      };
    },
  };
}
