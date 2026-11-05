import { requireValue } from "./contracts.mjs";
/** Trusted job/controller entry, not a model command. It advances only the
 * dependency already established by the durable ledger. Activation remains an
 * independent D09 effect; this job never executes destructive contraction. */
export async function advanceDatabaseChange({
  controller,
  runId,
  signal,
  maxTicks = 16,
  maxDurationMs = 10000,
}) {
  requireValue(
    Number.isInteger(maxTicks) &&
      maxTicks >= 1 &&
      maxTicks <= 64 &&
      Number.isInteger(maxDurationMs) &&
      maxDurationMs >= 100 &&
      maxDurationMs <= 60000,
    "migration_job_budget_invalid",
  );
  const deadline = AbortSignal.timeout(maxDurationMs),
    lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let state = await controller.begin(runId, { signal: lifetime });
  for (let ticks = 0; ticks < maxTicks; ticks++) {
    requireValue(!lifetime.aborted, "migration_interrupted");
    if (state.phase === "verified")
      return {
        phase: "activation_ready",
        state,
        certificate: await controller.certificate(runId, { signal: lifetime }),
        automaticContract: false,
      };
    if (["activated", "contract_held"].includes(state.phase))
      return { phase: state.phase, state, automaticContract: false };
    const action = {
      pending: "expand",
      expanded: "compatible",
      compatible: "backfill",
      backfilled: "integrity",
    }[state.phase];
    requireValue(action, "migration_dependency_pending");
    state = await controller.tick(runId, action, { signal: lifetime });
  }
  return { phase: "checkpointed", state, automaticContract: false };
}
