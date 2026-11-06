// Trusted controller-created evaluation threads in the existing native server.
// No browser/model method dispatches this module. A native thread is never
// adopted from a manager tool result, child event, transcript or caller path.
import { createHash } from "node:crypto";

export const ACCEPTANCE_PROFILE = "hive-independent-evaluator";
export const ACCEPTANCE_PERMISSIONS = Object.freeze({
  schemaVersion: 1,
  profile: ACCEPTANCE_PROFILE,
  filesystem: "read-only",
  network: false,
  approvals: "never",
  shell: false,
  collaboration: false,
  apps: false,
  plugins: false,
  hooks: false,
  web: false,
  goals: false,
  context: "controller-created-no-repository-instructions",
  tools: "none",
});
export const ACCEPTANCE_PERMISSIONS_DIGEST = createHash("sha256")
  .update(JSON.stringify(ACCEPTANCE_PERMISSIONS))
  .digest("hex");
const check = (value, reason = "acceptance_native_unavailable") => {
  if (!value) throw new Error(reason);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export function validateAcceptanceProducer(value) {
  const keys = [
    "schemaVersion",
    "codeDigest",
    "promptDigest",
    "schemaDigest",
    "permissionsDigest",
    "runtimeVersion",
    "model",
    "effort",
    "maxDurationMs",
    "maxInputBytes",
    "maxOutputBytes",
  ];
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === keys.sort().join(),
    "acceptance_configuration_invalid",
  );
  check(
    value.schemaVersion === 1 &&
      value.runtimeVersion === "0.165.0" &&
      value.permissionsDigest === ACCEPTANCE_PERMISSIONS_DIGEST &&
      [value.codeDigest, value.promptDigest, value.schemaDigest].every(
        (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
      ) &&
      typeof value.model === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value.model) &&
      ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value.effort) &&
      Number.isSafeInteger(value.maxDurationMs) &&
      value.maxDurationMs >= 1000 &&
      value.maxDurationMs <= 300000 &&
      Number.isSafeInteger(value.maxInputBytes) &&
      value.maxInputBytes >= 32768 &&
      value.maxInputBytes <= 262144 &&
      Number.isSafeInteger(value.maxOutputBytes) &&
      value.maxOutputBytes >= 1024 &&
      value.maxOutputBytes <= 65536,
    "acceptance_configuration_invalid",
  );
  return structuredClone(value);
}
export const ACCEPTANCE_THREAD_CONFIG = Object.freeze({
  "features.shell_tool": false,
  "features.multi_agent": false,
  "features.goals": false,
  "features.apps": false,
  "features.plugins": false,
  "features.hooks": false,
  "features.memories": false,
  web_search: "disabled",
});

