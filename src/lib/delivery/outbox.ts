import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import type { PushPayload } from "@/lib/push/types";
import { deliveryEventLabel } from "./event-labels";

const MAX_ATTEMPTS = 5;
const claimSchema = z
  .object({
    id: z.string().uuid(),
    ownerId: z.string().uuid(),
    eventId: z.string().uuid(),
    attempt: z.number().int().min(1).max(MAX_ATTEMPTS),
  })
  .strict();
export type DeliveryNotificationClaim = z.infer<typeof claimSchema>;
export interface DeliveryNotification {
  claim: DeliveryNotificationClaim;
  payload: PushPayload;
}

// Internal worker capability only. Claims are never accepted from browser input.
// Reports remain readable regardless of push preferences, transport failure, or
// retry exhaustion. At-least-once push uses a stable tag, not an exactly-once claim.
export class DeliveryOutbox {
  constructor(private readonly db: PrismaClient) {}

  async claim(
    ownerId: string,
    limit = 10,
    leaseMs = 120_000,
  ): Promise<DeliveryNotificationClaim[]> {
    z.string().uuid().parse(ownerId);
    z.number().int().min(1).max(20).parse(limit);
    z.number().int().min(30_000).max(300_000).parse(leaseMs);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        WITH exhausted AS (
          SELECT id FROM delivery_outbox
          WHERE owner_id = ${ownerId}::uuid AND channel = 'push' AND status IN ('pending', 'processing')
            AND attempts >= ${MAX_ATTEMPTS} AND next_attempt_at <= clock_timestamp()
          ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT ${limit}
        )
        UPDATE delivery_outbox AS item SET status = 'failed'
        FROM exhausted WHERE item.id = exhausted.id`;
      return tx.$queryRaw<DeliveryNotificationClaim[]>`
        WITH candidates AS (
          SELECT id FROM delivery_outbox
          WHERE owner_id = ${ownerId}::uuid AND channel = 'push' AND status IN ('pending', 'processing')
            AND attempts < ${MAX_ATTEMPTS} AND next_attempt_at <= clock_timestamp()
          ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT ${limit}
        )
        UPDATE delivery_outbox AS item
        SET status = 'processing', attempts = item.attempts + 1,
            next_attempt_at = clock_timestamp() + ${leaseMs} * interval '1 millisecond'
        FROM candidates WHERE item.id = candidates.id
        RETURNING item.id, item.owner_id AS "ownerId", item.event_id AS "eventId",
                  item.attempts AS attempt`;
    });
  }

  async notification(value: DeliveryNotificationClaim): Promise<DeliveryNotification | null> {
    const claim = claimSchema.parse(value);
    // Both the claim fence and all relation owners are checked in this query.
    // Historical reports use their attempt SHA, never the task's later revision.
    const rows = await this.db.$queryRaw<
      {
        reportId: string | null;
        taskId: string;
        kind: string | null;
        eventType: string;
        sourceSha: string | null;
        difficulty: string | null;
        projectName: string;
      }[]
    >`
      SELECT report.id AS "reportId", event.task_id AS "taskId", step.kind,
        event.type AS "eventType", attempt.source_sha AS "sourceSha",
        report.difficulty, project.full_name AS "projectName"
      FROM delivery_outbox AS item
      JOIN delivery_events AS event ON event.id = item.event_id AND event.owner_id = item.owner_id
      LEFT JOIN delivery_step_reports AS report ON report.event_id = event.id AND report.owner_id = item.owner_id
      LEFT JOIN delivery_steps AS step ON step.id = event.step_id AND step.owner_id = item.owner_id
      LEFT JOIN delivery_attempts AS attempt ON attempt.id = event.attempt_id AND attempt.owner_id = item.owner_id
      JOIN delivery_tasks AS task ON task.id = event.task_id AND task.owner_id = item.owner_id
      JOIN delivery_projects AS project ON project.id = task.project_id AND project.owner_id = item.owner_id
      WHERE item.id = ${claim.id}::uuid AND item.owner_id = ${claim.ownerId}::uuid
        AND item.event_id = ${claim.eventId}::uuid AND item.attempts = ${claim.attempt}
        AND item.status = 'processing' AND item.next_attempt_at > clock_timestamp()`;
    const row = rows[0];
    if (!row) return null;
    const label = deliveryEventLabel(row.eventType);
    return {
      claim,
      payload: {
        kind: "delivery",
        title: label,
        body: row.reportId
          ? `${row.projectName}: ${row.kind} · ${row.difficulty} difficulty · ${row.sourceSha?.slice(0, 8) ?? "unknown revision"}. Open the report for details.`
          : `${row.projectName}: ${label}. Open the task for details.`,
        tag: `delivery:${claim.eventId}`,
        url: `/workspaces?panel=delivery&task=${row.taskId}${row.reportId ? `&report=${row.reportId}` : ""}`,
      },
    };
  }

  async settle(value: DeliveryNotificationClaim, result: "delivered" | "retry" | "failed") {
    const claim = claimSchema.parse(value);
    z.enum(["delivered", "retry", "failed"]).parse(result);
    const status =
      result === "retry" ? (claim.attempt >= MAX_ATTEMPTS ? "failed" : "pending") : result;
    const backoffMs = Math.min(3600_000, 30_000 * 2 ** (claim.attempt - 1));
    const count = await this.db.$executeRaw`
      UPDATE delivery_outbox SET status = ${status},
        next_attempt_at = clock_timestamp() + ${backoffMs} * interval '1 millisecond'
      WHERE id = ${claim.id}::uuid AND owner_id = ${claim.ownerId}::uuid
        AND event_id = ${claim.eventId}::uuid AND attempts = ${claim.attempt}
        AND status = 'processing' AND next_attempt_at > clock_timestamp()`;
    return count === 1;
  }
}

export async function deliverClaim(
  outbox: DeliveryOutbox,
  claim: DeliveryNotificationClaim,
  send: (ownerId: string, payload: PushPayload) => Promise<"delivered" | "retry" | "failed">,
) {
  const notification = await outbox.notification(claim);
  if (!notification) return "stale" as const;
  let result: "delivered" | "retry" | "failed";
  try {
    result = await send(claim.ownerId, notification.payload);
  } catch {
    result = "retry";
  }
  const outcome = result === "retry" && claim.attempt >= MAX_ATTEMPTS ? "failed" : result;
  return (await outbox.settle(claim, outcome)) ? outcome : ("stale" as const);
}
