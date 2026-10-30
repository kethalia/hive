import type { PrismaClient } from "@hive/db";
import { requireAppliedSourceForAction } from "@/lib/codex-session/guardian-application-gate.server";
import { sourceContextSchema } from "./contracts";
import { canonicalGitHubSource } from "./github-evidence.server";
import type { ManagerDependencies } from "./manager.server";
import { authenticateCheckoutHost, lockManagerCheckout } from "./manager-binding.server";
import {
  NATIVE_OBSERVER_PRODUCER,
  nativeEnvelopeSchema,
  nativeProofPayload,
} from "./native-contracts";
import { DeliveryRepository } from "./repository";
import { resolveAttemptSource } from "./source-resolver.server";
import { DeliveryConflict } from "./state";

/** Separate native observer capability. Manager tool arguments cannot select this
 * method or producer; production remains off pending signer/runtime isolation. */
export class DeliveryNativeSourceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: ManagerDependencies,
  ) {}
  async ingest(value: unknown) {
    const input = nativeEnvelopeSchema.parse(value);
    const registered = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      nativeProofPayload(value as Record<string, unknown>),
    );
    const policy = {
      version: "native-observation-v1",
      trustedProducers: [],
      maxAgeMs: 60000,
      ...this.dependencies.evidencePolicy,
    };
    const repository = new DeliveryRepository(
      this.db,
      {
        ...policy,
        trustedRuntimeAdapters: [
          ...(policy.trustedRuntimeAdapters ?? []),
          NATIVE_OBSERVER_PRODUCER,
        ],
      },
      async (tx) => {
        const scope = await lockManagerCheckout(tx, input, registered, {
          allowBlocked: true,
          guardianPolicy: this.dependencies.guardianPolicy,
        });
        if (scope.binding.id !== input.managerBindingId)
          throw new DeliveryConflict("native_source_binding_mismatch");
        const resolved = await resolveAttemptSource(
          tx,
          registered.ownerId,
          input.taskId,
          input.attemptId,
          false,
        );
        const { attempt, task } = resolved;
        const claim = await tx.deliveryEvent.findFirst({
          where: { ownerId: registered.ownerId, attemptId: attempt.id, type: "attempt_started" },
        });
        const nativeClaim = (claim?.payload as { nativeClaim?: { sourceContext?: unknown } } | null)
          ?.nativeClaim;
        const expected =
          input.source.kind === "root_boundary" && resolved.output
            ? {
                revisionId: resolved.output.id,
                version: resolved.output.version,
                headSha: resolved.output.headSha,
              }
            : nativeClaim?.sourceContext === undefined
              ? undefined
              : sourceContextSchema.parse(nativeClaim.sourceContext);
        if (input.source.kind !== "root_boundary" || !resolved.output) {
          if (attempt.sourceSha === resolved.physicalBase) {
            if (expected) throw new DeliveryConflict("source_input_context_invalid");
          } else {
            const revision =
              expected &&
              (await tx.deliverySourceRevision.findUnique({
                where: { ownerId_id: { ownerId: registered.ownerId, id: expected.revisionId } },
              }));
            if (
              !revision ||
              revision.taskId !== task.id ||
              revision.managerBindingId !== scope.binding.id ||
              revision.headSha !== attempt.sourceSha ||
              revision.version !== expected?.version ||
              expected.headSha !== attempt.sourceSha ||
              revision.version > task.sourceVersion
            )
              throw new DeliveryConflict("source_input_context_invalid");
          }
        }
        const currentId =
          scope.binding.progressionProtocol === 1
            ? scope.binding.currentAttemptId
            : scope.binding.activeAttemptId;
        // Preserve the existing forensic path: a fresh late envelope tagged with
        // current context may record only the repository's durable old-attempt
        // conflict, never advance that attempt or retarget its runtime input.
        const prior = await tx.deliveryEvent.findUnique({
          where: { ownerId_id: { ownerId: registered.ownerId, id: input.eventId } },
        });
        const forensicLate =
          !prior &&
          (currentId !== attempt.id ||
            (attempt.outputRevisionId && input.source.kind !== "root_boundary")) &&
          canonicalGitHubSource(input.sourceContext) === canonicalGitHubSource(resolved.context);
        if (
          !forensicLate &&
          canonicalGitHubSource(input.sourceContext) !== canonicalGitHubSource(expected)
        )
          throw new DeliveryConflict("source_context_stale");
        if (!prior && !forensicLate && input.source.kind === "root_boundary")
          await requireAppliedSourceForAction(tx, {
            ownerId: registered.ownerId,
            managerBindingId: scope.binding.id,
            taskId: input.taskId,
            action: "root_boundary",
            attemptId: input.attemptId,
            parentTurnId: input.source.parentTurnId,
          });
      },
    );
    return repository.recordNativeSource(registered.ownerId, NATIVE_OBSERVER_PRODUCER, {
      schemaVersion: 1,
      eventId: input.eventId,
      managerBindingId: input.managerBindingId,
      taskId: input.taskId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      leaseGeneration: input.leaseGeneration,
      sequence: input.sequence,
      source: input.source,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
    });
  }
}
