// Controller-only automatic processing. Persist before every inference boundary;
// recovery may resend a result, but never a turn/start with an unknown outcome.
const check = (v, reason = "acceptance_pump_held") => {
  if (!v) throw new Error(reason);
};
export function createAcceptancePump({ client, evaluator, state, save, assertAuthority, signal }) {
  check(
    client &&
      evaluator &&
      state &&
      typeof save === "function" &&
      typeof assertAuthority === "function",
  );
  let inFlight = null,
    closed = false,
    timer = null;
  const active = () => {
    check(!closed && !signal?.aborted, "acceptance_pump_closed");
    assertAuthority();
  };
  const persist = () => save();
  async function processJob() {
    active();
    if (state.admissionClosed) return { phase: "closed" };
    let operation = state.operation;
    if (!operation) {
      const claim = await client.request("claim_acceptance", {});
      active();
      if (claim.phase === "idle") return claim;
      // Unknown started work is never adopted from a server reply alone.
      check(claim.phase === "leased", "acceptance_reconciliation_required");
      operation = state.operation = { phase: "leased", job: claim };
      persist();
    }
    const job = operation.job;
    const scope = { jobId: job.jobId, leaseId: job.leaseId, leaseGeneration: job.leaseGeneration };
    if (operation.phase === "leased") {
      operation.phase = "creating";
      persist();
      const thread = await evaluator.create(job);
      active();
      operation.threadId = thread.threadId;
      operation.phase = "created";
      persist();
    }
    if (["created", "start_requested"].includes(operation.phase)) {
      operation.phase = "start_requested";
      persist();
      const started = await client.request("start_acceptance", {
        ...scope,
        threadId: operation.threadId,
      });
      active();
      check(
        started.phase === "started" &&
          started.jobId === job.jobId &&
          started.threadId === operation.threadId,
      );
      operation.phase = "started";
      persist();
    }
    if (operation.phase === "started") {
      // Set before native call. Crash here retains a hold, even if no turn was sent.
      operation.phase = "submission_attempted";
      persist();
      const result = await evaluator.run(job, signal);
      active();
      operation.result = result;
      operation.phase = "terminal";
      persist();
    }
    if (["terminal", "finish_requested"].includes(operation.phase)) {
      operation.phase = "finish_requested";
      persist();
      const result = await client.request("finish_acceptance", { ...scope, ...operation.result });
      active();
      check(["completed", "held"].includes(result.phase) && result.jobId === job.jobId);
      operation.ack = result;
      operation.phase = "accepted";
      persist();
    }
    if (["accepted", "archive_requested"].includes(operation.phase)) {
      operation.phase = "archive_requested";
      persist();
      await evaluator.archive(job.jobId);
      active();
      operation.phase = "archived";
      persist();
    }
    check(operation.phase === "archived", "acceptance_reconciliation_required");
    state.last = { jobId: job.jobId, resultDigest: operation.ack.resultDigest };
    state.operation = null;
    persist();
    return { phase: operation.ack.phase, ...state.last };
  }
  function tick() {
    if (inFlight) return inFlight;
    const pending = processJob();
    inFlight = pending;
    void pending
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      })
      .catch(() => {});
    return pending;
  }
  function start() {
    active();
    if (timer) return;
    const schedule = () => {
      if (closed || signal?.aborted) return;
      timer = setTimeout(() => {
        timer = null;
        void tick()
          .catch(() => {})
          .finally(schedule);
      }, 30000);
      timer.unref();
    };
    schedule();
  }
  async function closeAdmission() {
    // Durable close prevents the next claim, while already-started work is
    // allowed to finish and archive. It is not a kernel/writer drain.
    state.admissionClosed = true;
    persist();
    if (inFlight) await inFlight;
    active();
    check(!state.operation && !evaluator.active(), "acceptance_slot_held");
    evaluator.closeAdmission();
    return { closed: true, evaluatorThreads: 0, quiescenceAuthorized: false };
  }
  return {
    tick,
    start,
    closeAdmission,
    reopenAdmission() {
      active();
      check(!inFlight && !state.operation);
      evaluator.reopenAdmission();
      state.admissionClosed = false;
      persist();
      start();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      evaluator.close();
      return inFlight?.catch(() => {});
    },
  };
}
