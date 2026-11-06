import type { PrismaClient } from "@hive/db";
import { z } from "zod";

export const durablePushClaimSchema = z
  .object({
    id: z.string().uuid(),
    ownerId: z.string().uuid(),
    eventId: z.string().uuid(),
    attempt: z.number().int().min(1).max(5),
  })
  .strict();
export type DurablePushClaim = z.infer<typeof durablePushClaimSchema>;
const tables = z.enum(["delivery_outbox", "agent_notification_events"]);
export type DurablePushTable = z.infer<typeof tables>;

// Fixed allowlisted identifiers, bound values only. Complete SQL crosses the
// Node/workerd Prisma boundary; no nested cross-runtime SQL fragment is passed.
export async function claimDurablePush(
  db: PrismaClient,
  table: DurablePushTable,
  ownerId: string,
  limit = 1,
  leaseMs = 120000,
): Promise<DurablePushClaim[]> {
  tables.parse(table);
  z.string().uuid().parse(ownerId);
  z.number().int().min(1).max(20).parse(limit);
  z.number().int().min(30000).max(300000).parse(leaseMs);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `WITH exhausted AS (
      SELECT id FROM ${table} WHERE owner_id=$1::uuid AND channel='push'
        AND status IN ('pending','processing') AND attempts>=5 AND next_attempt_at<=clock_timestamp()
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $2
    ) UPDATE ${table} item SET status='failed' FROM exhausted WHERE item.id=exhausted.id`,
        ownerId,
        limit,
      );
      return tx.$queryRawUnsafe<DurablePushClaim[]>(
        `WITH candidates AS (
      SELECT id FROM ${table} WHERE owner_id=$1::uuid AND channel='push'
        AND status IN ('pending','processing') AND attempts<5 AND next_attempt_at<=clock_timestamp()
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $2
    ) UPDATE ${table} item SET status='processing',attempts=item.attempts+1,
      next_attempt_at=clock_timestamp()+$3*interval '1 millisecond'
      FROM candidates WHERE item.id=candidates.id
      RETURNING item.id,item.owner_id AS "ownerId",item.event_id AS "eventId",item.attempts AS attempt`,
        ownerId,
        limit,
        leaseMs,
      );
    },
    { timeout: 10000, maxWait: 10000 },
  );
}

export async function settleDurablePush(
  db: PrismaClient,
  table: DurablePushTable,
  input: DurablePushClaim,
  outcome: "delivered" | "retry" | "failed",
) {
  tables.parse(table);
  const claim = durablePushClaimSchema.parse(input);
  z.enum(["delivered", "retry", "failed"]).parse(outcome);
  const status = outcome === "retry" ? (claim.attempt >= 5 ? "failed" : "pending") : outcome;
  const backoff = Math.min(3600000, 30000 * 2 ** (claim.attempt - 1));
  return db.$transaction(
    async (tx) => {
      // First acquire the exact row lock. A SQL predicate/projection can have
      // sampled time before waiting for a row lock or BEFORE UPDATE trigger.
      await tx.$queryRawUnsafe(
        `SELECT id FROM ${table}
      WHERE id=$1::uuid AND owner_id=$2::uuid AND event_id=$3::uuid FOR UPDATE`,
        claim.id,
        claim.ownerId,
        claim.eventId,
      );
      const [row] = await tx.$queryRawUnsafe<{ leaseUntil: Date; now: Date }[]>(
        `SELECT next_attempt_at AS "leaseUntil",clock_timestamp() AS now FROM ${table}
      WHERE id=$1::uuid AND owner_id=$2::uuid AND event_id=$3::uuid AND attempts=$4 AND status='processing'`,
        claim.id,
        claim.ownerId,
        claim.eventId,
        claim.attempt,
      );
      if (!row || row.leaseUntil <= row.now) return false;
      const changed = await tx.$executeRawUnsafe(
        `UPDATE ${table} SET status=$1,
      next_attempt_at=clock_timestamp()+$2*interval '1 millisecond'
      WHERE id=$3::uuid AND owner_id=$4::uuid AND event_id=$5::uuid AND attempts=$6
        AND status='processing' AND next_attempt_at>clock_timestamp()`,
        status,
        backoff,
        claim.id,
        claim.ownerId,
        claim.eventId,
        claim.attempt,
      );
      const [after] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (after.now >= row.leaseUntil) throw new Error("push_outbox_lease_expired");
      return changed === 1;
    },
    { timeout: 10000, maxWait: 10000 },
  );
}
