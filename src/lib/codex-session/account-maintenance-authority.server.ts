import type { Prisma } from "@hive/db";
import {
  type AccountMaintenanceState,
  accountMaintenanceStateSchema,
} from "./account-maintenance-contracts";
import type { RegistrationBinding } from "./registration.server";

type Tx = Prisma.TransactionClient;
type WorkspaceScope = Pick<RegistrationBinding, "hiveUserId" | "coderOrigin" | "workspaceId">;

/** Shared BEFORE slot/runtime locks, including a newly inserted agent slot.
 * Account maintenance applies to the fixed workspace credential root, not one
 * historical registration. No caller chooses the lock key or credential path. */
export async function lockAccountMaintenanceWorkspace(tx: Tx, scope: WorkspaceScope) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hive-account-maintenance-v1:${scope.hiveUserId}:${scope.coderOrigin}:${scope.workspaceId}`},0))`;
}
export function parseAccountMaintenance(value: unknown): AccountMaintenanceState | null {
  return value === null || value === undefined ? null : accountMaintenanceStateSchema.parse(value);
}
