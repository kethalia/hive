#!/usr/bin/env node
// Opt-in, synthetic local Responses only. No account credentials, cloud or host mutation.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { processIdentity } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import { createNativeManagerRouter } from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");
function gate() {
  let release;
  const promise = new Promise((done) => {
    release = done;
  });
  return { promise, release };
}
async function until(check, code, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await pause(20);
  }
  throw new Error(code);
}
const message = (id, text) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const tool = (id, name, args, namespace) => ({
  id,
  type: "function_call",
  name,
  ...(namespace ? { namespace } : {}),
  call_id: id,
  arguments: JSON.stringify(args),
  status: "completed",
});
function stream(response, id, output) {
  if (response.destroyed) return;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const events = [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
  ];
  output.forEach((item, output_index) => {
    events.push(
      {
        type: "response.output_item.added",
        output_index,
        item: { ...item, status: "in_progress" },
      },
      { type: "response.output_item.done", output_index, item },
    );
  });
  events.push({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function hasTruncation(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (/truncat/i.test(key) && child !== false && child !== null && child !== 0 && child !== "") ||
      hasTruncation(child),
  );
}

export async function probeManagerTurnBoundary() {
  assert.equal(process.env.HIVE_TEST_NATIVE_CODEX, "1", "explicit_local_native_opt_in_required");
  const executable = realpathSync(
    process.env.HIVE_TEST_CODEX_EXECUTABLE ??
      "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  const runtimeSha256 = hash(readFileSync(executable));
  assert.equal(
    runtimeSha256,
    "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5",
    "unreviewed_native_digest",
  );
  const scratch = mkdtempSync(join(tmpdir(), "hive-manager-boundary-"));
  const home = join(scratch, "home"),
    checkout = join(scratch, "checkout");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(checkout, { mode: 0o700 });
  const childGate = gate(),
    handlersGate = gate(),
    observerGate = gate(),
    concurrentGate = gate();
  const pending = new Map(),
    frames = [],
    providerRequests = [],
    observerWork = new Set(),
    handlerWork = new Set();
  const startCalls = [];
  let child,
    rootThreadId,
    rootTurnId,
    receiveSequence = 0,
    notificationSequence = 0,
    requestSequence = 0,
    rootResponses = 0,
    childRequested = false,
    peakHandlers = 0,
    stage = "initialize";
  const sourcePaths = [
    "scripts/probe-codex-manager-turn-boundary.mjs",
    "templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
    "templates/ai-dev-k8s/scripts/codex-process-identity.mjs",
    "docs/checks/autonomous-delivery/manager-progression-design.md",
  ];
  const report = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDigests: Object.fromEntries(sourcePaths.map((path) => [path, hash(readFileSync(path))])),
    testedSourcesCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...sourcePaths], {
      encoding: "utf8",
    }).trim(),
    runtimeSha256,
    modelProvider: "local_mock_responses_only",
    accountCredentials: false,
    accountInference: false,
    cloudMutations: false,
    canonicalHostChanges: false,
    executionFlagsEnabled: false,
    checks: {},
    history: {},
    limitations: [],
    passed: false,
    officialProtocolReference: "https://learn.chatgpt.com/docs/app-server",
    bounds: {
      nativeRuntimeMilliseconds: 90000,
      rpcMilliseconds: 8000,
      providerRequests: 24,
      providerBodyBytes: 4 * 1024 * 1024,
      frames: 4096,
      totalFrameBytes: 32 * 1024 * 1024,
      historyPages: 32,
      historyItems: 512,
    },
  };
  const provider = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > report.bounds.providerBodyBytes) request.destroy();
    });
    request.on("end", () => {
      if (providerRequests.length >= report.bounds.providerRequests) {
        response.writeHead(503);
        response.end();
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      const lastUser = [...(body.input ?? [])].reverse().find((item) => item.role === "user");
      const marker = JSON.stringify(lastUser) ?? "";
      const isChild =
        request.headers["x-codex-parent-thread-id"] === rootThreadId ||
        marker.includes("HIVE_BOUNDARY_CHILD");
      const id = `fixture_response_${providerRequests.length + 1}`;
      providerRequests.push({
        kind: isChild
          ? "child"
          : marker.includes("HIVE_BOUNDARY_NEXT")
            ? "continuation"
            : marker.includes("HIVE_CONCURRENT")
              ? "concurrency_control"
              : "root",
      });
      if (isChild) {
        childRequested = true;
        void childGate.promise.then(() =>
          stream(response, id, [message("child_final", "HIVE_BOUNDARY_CHILD_DONE")]),
        );
      } else if (marker.includes("HIVE_CONCURRENT")) {
        void concurrentGate.promise.then(() =>
          stream(response, id, [message(`${id}_final`, "HIVE_CONCURRENT_DONE")]),
        );
      } else if (marker.includes("HIVE_BOUNDARY_NEXT")) {
        stream(response, id, [message("next_final", "HIVE_BOUNDARY_NEXT_DONE")]);
      } else {
        const step = rootResponses++;
        stream(
          response,
          id,
          step === 0
            ? [
                tool(
                  "spawn_boundary_child",
                  "spawn_agent",
                  {
                    task_name: "boundary_child",
                    message:
                      "HIVE_BOUNDARY_CHILD: return only the fixed local fixture marker, no tools.",
                    fork_turns: "none",
                    model: "gpt-6.1-sol",
                    reasoning_effort: "low",
                  },
                  "collaboration",
                ),
              ]
            : step === 1
              ? [
                  tool("probe_tool_one", "hive_delivery", { fixture: "one" }),
                  tool("probe_tool_two", "hive_delivery", { fixture: "two" }),
                ]
              : [message("root_final", "HIVE_BOUNDARY_ROOT_DONE")],
        );
      }
    });
  });
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));
  writeFileSync(
    join(home, "config.toml"),
    `model="gpt-6.1-sol"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="read-only"\nweb_search="disabled"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="Local mock only"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\napps=false\nplugins=false\nhooks=false\nmemories=false\n`,
    { mode: 0o600 },
  );
  let totalFrameBytes = 0,
    stderr = "",
    frameFailure;
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const call = (method, params) =>
    new Promise((resolveCall, reject) => {
      const id = ++requestSequence;
      const start =
        method === "turn/start"
          ? { requestId: id, threadId: params.threadId, sentAfterReceiveSequence: receiveSequence }
          : null;
      if (start) startCalls.push(start);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc_timeout:${method}`));
      }, report.bounds.rpcMilliseconds);
      pending.set(id, { resolve: resolveCall, reject, timer, start });
      send({ id, method, params });
    });
  const adapter = {
    observe(frame) {
      const operation = (async () => {
        if (
          frame.method === "turn/completed" &&
          frame.params.threadId === rootThreadId &&
          frame.params.turn.id === rootTurnId
        )
          await observerGate.promise;
      })();
      observerWork.add(operation);
      void operation.finally(() => observerWork.delete(operation));
      return operation;
    },
    async handleToolCall(params) {
      const key = params.callId;
      handlerWork.add(key);
      peakHandlers = Math.max(peakHandlers, handlerWork.size);
      try {
        await handlersGate.promise;
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "FIXTURE_READ_ONLY_RESULT" }],
        };
      } finally {
        handlerWork.delete(key);
      }
    },
  };
  const router = createNativeManagerRouter(
    () => adapter,
    (id, result) => send({ id, result }),
  );
  const rawEvents = (method, threadId) =>
    frames.filter((frame) => frame.method === method && frame.params?.threadId === threadId);
  const turnDone = (threadId, turnId) =>
    rawEvents("turn/completed", threadId).find((frame) => frame.params.turn.id === turnId);
  const turns = async (threadId) => {
    const pages = [],
      data = [],
      cursors = new Set();
    let cursor;
    do {
      const result = await call("thread/turns/list", {
        threadId,
        limit: 1,
        sortDirection: "asc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(Array.isArray(result.data), "turn_history_missing");
      assert.ok(
        result.data.every((turn) => turn.itemsView === "full" && Array.isArray(turn.items)),
        "full_turn_items_not_returned",
      );
      pages.push(result);
      data.push(...result.data);
      assert.ok(pages.length <= 32 && data.length <= 64, "turn_history_limit");
      cursor = result.nextCursor;
      assert.ok(!cursor || !cursors.has(cursor), "turn_history_cursor_cycle");
      cursors.add(cursor);
    } while (cursor);
    return { pages, data };
  };
  const items = async (threadId, turnId) => {
    const data = [],
      cursors = new Set();
    let cursor,
      pages = 0;
    do {
      const result = await call("thread/items/list", {
        threadId,
        turnId,
        limit: 1,
        sortDirection: "asc",
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(Array.isArray(result.data), "item_history_missing");
      data.push(...result.data);
      assert.ok(++pages <= 32 && data.length <= report.bounds.historyItems, "item_history_limit");
      cursor = result.nextCursor;
      assert.ok(!cursor || !cursors.has(cursor), "item_history_cursor_cycle");
      cursors.add(cursor);
    } while (cursor);
    return { data, pages };
  };
  const summarizeTurn = (turn) => ({
    id: turn.id,
    status: turn.status,
    rootTurnId: turn.rootTurnId,
    itemsView: turn.itemsView,
    keys: Object.keys(turn),
    items: turn.items?.map((item) => ({
      id: item.id,
      type: item.type,
      keys: Object.keys(item),
      ...(item.agentThreadId ? { agentThreadId: item.agentThreadId } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.model ? { model: item.model, reasoningEffort: item.reasoningEffort } : {}),
    })),
  });
  let watchdog;
  try {
    child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: checkout,
      env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home, LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchdog = setTimeout(() => child.kill("SIGKILL"), report.bounds.nativeRuntimeMilliseconds);
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.once("exit", () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("native_exited"));
      }
      pending.clear();
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      totalFrameBytes += Buffer.byteLength(line);
      if (
        frames.length >= report.bounds.frames ||
        totalFrameBytes > report.bounds.totalFrameBytes
      ) {
        frameFailure = "frame_limit";
        child.kill("SIGKILL");
        return;
      }
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        frameFailure = "invalid_frame";
        child.kill("SIGKILL");
        return;
      }
      const sequence = ++receiveSequence;
      if (frame.method) {
        notificationSequence++;
        frames.push({ ...frame, receiveSequence: sequence });
        router(frame);
        return;
      }
      const entry = pending.get(frame.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      if (entry.start) {
        entry.start.responseReceiveSequence = sequence;
        entry.start.returnedTurnId = frame.result?.turn?.id ?? null;
        entry.start.rpcCode = frame.error?.code ?? null;
      }
      if (frame.error) {
        const error = new Error(`rpc_rejected:${frame.error.code}`);
        error.rpc = frame.error;
        entry.reject(error);
      } else entry.resolve(frame.result);
    });
    const initialized = await call("initialize", {
      clientInfo: { name: "hive_manager_boundary_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    assert.match(initialized.userAgent, /\/0\.165\.0(?:\s|$)/);
    report.nativeVersion = "0.165.0";
    const identity = processIdentity(child.pid);
    report.processBefore = identity;
    send({ method: "initialized" });
    const started = await call("thread/start", {
      cwd: checkout,
      model: "gpt-6.1-sol",
      historyMode: "paginated",
      experimentalRawEvents: true,
      dynamicTools: [
        {
          name: "hive_delivery",
          description: "Synthetic read-only boundary probe, no external effects.",
          inputSchema: {
            type: "object",
            properties: { fixture: { type: "string" } },
            required: ["fixture"],
            additionalProperties: false,
          },
        },
      ],
    });
    rootThreadId = started.thread.id;
    report.rootThreadId = rootThreadId;
    stage = "delegated_root_turn";
    const first = await call("turn/start", {
      threadId: rootThreadId,
      input: [{ type: "text", text: "HIVE_BOUNDARY_ROOT", text_elements: [] }],
    });
    rootTurnId = first.turn.id;
    report.rootTurnId = rootTurnId;
    await until(
      () => handlerWork.size === 2 && childRequested,
      "parallel_handlers_or_child_missing",
    );
    report.checks.actualConcurrentDynamicHandlers = peakHandlers === 2;
    report.router = {
      activeHandlersBeforeRelease: handlerWork.size,
      peakHandlers,
      canonicalRouterReturnsSynchronously: true,
      observersAreDetached: true,
      nativeGlobalWatermarkClaimed: false,
    };
    handlersGate.release();
    await until(() => turnDone(rootThreadId, rootTurnId), "root_completion_missing");
    const spawnFrame = rawEvents("item/completed", rootThreadId).find(
      (frame) =>
        frame.params.item?.type === "subAgentActivity" && frame.params.item.kind === "started",
    );
    assert.ok(spawnFrame?.params.item.agentThreadId, "resolved_child_identity_missing");
    const childThreadId = spawnFrame.params.item.agentThreadId;
    report.childThreadId = childThreadId;
    const rootBefore = await turns(rootThreadId),
      childBefore = await turns(childThreadId);
    report.history.beforeChildCompletion = {
      root: rootBefore.data.map(summarizeTurn),
      child: childBefore.data.map(summarizeTurn),
      pendingObservers: observerWork.size,
    };
    assert.equal(rootBefore.data.find((turn) => turn.id === rootTurnId)?.status, "completed");
    report.checks.rootCanFinishBeforeChild = childBefore.data.some(
      (turn) => turn.status === "inProgress",
    );
    report.checks.terminalRootHistoryDoesNotDrainObserver = observerWork.size > 0;
    report.checks.boundaryHoldsForChildAndObserver =
      report.checks.rootCanFinishBeforeChild && observerWork.size > 0;
    stage = "full_history_reconciliation";
    childGate.release();
    const childAfter = await until(async () => {
      const history = await turns(childThreadId);
      return history.data.length && history.data.every((turn) => turn.status === "completed")
        ? history
        : null;
    }, "child_terminal_history_missing");
    observerGate.release();
    await until(() => observerWork.size === 0 && handlerWork.size === 0, "observer_drain_missing");
    let beforeSequence,
      rootAfter,
      fullRootItems,
      fullChildItems,
      loaded,
      reconciled = false,
      reconciliationReads = 0;
    for (; reconciliationReads < 3; reconciliationReads++) {
      beforeSequence = notificationSequence;
      rootAfter = await turns(rootThreadId);
      const childRecheck = await turns(childThreadId);
      assert.ok(
        childRecheck.data.length && childRecheck.data.every((turn) => turn.status === "completed"),
        "child_history_changed",
      );
      fullRootItems = await items(rootThreadId, rootTurnId);
      fullChildItems = await items(childThreadId, childAfter.data[0].id);
      loaded = await call("thread/loaded/list", { limit: 64 });
      assert.ok(
        Array.isArray(loaded.data) &&
          !loaded.nextCursor &&
          loaded.data.includes(rootThreadId) &&
          loaded.data.every((id) => [rootThreadId, childThreadId].includes(id)),
        "unknown_or_truncated_thread_inventory",
      );
      await Promise.all([...observerWork]);
      if (beforeSequence === notificationSequence && !observerWork.size && !handlerWork.size) {
        reconciled = true;
        break;
      }
    }
    assert.ok(reconciled, "native_frames_changed_during_reconciliation");
    assert.ok(
      !hasTruncation([rootAfter, childAfter, fullRootItems, fullChildItems]),
      "truncated_history",
    );
    report.history.reconciled = {
      root: rootAfter.data.map(summarizeTurn),
      child: childAfter.data.map(summarizeTurn),
      rootItemPages: fullRootItems.pages,
      childItemPages: fullChildItems.pages,
      rootItemTypes: fullRootItems.data.map((entry) => entry.item.type),
      childItemTypes: fullChildItems.data.map((entry) => entry.item.type),
      notificationSequenceBefore: beforeSequence,
      notificationSequenceAfter: notificationSequence,
      reconciliationReads: reconciliationReads + 1,
      loadedThreadIds: loaded.data,
      pendingObservers: observerWork.size,
      pendingHandlers: handlerWork.size,
    };
    const rootItemIds = fullRootItems.data.map((entry) => entry.item.id);
    const turnItemIds = rootAfter.data[0].items.map((item) => item.id);
    assert.deepEqual(rootItemIds, turnItemIds, "full_turn_and_item_pages_disagree");
    assert.equal(new Set(rootItemIds).size, rootItemIds.length, "duplicated_item_history");
    assert.deepEqual(
      fullChildItems.data.map((entry) => entry.item.id),
      childAfter.data[0].items.map((item) => item.id),
      "child_item_pages_disagree",
    );
    assert.ok(
      fullRootItems.data.some(
        (entry) =>
          entry.item.type === "subAgentActivity" && entry.item.agentThreadId === childThreadId,
      ),
      "history_does_not_resolve_spawn",
    );
    assert.ok(
      fullRootItems.data.filter((entry) => entry.item.type === "dynamicToolCall").length === 2,
      "history_omits_dynamic_tools",
    );
    assert.ok(
      fullRootItems.data
        .filter((entry) => entry.item.type === "dynamicToolCall")
        .every(
          (entry) =>
            entry.item.status === "completed" &&
            entry.item.success === true &&
            entry.item.contentItems.some((item) => item.text === "FIXTURE_READ_ONLY_RESULT"),
        ),
      "tool_results_incomplete",
    );
    const nativeSpawn = rawEvents("rawResponseItem/completed", rootThreadId).find(
      (frame) => frame.params.item?.name === "spawn_agent",
    );
    const spawnHistory = fullRootItems.data.find(
      (entry) => entry.item.type === "subAgentActivity" && entry.item.kind === "started",
    )?.item;
    assert.equal(nativeSpawn?.params.turnId, rootTurnId, "raw_spawn_turn_mismatch");
    assert.equal(
      spawnHistory?.id,
      nativeSpawn?.params.item.call_id,
      "persisted_spawn_call_mismatch",
    );
    const requested = JSON.parse(nativeSpawn.params.item.arguments);
    assert.equal(requested.model, spawnHistory.model, "persisted_spawn_model_mismatch");
    assert.equal(
      requested.reasoning_effort,
      spawnHistory.reasoningEffort,
      "persisted_spawn_effort_mismatch",
    );
    const hadChildCompletion = rootBefore.data[0].items.some(
      (item) => item.type === "subAgentActivity" && item.kind === "completed",
    );
    assert.equal(hadChildCompletion, false, "child_was_not_actually_delayed");
    assert.ok(
      rootAfter.data[0].items.some(
        (item) =>
          item.type === "subAgentActivity" &&
          item.kind === "completed" &&
          item.agentThreadId === childThreadId,
      ),
      "late_child_fact_missing_from_old_root",
    );
    report.checks.completedRootHistoryCanGainDelayedChildFact = true;
    report.checks.requestedAndPersistedSpawnIdentitiesMatch = true;
    report.checks.notificationFenceStableAfterChildAndObserverDrain = true;
    report.checks.noUnknownLoadedThreadsAtBoundary = true;
    report.checks.fullBoundedHistoryResolvesSpawnAndTools = true;
    report.checks.fullViewAndAllItemCursorsExhaustedWithoutTruncationSignal = true;
    report.checks.childTerminalHistoryAvailable = true;
    stage = "same_root_continuation";
    const next = await call("turn/start", {
      threadId: rootThreadId,
      input: [{ type: "text", text: "HIVE_BOUNDARY_NEXT", text_elements: [] }],
    });
    await until(() => turnDone(rootThreadId, next.turn.id), "continuation_completion_missing");
    const finalRoot = await turns(rootThreadId);
    assert.equal(finalRoot.data.length, 2, "unexpected_root_turn_count");
    assert.deepEqual(
      finalRoot.data.map((turn) => turn.id),
      [rootTurnId, next.turn.id],
    );
    assert.notEqual(rootTurnId, next.turn.id);
    const nextStarted = rawEvents("turn/started", rootThreadId).find(
      (frame) => frame.params.turn.id === next.turn.id,
    );
    assert.ok(nextStarted, "continuation_started_frame_missing");
    const nextStartCall = startCalls.find((entry) => entry.returnedTurnId === next.turn.id);
    assert.ok(
      turnDone(rootThreadId, rootTurnId).receiveSequence < nextStartCall.sentAfterReceiveSequence &&
        nextStarted.receiveSequence > nextStartCall.sentAfterReceiveSequence,
      "continuation_order_invalid",
    );
    report.boundaryOrder = {
      priorCompletedReceiveSequence: turnDone(rootThreadId, rootTurnId).receiveSequence,
      nextStartSentAfterReceiveSequence: nextStartCall.sentAfterReceiveSequence,
      nextStartedReceiveSequence: nextStarted.receiveSequence,
      nextStartResponseReceiveSequence: nextStartCall.responseReceiveSequence,
      responseAndStartedFrameTurnIdMatch: true,
    };
    assert.deepEqual(processIdentity(child.pid), identity, "native_runtime_changed");
    report.nextRootTurnId = next.turn.id;
    report.processAfter = processIdentity(child.pid);
    report.history.afterContinuation = {
      turnPages: finalRoot.pages.length,
      turns: finalRoot.data.map(summarizeTurn),
    };
    report.checks.exactlyOneContinuationSameRootAndNativeLifetime = true;
    report.checks.turnPaginationExhausted =
      finalRoot.pages.length === 2 && !finalRoot.pages.at(-1).nextCursor;
    stage = "native_concurrent_turn_start_control";
    const concurrent = await call("thread/start", {
      cwd: checkout,
      model: "gpt-6.1-sol",
      historyMode: "paginated",
    });
    const concurrencyStart = await call("turn/start", {
      threadId: concurrent.thread.id,
      input: [{ type: "text", text: "HIVE_CONCURRENT_A", text_elements: [] }],
    });
    await until(
      () => providerRequests.some((request) => request.kind === "concurrency_control"),
      "concurrency_provider_not_held",
    );
    const requests = await Promise.allSettled(
      ["B", "C"].map((marker) =>
        call("turn/start", {
          threadId: concurrent.thread.id,
          input: [{ type: "text", text: `HIVE_CONCURRENT_${marker}`, text_elements: [] }],
        }),
      ),
    );
    report.concurrencyControl = {
      separateThreadId: concurrent.thread.id,
      initialTurnId: concurrencyStart.turn.id,
      results: requests.map((result) =>
        result.status === "fulfilled"
          ? { accepted: true, turnId: result.value.turn.id, status: result.value.turn.status }
          : {
              accepted: false,
              rpcCode: result.reason.rpc?.code ?? null,
              error: result.reason.message,
            },
      ),
      notRunOnManagerRoot: true,
    };
    concurrentGate.release();
    await until(
      async () =>
        (await turns(concurrent.thread.id)).data.every((turn) => turn.status !== "inProgress"),
      "concurrency_control_not_terminal",
    );
    report.concurrencyControl.history = (await turns(concurrent.thread.id)).data.map(summarizeTurn);
    report.concurrencyControl.inputOrder = (await turns(concurrent.thread.id)).data.flatMap(
      (turn) =>
        turn.items
          .filter((item) => item.type === "userMessage")
          .map(
            (item) =>
              JSON.stringify(item.content).match(/HIVE_CONCURRENT_[ABC]/)?.[0] ??
              "unknown_fixture_input",
          ),
    );
    report.concurrencyControl.nativeRejectedCompetingStarts = requests.every(
      (result) => result.status === "rejected",
    );
    report.concurrencyControl.acceptedAsExistingTurnInput = requests.every(
      (result) =>
        result.status === "fulfilled" && result.value.turn.id === concurrencyStart.turn.id,
    );
    report.concurrencyControl.exclusiveSupervisorAdmissionRequired = true;
    report.checks.nativeConcurrentStartCharacterized = true;
    assert.ok(!frameFailure, frameFailure);
    assert.ok(
      Object.values(report.checks).every((value) => value === true),
      "required_boundary_observation_missing",
    );
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      code: frameFailure ?? String(error.message).slice(0, 160),
      ...(error.rpc ? { rpcCode: error.rpc.code } : {}),
    };
  } finally {
    for (const entry of [childGate, handlersGate, observerGate, concurrentGate]) entry.release();
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child) {
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "native_cleanup_timeout",
        1500,
      ).catch(() => child.kill("SIGKILL"));
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "native_force_cleanup_timeout",
        1500,
      );
      report.nativeProcessExitedDuringCleanup = true;
    }
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    report.providerRequests = providerRequests;
    report.turnStartCalls = startCalls;
    report.framesReceived = receiveSequence;
    report.frameBytes = totalFrameBytes;
    report.stderrCapturedPrivatelyOnly = Boolean(stderr);
    report.limitations.push(
      "Synthetic provider and read-only dynamic tool handlers only; no controller transaction, signed boundary receipt, supervisor admission journal, CLI/browser attachment or account model inference tested.",
      "Router handler/observer counters are local fixture accounting, not a native admission watermark. Native can execute unadmitted work; no JavaScript mutex is claimed to prevent spawning.",
      "Only the small captured histories are reconciled; hard page/byte/frame limits must fail closed for larger or truncated histories. Terminal turns do not prove OS-process/background/external-operation quiescence.",
      "Full itemsView plus exhausted cursors proves the fixture's native UI item set, not unlimited raw Responses history, untruncated shell output or a global collaboration admission freeze. Persist requested spawn settings from the original raw event; history retains resolved child/model/effort identities but not the entire spawn argument object.",
    );
    rmSync(scratch, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await probeManagerTurnBoundary();
  const output = "docs/checks/autonomous-delivery/native-manager-turn-boundary.json";
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
  console.log(
    JSON.stringify({
      passed: report.passed,
      output,
      checks: report.checks,
      failure: report.failure ?? null,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
