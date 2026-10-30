import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createNativeAcceptanceEvaluator,
  validateAcceptanceProducer,
} from "./codex-acceptance-native.mjs";
import { createAcceptancePump } from "./codex-acceptance-pump.mjs";
import { createAcceptanceClient } from "./delivery-acceptance-client.mjs";
import { readAcceptanceMaterial } from "./delivery-acceptance-material.mjs";

const check = (v) => {
  if (!v) throw Error("acceptance_runtime_unavailable");
};
export function createInstalledAcceptanceRuntime({
  config,
  home,
  supervisor,
  controller,
  registration,
  guardian,
  active,
  fetchImpl,
  signal,
}) {
  check(
    config.acceptance &&
      config.deliveryExecutionEnabled &&
      config.guardianEnabled &&
      config.nativeIsolationEnabled &&
      config.managerEnabled,
  );
  const producer = validateAcceptanceProducer(config.acceptance);
  const actual = createHash("sha256")
    .update(readFileSync(new URL("./codex-acceptance-native.mjs", import.meta.url)))
    .digest("hex");
  check(actual === producer.codeDigest);
  const project = supervisor.config.projects[0];
  check(supervisor.config.projects.length === 1);
  const cwd = join(
    home,
    "projects/.hive-managed",
    `.acceptance-${supervisor.state.serverInstanceId}`,
  );
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const st = lstatSync(cwd);
  check(
    st.isDirectory() &&
      st.uid === process.getuid() &&
      !(st.mode & 0o077) &&
      realpathSync(cwd) === cwd,
  );
  const currentContext = () => {
    active();
    const r = registration.currentRegistration(),
      entry = supervisor.state.projects[project.projectId];
    check(
      r &&
        r.expiresAt > Date.now() &&
        entry?.threadId &&
        r.serverInstanceId === supervisor.state.serverInstanceId &&
        r.threads.some((t) => t.projectId === project.projectId && t.threadId === entry.threadId),
    );
    return {
      ownerId: config.binding.hiveUserId,
      managerThreadId: entry.threadId,
      registration: { id: r.id, serverInstanceId: r.serverInstanceId, expiresAt: r.expiresAt },
      checkoutBinding: controller.currentProjectContext(entry.threadId),
    };
  };
  const client = createAcceptanceClient({
    hiveOrigin: config.hiveOrigin,
    hostPrivateKeyPem: supervisor.state.controllerPrivateKeyPem,
    currentContext,
    authorizeMetadata: () => guardian.currentMetadata(project.projectId),
    fetchImpl,
    signal,
  });
  supervisor.state.acceptance ??= {
    schemaVersion: 1,
    serverInstanceId: supervisor.state.serverInstanceId,
    native: {},
    pump: {},
  };
  const state = supervisor.state.acceptance;
  check(state.schemaVersion === 1 && state.serverInstanceId === supervisor.state.serverInstanceId);
  const save = () => {
    check(Buffer.byteLength(JSON.stringify(supervisor.state)) <= 1024 * 1024);
    supervisor.save();
  };
  const evaluator = createNativeAcceptanceEvaluator({
    runtime: supervisor.runtime,
    producer,
    workingDirectory: cwd,
    state: state.native,
    save,
    assertAuthority: () => {
      active();
      currentContext();
    },
    serverInstanceId: supervisor.state.serverInstanceId,
  });
  supervisor.runtime.setAcceptanceInterruptAuthority((scope) => evaluator.assertInterrupt(scope));
  const pump = createAcceptancePump({
    client,
    evaluator,
    state: state.pump,
    save,
    assertAuthority: () => {
      active();
      currentContext();
    },
    signal,
  });
  let reviewPending = null,
    lastReviewAt = 0;
  save();
  pump.start();
  return {
    ...pump,
    scheduleReview(thread, query, sourceState) {
      active();
      if (reviewPending || Date.now() - lastReviewAt < 60000) return;
      lastReviewAt = Date.now();
      reviewPending = new Promise((resolve) => setTimeout(resolve, 0))
        .then(async () => {
          active();
          const facts = await sourceState.readForApply(thread, query);
          active();
          const candidate = await readAcceptanceMaterial(facts, { signal });
          active();
          const prepared = await client.request("prepare_review", { candidate });
          if (prepared.phase === "queued") await pump.tick();
        })
        .catch(() => {})
        .finally(() => {
          reviewPending = null;
        });
    },
    async close() {
      await Promise.allSettled([pump.close(), reviewPending]);
    },
    async repairDecision(thread, query, sourceState) {
      active();
      check(currentContext().managerThreadId === thread);
      if (reviewPending) await reviewPending;
      pump.reopenAdmission();
      const facts = await sourceState.readForApply(thread, query);
      active();
      const candidate = await readAcceptanceMaterial(facts, { signal });
      active();
      const prepared = await client.request("prepare_review", { candidate });
      if (prepared.phase !== "completed") await pump.tick();
      await pump.closeAdmission();
      active();
      return client.request("repair_prepare", {});
    },
    async completeVerified(thread, terminal) {
      active();
      check(currentContext().managerThreadId === thread);
      return client.request("complete_verified", { terminal });
    },
    async repairReady(thread, repairId) {
      active();
      check(currentContext().managerThreadId === thread);
      return client.request("repair_ready", { repairId });
    },
    async reviewCurrent(thread, query, sourceState) {
      active();
      if (reviewPending) await reviewPending;
      const before = currentContext();
      check(before.managerThreadId === thread);
      const facts = await sourceState.readForApply(thread, query);
      active();
      const candidate = await readAcceptanceMaterial(facts, { signal });
      active();
      const prepared = await client.request("prepare_review", { candidate });
      if (prepared.phase !== "completed") await pump.tick();
      const result = await client.request("read_acceptance", { jobId: prepared.jobId });
      check(result.phase === "completed" && result.result?.outcome === "pass");
      await pump.closeAdmission();
      active();
      pump.reopenAdmission();
      return { jobId: prepared.jobId, resultDigest: result.resultDigest };
    },
    async beforeFirstPrompt(thread) {
      const before = currentContext();
      check(before.managerThreadId === thread);
      let result = await client.request("read_acceptance_plan", {});
      if (result.phase !== "completed") {
        await pump.tick();
        result = await client.request("read_acceptance_plan", {});
      }
      check(
        result.phase === "completed" &&
          result.plan?.outcome === "ready" &&
          typeof result.planDigest === "string",
      );
      await pump.closeAdmission();
      active();
      pump.reopenAdmission();
      return { planDigest: result.planDigest, plan: result.plan };
    },
    async readPlan(thread) {
      const before = currentContext();
      check(before.managerThreadId === thread);
      return client.request("read_acceptance_plan", {});
    },
  };
}
