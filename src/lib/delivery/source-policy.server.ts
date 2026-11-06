import { z } from "zod";
import { sourcePublicationPolicySchema } from "./source-transport-contracts";
import { DeliveryConflict } from "./state";

const entry = z
  .object({
    ownerId: z.string().uuid(),
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    policy: sourcePublicationPolicySchema,
  })
  .strict();
/** Deployment-owned task map. Never read policy from model, host, or repository. */
export function resolveControllerSourcePolicy(
  scope: { ownerId: string; taskId: string; repositoryId: string },
  readConfig = () => process.env.HIVE_DELIVERY_SOURCE_POLICIES_JSON,
) {
  const raw = readConfig();
  if (!raw || Buffer.byteLength(raw) > 65536)
    throw new Error("Source publication policy unavailable");
  const entries = z.record(z.string().uuid(), entry).parse(JSON.parse(raw));
  if (Object.keys(entries).length > 100) throw new Error("Source publication policy unavailable");
  const configured = Object.hasOwn(entries, scope.taskId) ? entries[scope.taskId] : null;
  if (
    !configured ||
    configured.ownerId !== scope.ownerId ||
    configured.repositoryId !== scope.repositoryId
  )
    throw new DeliveryConflict("source_task_policy_missing");
  return configured.policy;
}
