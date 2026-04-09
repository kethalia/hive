import type { CoderClient } from "@/lib/coder/client";
import type { PrismaClient } from "@prisma/client";
import { cleanupWorkspace } from "./cleanup";

/** Options for the cleanup scheduler */
export interface CleanupSchedulerOptions {
  /** Sweep interval in milliseconds (default: 5 minutes) */
  intervalMs?: number;
  /** Grace period in milliseconds after task completion before cleanup (default: env CLEANUP_GRACE_MS or 60 000) */
  graceMs?: number;
}

/** Handle returned by startCleanupScheduler for graceful shutdown */
export interface CleanupSchedulerHandle {
  stop: () => void;
}

/**
 * Start a periodic garbage collection scheduler that finds stale workspaces
 * (task done/failed, updatedAt past grace period) and cleans them up.
 *
 * This is a safety net — the primary cleanup path is the fire-and-forget
 * `cleanupWorkspace` call in task-queue.ts. If that fails silently, the
 * scheduler catches leaked workspaces on its next sweep.
 */
export function startCleanupScheduler(
  coderClient: CoderClient,
  db: PrismaClient,
  options?: CleanupSchedulerOptions,
): CleanupSchedulerHandle {
  const intervalMs = options?.intervalMs ?? 5 * 60 * 1000;
  const rawGraceMs =
    options?.graceMs ??
    (process.env.CLEANUP_GRACE_MS
      ? Number(process.env.CLEANUP_GRACE_MS)
      : 60_000);
  // Clamp to non-negative — a negative grace would skip the waiting period
  const graceMs = Math.max(0, rawGraceMs);

  let sweepInProgress = false;

  const runSweep = () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    sweep(coderClient, db, graceMs)
      .catch((err) =>
        console.error(
          `[cleanup-scheduler] unhandled sweep error: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => {
        sweepInProgress = false;
      });
  };

  const timer = setInterval(runSweep, intervalMs);

  // Run first sweep immediately
  runSweep();

  return {
    stop: () => clearInterval(timer),
  };
}

/**
 * Single sweep: find stale workspaces and clean them up.
 * Never throws — all errors are logged.
 */
async function sweep(
  coderClient: CoderClient,
  db: PrismaClient,
  graceMs: number,
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - graceMs);

    const staleWorkspaces = await db.workspace.findMany({
      where: {
        status: { not: "deleted" },
        coderWorkspaceId: { not: null },
        task: {
          status: { in: ["done", "failed"] },
          updatedAt: { lt: cutoff },
        },
      },
      include: { task: true },
    });

    console.log(
      `[cleanup-scheduler] sweep found ${staleWorkspaces.length} stale workspace(s)`,
    );

    let cleaned = 0;
    for (const ws of staleWorkspaces) {
      try {
        await cleanupWorkspace(coderClient, ws.coderWorkspaceId!, 0, db);
        cleaned++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `[cleanup-scheduler] failed to clean workspace=${ws.coderWorkspaceId}: ${msg}`,
        );
      }
    }

    console.log(
      `[cleanup-scheduler] sweep complete: ${cleaned}/${staleWorkspaces.length} cleaned`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[cleanup-scheduler] sweep error: ${msg}`);
  }
}
