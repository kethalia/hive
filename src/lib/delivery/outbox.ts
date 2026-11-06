import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { claimDurablePush, settleDurablePush } from "@/lib/push/durable-outbox";
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
    return claimDurablePush(this.db, "delivery_outbox", ownerId, limit, leaseMs);
  }

  async notification(value: DeliveryNotificationClaim): Promise<DeliveryNotification | null> {
    const claim = claimSchema.parse(value);
    // Both the claim fence and all relation owners are checked in this query.
    // Historical reports use the immutable accepted output (or input), never a
    // later task revision. Output binding is owner/step/producing-attempt scoped.
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
        event.type AS "eventType", COALESCE(revision.head_sha, attempt.source_sha) AS "sourceSha",
        report.difficulty, project.full_name AS "projectName"
      FROM delivery_outbox AS item
      JOIN delivery_events AS event ON event.id = item.event_id AND event.owner_id = item.owner_id
      LEFT JOIN delivery_step_reports AS report ON report.event_id = event.id AND report.owner_id = item.owner_id
      LEFT JOIN delivery_steps AS step ON step.id = event.step_id AND step.owner_id = item.owner_id
      LEFT JOIN delivery_attempts AS attempt ON attempt.id = event.attempt_id AND attempt.owner_id = item.owner_id
      LEFT JOIN delivery_source_revisions AS revision ON revision.id = attempt.output_revision_id
        AND revision.owner_id = item.owner_id AND revision.step_id = attempt.step_id
        AND revision.producing_attempt_id = attempt.id
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
    return settleDurablePush(this.db, "delivery_outbox", claim, result);
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
