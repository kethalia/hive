// Installed opt-in composition. Fixed helpers own provider and metadata effects;
// model arguments never choose keys, paths, producer identity or authority.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInstalledAcceptanceRuntime } from "./codex-acceptance-runtime.mjs";
import { createSourceApplication } from "./codex-source-application.mjs";
import { createDeliveryGitHubCollector } from "./delivery-github-collector.mjs";
import { createDeliveryManagerAdapter } from "./delivery-manager-adapter.mjs";
import { createDeliverySourcePublisher } from "./delivery-source-publisher.mjs";
import { createDeliverySourceStateClient } from "./delivery-source-state-client.mjs";
import { createDeliveryStatusClient } from "./delivery-status-client.mjs";

const check = (value) => {
  if (!value) throw new Error("delivery_runtime_unavailable");
};
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
const same = (a, b) => canonical(a) === canonical(b);
function directory(home, name) {
  const path = join(home, ".local/state/hive", name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  check(
    realpathSync(path) === path &&
      s.isDirectory() &&
      s.uid === process.getuid() &&
      !(s.mode & 0o077),
  );
  return path;
}

export async function createInstalledDeliveryRuntime({
  config,
  home,
  supervisor,
  controller,
  registration,
  guardian,
  gateway,
  inspectManaged,
  fetchImpl = fetch,
}) {
  check(
    config.deliveryExecutionEnabled === true &&
      config.managerEnabled === true &&
      config.guardianEnabled === true &&
      config.nativeIsolationEnabled === true,
  );
  check(
    guardian &&
      supervisor.config.metadataReadOnly === true &&
      supervisor.config.executionMode === "isolated" &&
      supervisor.config.projects.length === 1,
  );
  const project = supervisor.config.projects[0];
  check(project && typeof inspectManaged === "function");
  const serverInstanceId = supervisor.state.serverInstanceId;
  const key = supervisor.state.controllerPrivateKeyPem;
  const pendingCollections = new Map();
  let adapter,
    application,
    closed = false,
    closing,
    collection = null,
    timer = null;
  let collectionStatus = { phase: "idle", reason: null };
  const network = new AbortController();
  let unsubscribeNative, unsubscribeRegistration;
  check(typeof supervisor.onRevoked === "function" && typeof registration.onRevoked === "function");
  const active = () => {
    check(
      !closed &&
        !supervisor.closed &&
        supervisor.state.status === "ready" &&
        supervisor.runtime.alive() &&
        supervisor.state.serverInstanceId === serverInstanceId &&
        !supervisor.state.projects[project.projectId]?.executionRevoked,
    );
    controller.assertRuntimeExecution();
  };
  const currentRegistration = () => {
    active();
    return registration.currentRegistration();
  };
  const currentProjectContext = (thread) => {
    active();
    return controller.currentProjectContext(thread);
  };
  const context = (thread) => {
    active();
    const claim = adapter.currentSourceContext(thread),
      physical = currentProjectContext(thread);
    check(
      claim.managerThreadId === thread &&
        same(claim.checkoutBinding, physical) &&
        physical.projectId === project.projectId,
    );
    return {
      ownerId: config.binding.hiveUserId,
      managerBindingId: claim.managerBindingId,
      registration: claim.registration,
      checkoutBinding: physical,
      taskId: claim.taskId,
      stepId: claim.stepId,
      attemptId: claim.attemptId,
      attemptLeaseGeneration: claim.attemptLeaseGeneration,
      checkoutPath: supervisor.checkout(project),
      ...(claim.sourceContext ? { sourceContext: claim.sourceContext } : {}),
    };
  };
  const request = async (url, options = {}) => {
    active();
    const signal = AbortSignal.any([network.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new Error("delivery_runtime_revoked"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => fetchImpl(url, { ...options, signal }))
          .then((response) => {
            if (signal.aborted) {
              void response.body?.cancel().catch(() => {});
              throw new Error("delivery_runtime_revoked");
            }
            active();
            return response;
          }),
        aborted,
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const authorizeMetadata = async (c) => {
    active();
    check(c.checkoutBinding.projectId === project.projectId);
    const result = await applicationGuardian.currentMetadata(project.projectId);
    active();
    return result;
  };
  // Guardian FD3 replies are not fetches. Fence them independently so a reply
  // that outlives local registration/native authority cannot authorize metadata.
  const applicationGuardian = Object.fromEntries(
    ["currentMetadata", "applyReserve", "applyVerify", "applyCommit"].map((method) => [
      method,
      async (...args) => {
        active();
        let abort;
        const stopped = new Promise((_, reject) => {
          abort = () => reject(new Error("delivery_runtime_revoked"));
          network.signal.addEventListener("abort", abort, { once: true });
        });
        try {
          return await Promise.race([
            Promise.resolve().then(async () => {
              active();
              const result = await guardian[method](...args);
              active();
              return result;
            }),
            stopped,
          ]);
        } finally {
          network.signal.removeEventListener("abort", abort);
        }
      },
    ]),
  );
  let publisher, sourceState, statusClient, acceptance;
  try {
    publisher = createDeliverySourcePublisher({
      enabled: true,
      hiveOrigin: config.hiveOrigin,
      hostPrivateKeyPem: key,
      stateDirectory: directory(home, "delivery-source-publisher"),
      currentContext: context,
      authorizeMetadata,
      fetchImpl: request,
    });
    sourceState = createDeliverySourceStateClient({
      enabled: true,
      hiveOrigin: config.hiveOrigin,
      hostPrivateKeyPem: key,
      currentContext: context,
      authorizeMetadata,
      fetchImpl: request,
    });
    statusClient = createDeliveryStatusClient({
      enabled: true,
      hiveOrigin: config.hiveOrigin,
      hostPrivateKeyPem: key,
      currentContext: (thread) => ({
        ...context(thread),
        inputSourceSha: adapter.currentSourceContext(thread).inputSourceSha,
      }),
      authorizeMetadata,
      fetchImpl: request,
    });
    if (config.acceptance) {
      acceptance = createInstalledAcceptanceRuntime({
        config,
        home,
        supervisor,
        controller,
        registration,
        guardian: applicationGuardian,
        active,
        fetchImpl: request,
        signal: network.signal,
      });
      supervisor.setAcceptanceRuntime(acceptance);
    }
    const collector = createDeliveryGitHubCollector({
      enabled: true,
      sourceProtocol: 1,
      hiveOrigin: config.hiveOrigin,
      hostPrivateKeyPem: key,
      stateDirectory: directory(home, "delivery-github-collector"),
      currentRegistration,
      currentProjectContext,
      currentAcceptedSource: (value) => adapter.currentAcceptedSource(value),
      fetchImpl: request,
    });
    function stopCollection(reason) {
      clearTimeout(timer);
      timer = null;
      pendingCollections.clear();
      collectionStatus = { phase: "pending", reason };
    }
    // This schedules a read-only collector, never execution or step completion.
    const collectionPrerequisites = (status) =>
      status.attempt.outcome === "running" &&
      status.step.state === "running" &&
      status.attempt.leaseExpiresAt > Date.now() &&
      !status.task.pauseRequested &&
      !status.task.schedulingPaused &&
      status.source.operationId &&
      status.source.pullNumber &&
      status.evidence.policyVersion &&
      !status.blockers.some(
        (b) =>
          ![
            "evidence_missing",
            "evidence_invalid",
            "evidence_provenance_unavailable",
            "source_application_pending",
            "acceptance_evaluator_unavailable",
            "acceptance_evaluator_provenance_pending",
          ].includes(b),
      );
    let lastRefreshAt = 0;
    async function refresh() {
      if (closed || collection || !pendingCollections.size) return;
      const remaining = 60000 - (Date.now() - lastRefreshAt);
      if (remaining > 0) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void refresh();
        }, remaining);
        timer.unref();
        return;
      }
      const candidate = [...pendingCollections.values()][0];
      collection = (async () => {
        try {
          active();
          const c = context(candidate.managerThreadId);
          check(
            c.taskId === candidate.taskId &&
              c.stepId === candidate.stepId &&
              c.attemptId === candidate.attemptId &&
              c.registration.id === candidate.registrationId,
          );
          const accepted = await adapter.currentAcceptedSource({
            managerThreadId: candidate.managerThreadId,
            taskId: c.taskId,
            stepId: c.stepId,
            checkoutBinding: c.checkoutBinding,
          });
          check(same(accepted, candidate.sourceContext));
          // Each refresh needs fresh server confirmation, including timer work.
          // Local publication/collector caches cannot override pause or scope loss.
          const status = await statusClient.read(candidate.managerThreadId);
          check(collectionPrerequisites(status) && same(status.source.sourceContext, accepted));
          lastRefreshAt = Date.now();
          collectionStatus = { phase: "refreshing", reason: null };
          // The collector's signed challenge independently resolves the current PR;
          // neither this timer nor a model supplies provider identity or PR number.
          const result = await collector.refresh({
            managerThreadId: candidate.managerThreadId,
            taskId: c.taskId,
            stepId: c.stepId,
          });
          active();
          const latest = context(candidate.managerThreadId);
          check(latest.attemptId === c.attemptId && latest.registration.id === c.registration.id);
          collectionStatus = { phase: "observed", reason: null, result: structuredClone(result) };
          timer = setTimeout(() => {
            timer = null;
            void refresh();
          }, 60000);
          timer.unref();
        } catch {
          // Missing PR, pause, scope changes, revoked producer or uncertain network
          // are prerequisites, never evidence. Stop automatic retries on failure.
          if (pendingCollections.get(candidate.managerThreadId) === candidate)
            pendingCollections.delete(candidate.managerThreadId);
          collectionStatus = {
            phase: "pending",
            reason: "evidence_refresh_prerequisite_unavailable",
          };
        }
      })().finally(() => {
        collection = null;
        // An older in-flight refresh cannot delete a newer accepted claim.
        if (
          !closed &&
          pendingCollections.size &&
          pendingCollections.get(candidate.managerThreadId) !== candidate
        ) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void refresh();
          }, 0);
          timer.unref();
        }
      });
      await collection;
    }
    adapter = createDeliveryManagerAdapter({
      enabled: true,
      nativeEnabled: true,
      progressionProtocol: 1,
      sourceProtocol: 1,
      hiveOrigin: config.hiveOrigin,
      stateDirectory: directory(home, "delivery-manager"),
      hostPrivateKeyPem: key,
      currentRegistration,
      currentProjectContext,
      currentServerInstanceId: () => supervisor.state.serverInstanceId,
      registerChild: (root, child, call) => supervisor.registerChild(root, child, call),
      readNativeHistory: (value) => supervisor.readNativeHistory(value),
      drainNativeRouting: (value) => supervisor.runtime.drainManagerRouting(value),
      continueRoot: (value) => supervisor.continueDeliveryRoot(value),
      revalidateBoundary: (value, next, call) =>
        supervisor.revalidateDeliveryBoundary(value, next, call),
      currentSource: (thread) => controller.currentSource(thread),
      ...(acceptance ? { readAcceptancePlan: (thread) => acceptance.readPlan(thread) } : {}),
      readStatus: async (claim) => {
        active();
        const status = await statusClient.read(claim.managerThreadId);
        active();
        check(context(claim.managerThreadId).attemptId === claim.attemptId);
        if (acceptance && status.source.operationId && status.source.sourceContext)
          acceptance.scheduleReview(
            claim.managerThreadId,
            {
              operationId: status.source.operationId,
              revisionId: status.source.sourceContext.revisionId,
            },
            sourceState,
          );
        if (collectionPrerequisites(status)) {
          pendingCollections.set(claim.managerThreadId, {
            managerThreadId: claim.managerThreadId,
            taskId: claim.taskId,
            stepId: claim.stepId,
            attemptId: claim.attemptId,
            registrationId: claim.registration.id,
            sourceContext: status.source.sourceContext,
          });
        } else stopCollection("evidence_refresh_prerequisite_unavailable");
        return status;
      },
      publishSource: async (claim, proposed) => {
        active();
        const c = context(claim.managerThreadId);
        check(
          c.attemptId === claim.attemptId &&
            c.managerBindingId === claim.managerBindingId &&
            same(c.checkoutBinding, claim.checkoutBinding),
        );
        const result = await publisher.publish(claim.managerThreadId, proposed);
        active();
        check(context(claim.managerThreadId).attemptId === c.attemptId);
        acceptance?.scheduleReview(
          claim.managerThreadId,
          { operationId: proposed.operationId, revisionId: result.sourceContext.revisionId },
          sourceState,
        );
        pendingCollections.set(claim.managerThreadId, {
          managerThreadId: claim.managerThreadId,
          taskId: c.taskId,
          stepId: c.stepId,
          attemptId: c.attemptId,
          registrationId: c.registration.id,
          sourceContext: result.sourceContext,
        });
        return result;
      },
      readAcceptedSource: (claim, query) => sourceState.readForApply(claim.managerThreadId, query),
      ...(acceptance
        ? {
            assessAcceptance: async (value, facts) => {
              active();
              await supervisor.readDeliveryBoundary(value);
              active();
              const decision = await acceptance.repairDecision(
                value.managerThreadId,
                {
                  operationId: facts.accepted.operationId,
                  revisionId: facts.accepted.sourceContext.revisionId,
                },
                sourceState,
              );
              active();
              if (decision.phase !== "passed") return decision;
              // The evaluator has archived its independent thread. Re-read the
              // exact root/cohort boundary now, then seal the native journal.
              const history = await supervisor.readDeliveryBoundary(value);
              active();
              const observed = adapter.acceptanceTerminalSnapshot(value.managerThreadId, value);
              const terminal = {
                schemaVersion: 1,
                managerBindingId: observed.managerBindingId,
                taskId: observed.taskId,
                stepId: observed.stepId,
                attemptId: observed.attemptId,
                managerThreadId: value.managerThreadId,
                parentTurnId: observed.parentTurnId,
                cursorVersion: observed.cursorVersion,
                nativeSequence: observed.nativeSequence,
                sourceContext: observed.acceptedSourceContext,
                observedAt: history.observedAt,
                historyDigest: history.historyDigest,
                loadedInventoryDigest: history.loadedInventoryDigest,
                sourceJournalDigest: observed.sourceJournalDigest,
                rootCompleted: true,
                pendingHandlers: 0,
                pendingObservers: 0,
                unknownInputs: 0,
                cohort: value.cohort.map(
                  ({
                    parentTurnId,
                    spawnCallId,
                    childThreadId,
                    childTurnId,
                    effectiveModel,
                    effectiveEffort,
                  }) => ({
                    parentTurnId,
                    spawnCallId,
                    childThreadId,
                    childTurnId,
                    effectiveModel,
                    effectiveEffort,
                  }),
                ),
              };
              const completed = await acceptance.completeVerified(value.managerThreadId, terminal);
              active();
              const after = adapter.acceptanceTerminalSnapshot(value.managerThreadId, value);
              check(after.sourceJournalDigest === observed.sourceJournalDigest);
              return completed;
            },
            readyRepair: async (value, decision) => {
              active();
              const result = await acceptance.repairReady(
                value.managerThreadId,
                decision.reservation.repairId,
              );
              active();
              return result;
            },
          }
        : {}),
      applyAcceptedSource: async (value, facts) => {
        await acceptance?.closeAdmission();
        const result = await application.applyAcceptedSource(value, facts);
        active();
        // The evaluator stays closed until a fresh claimed manager turn. A
        // repair decision is not success evidence or new execution authority.
        return result;
      },
      onObserverHold: ({ managerThreadId, reason }) => {
        stopCollection("native_observer_held");
        if (supervisor.state.projects[project.projectId]?.threadId === managerThreadId)
          void supervisor.revokeExecution(project.projectId, reason).catch(() => {});
      },
      fetchImpl: request,
    });
    application = createSourceApplication({
      enabled: true,
      supervisor,
      controller,
      gateway,
      guardian: applicationGuardian,
      signal: network.signal,
      sourceState,
      managerAdapter: adapter,
      inspectManaged,
    });
    const handle = adapter.handleToolCall.bind(adapter),
      closeAdapter = adapter.close.bind(adapter);
    adapter.handleToolCall = async (value) => {
      const result = await handle(value);
      // Only a successful trusted publisher callback can populate the candidate.
      // Run after the adapter has durably recorded its accepted publication.
      if (pendingCollections.has(value.threadId) && !timer && !collection) {
        timer = setTimeout(() => {
          timer = null;
          void refresh();
        }, 0);
        timer.unref();
      }
      return result;
    };
    adapter.close = () => {
      if (closing) return closing;
      closed = true;
      network.abort();
      const acceptanceClosing = acceptance?.close();
      unsubscribeNative?.();
      unsubscribeRegistration?.();
      clearTimeout(timer);
      timer = null;
      pendingCollections.clear();
      closing = (async () => {
        let limit;
        try {
          const outcomes = await Promise.race([
            Promise.allSettled([
              collection,
              acceptanceClosing,
              sourceState.close(),
              statusClient.close(),
              publisher.close(),
              closeAdapter(),
            ]),
            new Promise((_, reject) => {
              limit = setTimeout(() => reject(new Error("delivery_runtime_close_uncertain")), 8000);
            }),
          ]);
          check(outcomes.every((outcome) => outcome.status === "fulfilled"));
        } finally {
          clearTimeout(limit);
        }
      })();
      return closing;
    };
    const revoked = () => {
      void adapter.close().catch(() => {});
    };
    unsubscribeNative = supervisor.onRevoked(revoked);
    unsubscribeRegistration = registration.onRevoked(revoked);
    active();
    return {
      adapter,
      close: adapter.close,
      // Collection diagnostics are not evidence or completion eligibility.
      evidenceStatus() {
        active();
        return structuredClone(collectionStatus);
      },
    };
  } catch (error) {
    closed = true;
    network.abort();
    const acceptanceClosing = acceptance?.close();
    unsubscribeNative?.();
    unsubscribeRegistration?.();
    clearTimeout(timer);
    await Promise.allSettled([
      acceptanceClosing,
      publisher?.close(),
      sourceState?.close(),
      statusClient?.close(),
      adapter?.close(),
    ]);
    throw error;
  }
}
