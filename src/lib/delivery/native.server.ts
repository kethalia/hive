import type { PrismaClient } from "@hive/db";
import type { ManagerDependencies } from "./manager.server";
import { authenticateCheckoutHost, lockManagerCheckout } from "./manager-binding.server";
import {
  NATIVE_OBSERVER_PRODUCER,
  nativeEnvelopeSchema,
  nativeProofPayload,
} from "./native-contracts";
import { DeliveryRepository } from "./repository";
import { resolveTaskSource } from "./source-resolver.server";
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
        const scope = await lockManagerCheckout(tx, input, registered, { allowBlocked: true });
        if (scope.binding.id !== input.managerBindingId)
          throw new DeliveryConflict("native_source_binding_mismatch");
        await resolveTaskSource(tx, registered.ownerId, input.taskId, input.sourceContext, true);
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
    });
  }
}
