import { createHash } from "node:crypto";
import type { Prisma } from "@hive/db";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
const key = (intentId: string, kind: string) => `checkout-${kind}/${intentId}`;
export async function readCheckoutClosure(
  tx: Tx,
  ownerId: string,
  intentId: string,
  kind: string,
  version = 1,
) {
  const event = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId,
        aggregateKey: key(intentId, kind),
        aggregateVersion: version,
      },
    },
  });
  if (!event) return null;
  if (
    event.type !== `checkout_${kind}` ||
    !event.payload ||
    guardianDigest(event.payload) !== event.requestDigest
  )
    throw new DeliveryConflict("checkout_closure_conflict");
  return event;
}
export async function retainCheckoutClosure(
  tx: Tx,
  scope: { ownerId: string; taskId: string; intentId: string },
  kind: string,
  payload: Prisma.InputJsonObject,
  version = 1,
) {
  const aggregateKey = key(scope.intentId, kind),
    requestDigest = guardianDigest(payload),
    prior = await readCheckoutClosure(tx, scope.ownerId, scope.intentId, kind, version);
  if (prior) {
    if (prior.taskId !== scope.taskId || prior.requestDigest !== requestDigest)
      throw new DeliveryConflict("checkout_closure_conflict");
    return prior;
  }
  const h = createHash("sha256")
    .update(`${scope.ownerId}/${aggregateKey}/${version}`)
    .digest("hex");
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return tx.deliveryEvent.create({
    data: {
      id,
      ownerId: scope.ownerId,
      taskId: scope.taskId,
      aggregateKey,
      aggregateVersion: version,
      type: `checkout_${kind}`,
      schemaVersion: 1,
      policyVersion: "controller-checkout-v1",
      requestDigest,
      payload,
    },
  });
}

export async function latestCheckoutClosure(
  tx: Tx,
  ownerId: string,
  intentId: string,
  kind: string,
) {
  const event = await tx.deliveryEvent.findFirst({
    where: { ownerId, aggregateKey: key(intentId, kind) },
    orderBy: { aggregateVersion: "desc" },
  });
  if (
    event &&
    (event.type !== `checkout_${kind}` ||
      !event.payload ||
      guardianDigest(event.payload) !== event.requestDigest)
  )
    throw new DeliveryConflict("checkout_closure_conflict");
  return event;
}
