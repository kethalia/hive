import { getDb, type Prisma, type PrismaClient } from "@hive/db";
import {
  type AutomaticReleaseConfig,
  type ProductionAcceptanceAnchor,
  productionAcceptanceAnchorSchema,
} from "./release-automatic-contracts";
import { AutomaticReleaseLifecycle } from "./release-automatic-lifecycle.server";
import { repositoryPolicyStore } from "./repository-policy.server";

export type { ProductionAcceptanceAnchor };
export { productionAcceptanceAnchorSchema };

const reader = (config: AutomaticReleaseConfig) =>
  new AutomaticReleaseLifecycle(getDb(), config, repositoryPolicyStore(getDb()));
export function readProductionAcceptanceAnchor(
  tx: Prisma.TransactionClient,
  config: AutomaticReleaseConfig,
  scope: { ownerId: string; taskId: string; sourceRevisionId: string; sourceSha: string },
) {
  return reader(config).readAcceptanceAnchor(tx, scope);
}
export function verifyProductionAcceptanceAnchor(
  tx: Prisma.TransactionClient,
  config: AutomaticReleaseConfig,
  anchor: ProductionAcceptanceAnchor,
  options: { fresh: boolean },
) {
  return reader(config).verifyAcceptanceAnchor(tx, anchor, options);
}
export function finalizeProductionAcceptance(
  tx: Prisma.TransactionClient,
  config: AutomaticReleaseConfig,
  anchor: ProductionAcceptanceAnchor,
) {
  return reader(config).finalizeAcceptance(tx, anchor);
}
export async function refreshProductionAcceptance(
  db: PrismaClient,
  config: AutomaticReleaseConfig,
  scope: { ownerId: string; taskId: string; releaseId: string },
  signal: AbortSignal,
) {
  const { createAutomaticReleaseController } = await import("./release-automatic-installed.server");
  const controller = createAutomaticReleaseController(db, config);
  const rows = await db.$queryRaw<
    { id: string }[]
  >`SELECT r.id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.owner_id=${scope.ownerId}::uuid AND r.task_id=${scope.taskId}::uuid AND r.id=${scope.releaseId}::uuid AND r.target_digest=${controller.lifecycle.targetDigest} AND r.purpose='automatic_production' AND r.phase='healthy' AND t.active_release_id=r.id LIMIT 2`;
  if (rows.length !== 1) return false;
  return (await controller.observe(scope.ownerId, scope.releaseId, signal)) === "healthy";
}
