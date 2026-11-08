import { Prisma } from "@hive/db";
import { z } from "zod";

/** Existing external-effect ledgers only. Physical tree exit is not a provider
 * outcome. Expiry cannot consume an uncertain source-publication grant. */
export async function maintenanceExternalEffectsHeld(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskIds: readonly string[],
  options: { lockTasks?: boolean } = {},
) {
  z.string().uuid().parse(ownerId);
  const ids = z.array(z.string().uuid()).max(32).parse(taskIds);
  if (!ids.length) return false;
  if (new Set(ids).size !== ids.length) return true;
  const list = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  if (options.lockTasks) {
    const tasks = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM delivery_tasks
      WHERE owner_id=${ownerId}::uuid AND id IN (${list}) ORDER BY id FOR UPDATE`);
    if (tasks.length !== ids.length) return true;
  }
  const [result] = await tx.$queryRaw<{ held: boolean }[]>(Prisma.sql`SELECT (
    EXISTS(SELECT 1 FROM delivery_releases r JOIN delivery_release_actions a ON a.release_id=r.id
      WHERE r.owner_id=${ownerId}::uuid AND r.task_id IN (${list}) AND
      (a.target_digest<>r.target_digest OR a.phase NOT IN ('prepared','observed','canceled') OR
        (a.phase='prepared' AND (a.remote_reference IS NOT NULL OR a.receipt_digest IS NOT NULL OR a.receipt IS NOT NULL))) LIMIT 1)
    OR EXISTS(SELECT 1 FROM delivery_events g WHERE g.owner_id=${ownerId}::uuid AND g.task_id IN (${list})
      AND g.type='source_publication_grant' AND NOT EXISTS(SELECT 1 FROM delivery_events c
        WHERE c.owner_id=g.owner_id AND c.task_id=g.task_id AND c.type='source_publication_consumed'
          AND c.payload->>'challengeId'=g.id::text) LIMIT 1)
    ) AS held`);
  return result?.held !== false;
}
