// Trusted installed composition only. This closes model/CLI input, not kernel
// writers; the physical guardian/checkout hold remains after metadata application.
import { createHash, randomUUID } from "node:crypto";
import { runFixedSourceApplyWorker } from "./delivery-source-apply-client.mjs";

const check = (v, code = "source_application_held") => {
  if (!v) throw new Error(code);
};
const canonical = (v) =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
const same = (a, b) => canonical(a) === canonical(b);
const digest = (v) => createHash("sha256").update(canonical(v)).digest("hex");
const copy = structuredClone;
const authorityKeys = [
  "operationId",
  "sourceContext",
  "previousSourceContext",
  "parentSha",
  "treeSha",
  "manifestDigest",
  "metadataIdentity",
  "producer",
  "expiresAt",
];
const producerKeys = [
  "runtimeId",
  "runtimeGeneration",
  "admissionId",
  "admissionGeneration",
  "producerDigest",
  "checkoutIncarnation",
  "barrierGeneration",
];

export function createSourceApplication(options = {}) {
  if (options.enabled !== true)
    return {
      applyAcceptedSource: async () => {
        throw new Error("source_application_disabled");
      },
    };
  const {
    supervisor,
    controller,
    gateway,
    guardian,
    sourceState,
    managerAdapter,
    inspectManaged,
    runWorker = runFixedSourceApplyWorker,
  } = options;
  check(
    supervisor &&
      controller &&
      gateway &&
      guardian &&
      sourceState &&
      managerAdapter &&
      [
        guardian.currentMetadata,
        guardian.applyReserve,
        guardian.applyVerify,
        guardian.applyCommit,
        gateway.closeProjectInputs,
        gateway.projectInputInventory,
        gateway.releaseProjectInputs,
        sourceState.readForApply,
        managerAdapter.sourceApplicationSnapshot,
        inspectManaged,
        runWorker,
      ].every((v) => typeof v === "function"),
    "source_application_dependencies_unavailable",
  );
  const running = new Set();
  const sync = (entry) => {
    supervisor.save();
    controller.syncSourceApplication(copy(entry.sourceApplication));
  };
  const assertLocal = (scope) => {
    const entry = supervisor.state.projects[scope.projectId];
    supervisor.assertSourceApplicationRead(scope, "thread/read", {
      threadId: entry?.threadId,
      includeTurns: true,
    });
    const app = entry.sourceApplication;
    check(
      app.leaseExpiresAt > Date.now() / 1000 &&
        !entry.executionRevoked &&
        same(controller.sourceApplication(scope.projectId), app),
    );
    if (app.boundary) {
      const routing = supervisor.runtime.inspectManagerRouting();
      check(
        routing.receiveSequence === app.boundary.receiveSequence &&
          !routing.pendingObservers &&
          !routing.activeHandlers &&
          Array.isArray(routing.observerFailures) &&
          routing.observerFailures.length === 0,
        "source_application_late_input",
      );
    }
    const terminals = gateway.projectInputInventory(scope.projectId, scope),
      cli = supervisor.runtime.inspectCliInputs(scope.projectId);
    check(
      terminals.closed === true &&
        [
          terminals.activeTerminals,
          terminals.helpersPendingClose,
          terminals.pendingInputs,
          terminals.unknownInputs,
          cli.activeCli,
          cli.unknownInputs,
        ].every((v) => v === 0),
    );
    return { entry, app };
  };
  function verifyAuthority(value, app, facts, metadata) {
    check(
      value?.schemaVersion === 1 &&
        value.applicationId === app.applicationId &&
        ["pending", "applied"].includes(value.phase) &&
        value.applicationAuthorized === true &&
        value.executionAuthorized === false &&
        value.cleanupAuthorized === false &&
        value.expiresAt > Date.now() / 1000 &&
        value.expiresAt <= Date.now() / 1000 + 30 &&
        value.operationId === app.publicationOperationId &&
        same(value.sourceContext, app.targetSourceContext) &&
        same(value.previousSourceContext, app.expectedAppliedSourceContext) &&
        value.parentSha === facts.accepted.parentSha &&
        value.treeSha === facts.accepted.treeSha &&
        value.manifestDigest === facts.accepted.manifestDigest &&
        same(value.metadataIdentity, facts.metadata.pins) &&
        same(value.metadataIdentity, metadata.metadataPins) &&
        producerKeys.every(
          (k) => value.producer?.[k] === facts.admission[k] && value.producer[k] === metadata[k],
        ) &&
        value.producer.metadataPinsDigest === facts.metadata.pinsDigest &&
        value.producer.metadataPinsDigest === metadata.metadataPinsDigest &&
        value.producer.metadataPolicyDigest === facts.metadata.policyDigest &&
        value.producer.namespaceReceiptDigest === facts.metadata.namespaceReceiptDigest &&
        value.inputBarrier?.id === app.barrier.id &&
        value.inputBarrier.generation === app.barrier.generation &&
        /^[a-f0-9]{64}$/.test(value.inputBarrier.digest),
      "source_application_authority_changed",
    );
    if (app.reservation)
      check(
        same(app.reservation.inputBarrier, value.inputBarrier) &&
          same(app.reservation.producer, value.producer),
      );
    return Object.fromEntries(authorityKeys.map((k) => [k, copy(value[k])]));
  }
  return {
    async applyAcceptedSource(request, initialFacts) {
      const projectId = request?.checkoutBinding?.projectId;
      check(typeof projectId === "string" && !running.has(projectId), "source_application_busy");
      running.add(projectId);
      let entry, scope;
      const execution = new AbortController();
      let expired = false;
      const deadline = setTimeout(() => {
        expired = true;
        execution.abort();
      }, 120000);
      const bounded = async (work) => {
        check(!expired);
        let cancel;
        const stop = new Promise((_resolve, reject) => {
          cancel = () => reject(new Error("source_application_deadline"));
          execution.signal.addEventListener("abort", cancel, { once: true });
        });
        try {
          const result = await Promise.race([Promise.resolve().then(work), stop]);
          check(!expired);
          return result;
        } finally {
          execution.signal.removeEventListener("abort", cancel);
        }
      };
      try {
        const operationId = initialFacts?.accepted?.operationId;
        check(
          initialFacts?.isCurrent === true &&
            operationId &&
            same(initialFacts.scope.checkoutBinding, request.checkoutBinding),
        );
        const metadata = await bounded(() => guardian.currentMetadata(projectId));
        let facts = await bounded(() =>
          sourceState.readForApply(request.managerThreadId, {
            operationId,
            revisionId: initialFacts.accepted.sourceContext.revisionId,
          }),
        );
        check(
          same(facts.accepted, initialFacts.accepted) &&
            same(facts.scope.checkoutBinding, request.checkoutBinding),
        );
        entry = supervisor.state.projects[projectId];
        let app = entry?.sourceApplication;
        if (app?.publicationOperationId === operationId) {
          check(
            app.serverInstanceId === supervisor.state.serverInstanceId &&
              app.boundaryRequestDigest ===
                createHash("sha256").update(JSON.stringify(request)).digest("hex") &&
              same(app.targetSourceContext, facts.accepted.sourceContext),
            "source_application_recovery_conflict",
          );
          check(app.phase !== "released", "source_application_already_released");
          scope = supervisor.sourceApplicationScope(projectId);
        } else {
          const proposed = {
            projectId,
            applicationId: randomUUID(),
            publicationOperationId: operationId,
            targetSourceContext: copy(facts.accepted.sourceContext),
            expectedAppliedSourceContext: copy(entry?.acceptedSource ?? null),
            barrier: { id: randomUUID(), generation: (app?.barrier.generation ?? 0) + 1 },
          };
          scope = supervisor.beginSourceApplication(request, proposed);
          sync(entry);
        }
        let recoveredAuthority;
        if (entry.sourceApplication.reserveAttempted) {
          // A rejected/absent read does not prove that an ambiguous reservation
          // never committed. Never issue a second reservation from new digests.
          supervisor.assertSourceApplicationRead(scope, "thread/read", {
            threadId: request.managerThreadId,
            includeTurns: true,
          });
          check(same(controller.sourceApplication(projectId), entry.sourceApplication));
          recoveredAuthority = await bounded(() =>
            guardian.applyVerify({
              projectId,
              applicationId: entry.sourceApplication.applicationId,
            }),
          );
          verifyAuthority(recoveredAuthority, entry.sourceApplication, facts, metadata);
        }
        await bounded(() =>
          supervisor.closeSourceApplicationInputs(request, scope, (id, s) =>
            gateway.closeProjectInputs(id, s),
          ),
        );
        sync(entry);
        const observation = await bounded(() =>
          managerAdapter.sourceApplicationSnapshot(request.managerThreadId, copy(request)),
        );
        check(
          observation?.scope === "native_observer_journal_only" &&
            observation.writerHeld === true &&
            observation.quiescenceAuthority === false &&
            observation.metadataApplyAuthorized === false &&
            observation.pendingSourceEvents === 0 &&
            observation.unknownInputs === 0 &&
            observation.operationId === operationId &&
            same(observation.acceptedSourceContext, facts.accepted.sourceContext) &&
            same(observation.checkoutBinding, request.checkoutBinding) &&
            observation.registrationId === request.registrationId &&
            observation.serverInstanceId === request.serverInstanceId &&
            observation.parentTurnId === request.parentTurnId &&
            observation.cursorVersion === request.cursorVersion &&
            /^[a-f0-9]{64}$/.test(observation.sourceJournalDigest),
        );
        app = entry.sourceApplication;
        if (app.sourceObservation) {
          const factual = (v) =>
            Object.fromEntries(Object.entries(v).filter(([k]) => k !== "sourceJournalIdentity"));
          check(
            same(factual(app.sourceObservation), factual(observation)) &&
              app.barrier.sourceSpoolDigest === observation.sourceJournalDigest &&
              app.idleSnapshot?.admissionId === metadata.admissionId &&
              app.idleSnapshot.admissionGeneration === metadata.admissionGeneration,
            "source_application_observer_changed",
          );
        } else {
          app.sourceObservation = copy(observation);
          app.barrier.sourceSpoolDigest = observation.sourceJournalDigest;
          app.idleSnapshot = {
            projectId,
            admissionId: metadata.admissionId,
            admissionGeneration: metadata.admissionGeneration,
            managerBindingId: observation.managerBindingId,
            currentAttemptId: observation.attemptId,
            managerThreadId: request.managerThreadId,
            parentTurnId: request.parentTurnId,
            cursorVersion: observation.cursorVersion,
            nativeSequence: observation.nativeSequence,
            observedAt: app.boundary.observedAt,
            historyDigest: app.boundary.historyDigest,
            loadedInventoryDigest: app.boundary.loadedInventoryDigest,
            fullHistory: true,
            rootTurns: app.boundary.rootTurns,
            historyBytes: app.boundary.historyBytes,
            pendingHandlers: 0,
            pendingObservers: 0,
            unknownFacts: 0,
            activeRoots: 0,
          };
        }
        sync(entry);
        assertLocal(scope);
        if (!app.reserveAttempted) {
          app.reserveAttempted = true;
          sync(entry); // Persist attempted identity before the request can leave.
          await bounded(() =>
            guardian.applyReserve({
              projectId,
              applicationId: app.applicationId,
              publicationOperationId: operationId,
              targetSourceContext: copy(app.targetSourceContext),
              expectedAppliedSourceContext: copy(app.expectedAppliedSourceContext),
            }),
          );
        }
        const fresh = async () => {
          assertLocal(scope);
          const current = await bounded(() => guardian.currentMetadata(projectId));
          facts = await bounded(() =>
            sourceState.readForApply(request.managerThreadId, {
              operationId,
              revisionId: app.targetSourceContext.revisionId,
            }),
          );
          check(same(facts.scope.checkoutBinding, request.checkoutBinding));
          const value = await bounded(() =>
            guardian.applyVerify({ projectId, applicationId: app.applicationId }),
          );
          assertLocal(scope);
          const normalized = verifyAuthority(value, app, facts, current);
          check(same(current, metadata), "source_application_producer_changed");
          return { value, normalized };
        };
        const reserved = await fresh();
        if (recoveredAuthority)
          check(
            same(reserved.value.inputBarrier, recoveredAuthority.inputBarrier) &&
              same(reserved.value.producer, recoveredAuthority.producer),
            "source_application_authority_changed",
          );
        app.reservation = {
          inputBarrier: copy(reserved.value.inputBarrier),
          producer: copy(reserved.value.producer),
        };
        app.phase = "reserved";
        sync(entry);
        const workerRequest = {
          projectId,
          repositoryId: request.checkoutBinding.repositoryId,
          applicationId: app.applicationId,
          publicationOperationId: operationId,
        };
        const expected = (v) => {
          const p = request.checkoutBinding;
          check(
            v?.projectId === projectId &&
              v.repositoryId === p.repositoryId &&
              v.taskId === p.preparationIntentId &&
              v.leaseId === p.leaseId &&
              v.leaseGeneration === p.leaseGeneration &&
              v.revision === p.revision &&
              v.checkoutIncarnation === metadata.checkoutIncarnation &&
              same(v.checkoutIdentity, metadata.metadataPins.checkout) &&
              same(v.currentSource, app.expectedAppliedSourceContext),
            "source_application_physical_changed",
          );
        };
        const result = await runWorker(
          workerRequest,
          async (type, value) => {
            check(!expired && same(value?.request, workerRequest));
            expected(value.expected);
            assertLocal(scope);
            if (type === "authority") {
              check(value.operationId === operationId);
              const current = await fresh();
              return { authority: current.normalized, sourceState: copy(facts) };
            }
            if (type === "input_barrier") {
              check(
                value.operationId === operationId &&
                  (value.producer === null || same(value.producer, app.reservation.producer)),
              );
              const routing = supervisor.runtime.inspectManagerRouting();
              check(
                routing.receiveSequence === app.boundary.receiveSequence &&
                  !routing.pendingObservers &&
                  !routing.activeHandlers &&
                  Array.isArray(routing.observerFailures) &&
                  routing.observerFailures.length === 0,
              );
              return { closed: true, applicationId: app.applicationId };
            }
            check(type === "applied" && same(value.sourceContext, app.targetSourceContext));
            const managed = await bounded(() =>
              inspectManaged(request.checkoutBinding.repositoryId),
            );
            check(
              managed?.status === "ready" &&
                managed.checkoutVerified === true &&
                !managed.sourceUpdating &&
                same(managed.acceptedSource, app.targetSourceContext) &&
                managed.revision === request.checkoutBinding.revision &&
                managed.checkoutIncarnation === metadata.checkoutIncarnation &&
                same(managed.checkoutIdentity, metadata.metadataPins.checkout) &&
                managed.lease?.id === request.checkoutBinding.leaseId &&
                managed.lease.taskId === request.checkoutBinding.preparationIntentId &&
                managed.lease.generation === request.checkoutBinding.leaseGeneration &&
                managed.lease.expiresAt > Date.now() / 1000,
            );
            entry.acceptedSource = copy(app.targetSourceContext);
            app.phase = "applied";
            sync(entry);
            const beforeCommit = await fresh();
            if (beforeCommit.value.phase !== "applied")
              await bounded(() =>
                guardian.applyCommit({ projectId, applicationId: app.applicationId }),
              );
            const committed = await fresh();
            check(committed.value.phase === "applied");
            app.phase = "committed";
            app.serverCommitDigest = digest(committed.value);
            sync(entry);
            await bounded(() =>
              gateway.releaseProjectInputs(projectId, scope, async () => {
                const latest = await fresh();
                check(latest.value.phase === "applied");
              }),
            );
            check(!expired);
            app.phase = "released";
            sync(entry);
            return {
              committed: true,
              applicationId: app.applicationId,
              sourceContext: copy(app.targetSourceContext),
            };
          },
          { timeoutMs: Math.max(1, 120000), signal: execution.signal },
        );
        check(
          !expired &&
            result?.applicationId === app.applicationId &&
            result.publicationOperationId === operationId &&
            same(result.acceptedSource, app.targetSourceContext),
        );
        return copy(result);
      } catch (error) {
        if (entry?.sourceApplication && scope) {
          entry.sourceApplication.phase = "held";
          try {
            sync(entry);
          } catch {}
        }
        throw error;
      } finally {
        clearTimeout(deadline);
        execution.abort();
        running.delete(projectId);
      }
    },
  };
}