export function createNativeAcceptanceEvaluator({
  runtime,
  producer,
  workingDirectory,
  state,
  save,
  assertAuthority,
  serverInstanceId,
}) {
  check(
    runtime &&
      typeof runtime.observeInstalled === "function" &&
      typeof runtime.interruptAcceptance === "function",
  );
  check(
    producer.permissionsDigest === ACCEPTANCE_PERMISSIONS_DIGEST &&
      producer.runtimeVersion === "0.165.0",
  );
  check(
    typeof workingDirectory === "string" &&
      workingDirectory.startsWith("/") &&
      !workingDirectory.includes("\0"),
  );
  check(
    state &&
      typeof state === "object" &&
      typeof save === "function" &&
      typeof assertAuthority === "function",
  );
  if (!state.entries) state.entries = {};
  check(Object.keys(state.entries).length <= 64);
  // Old lifetime state is history only. It cannot authorize a new root or make
  // an uncertain previous native request disappear.
  check(
    !Object.values(state.entries).some(
      (e) => e.serverInstanceId !== serverInstanceId && !["archived"].includes(e.phase),
    ),
    "acceptance_prior_lifetime_held",
  );
  let waiter = null,
    closed = false;
  const current = (jobId) => {
    const entry = state.entries[jobId];
    check(entry && entry.serverInstanceId === serverInstanceId, "acceptance_native_identity");
    return entry;
  };
  const live = () => {
    check(!closed && runtime.alive(), "acceptance_native_closed");
    assertAuthority();
  };
  const persist = () => save();
  const fail = (entry, reason) => {
    entry.phase = "held";
    entry.reason = reason;
    persist();
    if (waiter?.jobId === entry.jobId) waiter.reject(new Error(reason));
  };
  const verifyInput = (entry, item) => {
    check(
      item.type === "userMessage" &&
        id(item.id) &&
        item.clientId === entry.jobId &&
        Array.isArray(item.content) &&
        item.content.length === 1 &&
        item.content[0].type === "text" &&
        hash(item.content[0].text) === entry.userInputDigest &&
        Array.isArray(item.content[0].text_elements) &&
        item.content[0].text_elements.length === 0 &&
        (!entry.userInputId || entry.userInputId === item.id),
      "acceptance_unexpected_input",
    );
    entry.userInputId = item.id;
  };
  const unsubscribe = runtime.observeInstalled((message) => {
    if (!message.method || !message.params?.threadId) return;
    const entry = Object.values(state.entries).find(
      (e) => e.threadId === message.params.threadId && e.serverInstanceId === serverInstanceId,
    );
    if (!entry) return;
    if (["thread/archived", "thread/closed", "thread/unsubscribed"].includes(message.method))
      return;
    try {
      live();
      const p = message.params;
      if (message.method === "turn/started") {
        check(
          ["submitted", "running"].includes(entry.phase) &&
            id(p.turn?.id) &&
            (!entry.turnId || entry.turnId === p.turn.id),
          "acceptance_unexpected_turn",
        );
        entry.turnId = p.turn.id;
        entry.phase = "running";
        persist();
        return;
      }
      if (message.method === "rawResponseItem/completed") {
        if (
          [
            "function_call",
            "custom_tool_call",
            "computer_call",
            "web_search_call",
            "code_interpreter_call",
            "mcp_call",
          ].includes(p.item?.type)
        )
          throw new Error("acceptance_unexpected_tool");
        return;
      }
      if (
        message.method === "item/tool/call" ||
        message.method.includes("requestApproval") ||
        message.method.includes("requestUserInput")
      )
        throw new Error("acceptance_unexpected_tool");
      if (["item/started", "item/completed"].includes(message.method)) {
        check(
          ["userMessage", "agentMessage", "reasoning", "plan"].includes(p.item?.type),
          "acceptance_unexpected_tool",
        );
        check(
          !p.turnId || !entry.turnId || p.turnId === entry.turnId,
          "acceptance_unexpected_turn",
        );
        if (p.item.type === "userMessage") {
          verifyInput(entry, p.item);
          persist();
        }
        if (
          message.method === "item/completed" &&
          p.item.type === "agentMessage" &&
          (p.item.phase === "final_answer" || p.item.phase == null)
        ) {
          check(
            typeof p.item.text === "string" &&
              Buffer.byteLength(p.item.text) <= producer.maxOutputBytes &&
              !entry.output,
            "acceptance_output_invalid",
          );
          entry.output = p.item.text;
          entry.outputDigest = hash(p.item.text);
          persist();
        }
        return;
      }
      if (message.method === "turn/completed") {
        check(
          entry.turnId === p.turn?.id &&
            p.turn.status === "completed" &&
            entry.output &&
            entry.phase === "running",
          "acceptance_turn_incomplete",
        );
        entry.phase = "terminal";
        entry.completedAt = Date.now();
        persist();
        if (waiter?.jobId === entry.jobId) waiter.resolve();
      }
    } catch (error) {
      fail(
        entry,
        error.message?.startsWith("acceptance_") ? error.message : "acceptance_native_revoked",
      );
    }
  });
  async function create(job) {
    live();
    check(!state.admissionClosed && !waiter, "acceptance_admission_closed");
    check(
      id(job.jobId) &&
        job.producer &&
        canonical(job.producer) === canonical(producer) &&
        typeof job.instructions === "string" &&
        job.outputSchema &&
        !state.entries[job.jobId] &&
        Object.keys(state.entries).length < 64,
    );
    check(
      ["plan", "review"].includes(job.kind) &&
        job.protocol &&
        hash(canonical(job.protocol.prompts)) === producer.promptDigest &&
        hash(canonical(job.protocol.schemas)) === producer.schemaDigest &&
        job.instructions === job.protocol.prompts[job.kind] &&
        canonical(job.outputSchema) === canonical(job.protocol.schemas[job.kind]),
      "acceptance_protocol_mismatch",
    );
    check(
      !Object.values(state.entries).some((e) => e.phase !== "archived"),
      "acceptance_slot_held",
    );
    check(
      hash(canonical(job.payload)) === job.inputDigest &&
        Buffer.byteLength(canonical(job.payload)) <= producer.maxInputBytes,
      "acceptance_input_mismatch",
    );
    // Query available models, with no automatic provider/model substitution.
    const catalog = await runtime.call("model/list", { limit: 100, includeHidden: false });
    live();
    const model = catalog.data?.find((m) => m.model === producer.model);
    check(
      !catalog.nextCursor &&
        model?.supportedReasoningEfforts?.some((e) => e.reasoningEffort === producer.effort),
      "acceptance_model_unavailable",
    );
    const entry = {
      jobId: job.jobId,
      phase: "creating",
      serverInstanceId,
      inputDigest: job.inputDigest,
      expiresAt: job.expiresAt,
      requestedModel: producer.model,
      requestedEffort: producer.effort,
    };
    state.entries[job.jobId] = entry;
    persist();
    try {
      const response = await runtime.call("thread/start", {
        model: producer.model,
        allowProviderModelFallback: false,
        cwd: workingDirectory,
        runtimeWorkspaceRoots: [workingDirectory],
        permissions: ACCEPTANCE_PROFILE,
        approvalPolicy: "never",
        config: { ...ACCEPTANCE_THREAD_CONFIG, model_reasoning_effort: producer.effort },
        baseInstructions: job.instructions,
        developerInstructions: "",
        dynamicTools: [],
        ephemeral: false,
        experimentalRawEvents: true,
      });
      live();
      check(
        id(response.thread?.id) &&
          response.model === producer.model &&
          response.reasoningEffort === producer.effort &&
          response.cwd === workingDirectory &&
          response.approvalPolicy === "never" &&
          response.activePermissionProfile?.id === ACCEPTANCE_PROFILE &&
          Array.isArray(response.instructionSources) &&
          response.instructionSources.length === 0,
        "acceptance_thread_config_mismatch",
      );
      check(
        !Object.values(state.entries).some((e) => e !== entry && e.threadId === response.thread.id),
        "acceptance_duplicate_thread",
      );
      entry.threadId = response.thread.id;
      entry.effectiveModel = response.model;
      entry.effectiveEffort = response.reasoningEffort;
      entry.phase = "created";
      persist();
      return { threadId: entry.threadId };
    } catch (error) {
      fail(entry, "acceptance_thread_creation_uncertain");
      throw error;
    }
  }
  async function run(job, signal) {
    live();
    const entry = current(job.jobId);
    check(
      !state.admissionClosed && entry.phase === "created" && !entry.submissionAttempted && !waiter,
      "acceptance_submission_held",
    );
    check(
      entry.inputDigest === job.inputDigest &&
        entry.expiresAt === job.expiresAt &&
        job.expiresAt > Date.now(),
    );
    const budget = Math.min(producer.maxDurationMs, job.expiresAt - Date.now());
    check(budget > 0);
    const deadline = performance.now() + budget;
    let timer, abort;
    const terminal = new Promise((resolve, reject) => {
      waiter = { jobId: job.jobId, resolve, reject };
      timer = setTimeout(() => reject(new Error("acceptance_deadline")), budget);
      abort = () => reject(new Error("acceptance_cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
    });
    // Attach the rejection consumer before issuing native work.
    void terminal.catch(() => {});
    try {
      check(!signal?.aborted);
      entry.submissionAttempted = true;
      entry.phase = "submitted";
      entry.startedAt = Date.now();
      entry.userInputDigest = hash(canonical({ ...job.payload, inputDigest: job.inputDigest }));
      persist();
      const response = await runtime.call("turn/start", {
        threadId: entry.threadId,
        clientUserMessageId: job.jobId,
        model: producer.model,
        effort: producer.effort,
        approvalPolicy: "never",
        input: [
          {
            type: "text",
            text: canonical({ ...job.payload, inputDigest: job.inputDigest }),
            text_elements: [],
          },
        ],
        outputSchema: job.outputSchema,
      });
      live();
      check(performance.now() <= deadline && !signal?.aborted);
      check(
        id(response.turn?.id) && (!entry.turnId || entry.turnId === response.turn.id),
        "acceptance_turn_mismatch",
      );
      if (!entry.turnId) {
        entry.turnId = response.turn.id;
        persist();
      }
      await terminal;
      live();
      check(performance.now() <= deadline && !signal?.aborted);
      check(
        entry.phase === "terminal" && entry.completedAt - entry.startedAt <= producer.maxDurationMs,
      );
      // Seal a stopped evaluator before any result can reach the server. The
      // observer rejects extra inputs immediately; persisted history also covers
      // events queued between terminal notification and archive/unsubscribe.
      waiter = null;
      await archive(job.jobId);
      const history = await runtime.call("thread/read", {
        threadId: entry.threadId,
        includeTurns: true,
      });
      live();
      check(
        entry.phase === "archived" &&
          history.thread?.id === entry.threadId &&
          Array.isArray(history.thread.turns) &&
          history.thread.turns.length === 1 &&
          Buffer.byteLength(JSON.stringify(history)) <= 2 * 1024 * 1024,
        "acceptance_history_unproven",
      );
      const turn = history.thread.turns[0],
        items = turn.items;
      check(
        turn.id === entry.turnId &&
          turn.status === "completed" &&
          turn.itemsView === "full" &&
          !turn.truncated &&
          Array.isArray(items) &&
          items.length <= 512 &&
          items.every((item) =>
            ["userMessage", "agentMessage", "reasoning", "plan"].includes(item.type),
          ),
        "acceptance_history_unproven",
      );
      const turnPage = await runtime.call("thread/turns/list", {
        threadId: entry.threadId,
        limit: 2,
        sortDirection: "asc",
        itemsView: "full",
      });
      const itemPage = await runtime.call("thread/items/list", {
        threadId: entry.threadId,
        turnId: entry.turnId,
        limit: 100,
        sortDirection: "asc",
      });
      live();
      const truncated = (value) => {
        if (!value || typeof value !== "object") return false;
        return Object.entries(value).some(
          ([key, child]) =>
            (/truncat/i.test(key) && child !== false && child !== null && child !== undefined) ||
            truncated(child),
        );
      };
      check(
        entry.phase === "archived" &&
          !truncated(history) &&
          !truncated(turnPage) &&
          !truncated(itemPage) &&
          Buffer.byteLength(JSON.stringify(turnPage)) <= 2 * 1024 * 1024 &&
          Buffer.byteLength(JSON.stringify(itemPage)) <= 2 * 1024 * 1024 &&
          turnPage.nextCursor === null &&
          Array.isArray(turnPage.data) &&
          turnPage.data.length === 1 &&
          turnPage.data[0].id === entry.turnId &&
          turnPage.data[0].itemsView === "full" &&
          turnPage.data[0].status === "completed" &&
          canonical(turnPage.data[0].items) === canonical(items) &&
          itemPage.nextCursor === null &&
          Array.isArray(itemPage.data) &&
          itemPage.data.length <= 100 &&
          itemPage.data.every((value) => value.turnId === entry.turnId && id(value.item?.id)) &&
          new Set(itemPage.data.map((value) => value.item.id)).size === itemPage.data.length &&
          canonical(itemPage.data.map((value) => value.item)) === canonical(items),
        "acceptance_history_unproven",
      );
      const inputs = items.filter((item) => item.type === "userMessage"),
        outputs = items.filter(
          (item) =>
            item.type === "agentMessage" && (item.phase === "final_answer" || item.phase == null),
        );
      check(
        inputs.length === 1 && outputs.length === 1 && outputs[0].text === entry.output,
        "acceptance_history_unproven",
      );
      check(
        performance.now() <= deadline &&
          !signal?.aborted &&
          Buffer.byteLength(JSON.stringify([history, turnPage, itemPage])) <= 2 * 1024 * 1024,
        "acceptance_history_unproven",
      );
      verifyInput(entry, inputs[0]);
      entry.historyDigest = hash(canonical(turn));
      entry.sealed = true;
      persist();
      return {
        output: entry.output,
        receipt: {
          threadId: entry.threadId,
          turnId: entry.turnId,
          runtimeVersion: "0.165.0",
          requestedModel: entry.requestedModel,
          effectiveModel: entry.effectiveModel,
          requestedEffort: entry.requestedEffort,
          effectiveEffort: entry.effectiveEffort,
          inputDigest: entry.inputDigest,
          outputDigest: entry.outputDigest,
          configDigest: ACCEPTANCE_PERMISSIONS_DIGEST,
          startedAt: entry.startedAt,
          completedAt: entry.completedAt,
          terminal: true,
          controllerCreated: true,
          unexpectedTools: 0,
          unexpectedChildren: 0,
        },
      };
    } catch (error) {
      fail(
        entry,
        error.message?.startsWith("acceptance_") ? error.message : "acceptance_native_uncertain",
      );
      if (entry.turnId) {
        try {
          await runtime.interruptAcceptance({
            jobId: entry.jobId,
            threadId: entry.threadId,
            turnId: entry.turnId,
            serverInstanceId,
          });
        } catch {
          entry.interruptUncertain = true;
          persist();
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      waiter = null;
    }
  }
  async function archive(jobId) {
    live();
    const entry = current(jobId);
    check(["terminal", "archived"].includes(entry.phase) && !waiter, "acceptance_archive_held");
    if (entry.phase === "archived") return;
    const before = await runtime.call("thread/loaded/list", { limit: 64 });
    live();
    check(Array.isArray(before.data) && !before.nextCursor, "acceptance_archive_uncertain");
    if (before.data.includes(entry.threadId))
      await runtime.call("thread/archive", { threadId: entry.threadId });
    live();
    const loaded = await runtime.call("thread/loaded/list", { limit: 64 });
    live();
    check(
      entry.phase === "terminal" &&
        Array.isArray(loaded.data) &&
        !loaded.nextCursor &&
        !loaded.data.includes(entry.threadId),
      "acceptance_archive_uncertain",
    );
    entry.phase = "archived";
    persist();
  }
  function assertInterrupt(scope) {
    const entry = current(scope.jobId);
    check(
      scope.serverInstanceId === serverInstanceId &&
        entry.threadId === scope.threadId &&
        entry.turnId === scope.turnId &&
        entry.submissionAttempted === true &&
        ["submitted", "running", "held", "terminal"].includes(entry.phase),
      "acceptance_interrupt_denied",
    );
  }
  return {
    create,
    run,
    archive,
    assertInterrupt,
    closeAdmission() {
      state.admissionClosed = true;
      persist();
    },
    reopenAdmission() {
      live();
      check(
        !Object.values(state.entries).some((e) => e.phase !== "archived"),
        "acceptance_slot_held",
      );
      state.admissionClosed = false;
      persist();
    },
    active() {
      return Object.values(state.entries).some((e) => e.phase !== "archived");
    },
    close() {
      closed = true;
      waiter?.reject(new Error("acceptance_native_closed"));
      unsubscribe();
    },
  };
}
