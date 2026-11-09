import type { Prisma } from "@hive/db";
import type { RegistrationBinding } from "./registration.server";

/** Call under the existing workspace advisory lock, before creating any slot,
 * runtime or grant. A proven unused predecessor can never acquire authority
 * afterward, including after its successor closes. Other builds are unaffected. */
export async function isUnusedBootstrapPredecessor(
  tx: Prisma.TransactionClient,
  binding: RegistrationBinding,
) {
  return (
    (await tx.codexGuardianRuntime.count({
      where: {
        ownerId: binding.hiveUserId,
        workspaceId: binding.workspaceId,
        unusedBootstrapPredecessorBuildId: binding.buildId,
        slot: { coderOrigin: binding.coderOrigin },
      },
    })) > 0
  );
}
