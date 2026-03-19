import type { CoderClient } from "@/lib/coder/client";
import type { PrismaClient } from "@prisma/client";

/**
 * Clean up a Coder workspace after blueprint execution.
 *
 * Waits a grace period, then stops + deletes the workspace and updates
 * the DB record. Errors are logged but never thrown — cleanup failure
 * must not affect the task outcome.
 */
export async function cleanupWorkspace(
  coderClient: CoderClient,
  workspaceId: string,
  graceMs: number,
  db: PrismaClient,
): Promise<void> {
  try {
    if (graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs));
    }

    await coderClient.stopWorkspace(workspaceId);
    await coderClient.deleteWorkspace(workspaceId);

    await db.workspace.update({
      where: { coderWorkspaceId: workspaceId },
      data: { status: "deleted" },
    });

    console.log(
      `[cleanup] workspace=${workspaceId} stopped and deleted after ${graceMs}ms grace`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[cleanup] workspace=${workspaceId} cleanup failed: ${msg}`);
  }
}
