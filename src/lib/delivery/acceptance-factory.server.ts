import type { PrismaClient } from "@hive/db";
import { AcceptanceSuccessController } from "./acceptance-completion.server";
import { acceptanceDeploymentConfig } from "./acceptance-config.server";
import { AcceptanceMaterialResolver } from "./acceptance-material.server";
import { AcceptanceRepairController } from "./acceptance-repair.server";
import { AcceptanceStore } from "./acceptance-store.server";
import { repositoryPolicyAdapters, repositoryPolicyStore } from "./repository-policy.server";
export function acceptanceServices(db: PrismaClient) {
  const producer = acceptanceDeploymentConfig();
  if (!producer) return null;
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw Error("Acceptance encryption unavailable");
  const policies = repositoryPolicyStore(db);
  const material = new AcceptanceMaterialResolver(
    policies,
    repositoryPolicyAdapters(policies, { independentAcceptance: false }).resolveEvidencePolicy,
  );
  const store = new AcceptanceStore({
    enabled: true,
    encryptionKey: key,
    producer,
    materializeReview: (tx, scope, value) => material.material(tx, scope, value),
  });
  return {
    store,
    material,
    policies,
    repair: new AcceptanceRepairController(material, store),
    success: new AcceptanceSuccessController(
      material,
      repositoryPolicyAdapters(policies).resolveEvidencePolicy,
    ),
  };
}
