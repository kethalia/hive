import { randomUUID } from "node:crypto";
import { getConfiguredCoderUrl } from "@hive/auth";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { sendFetchPush } from "@/lib/push/fetch-transport";
import { notificationPreferencesSchema, type PushPayload } from "@/lib/push/types";
import { getVapidKeys } from "@/lib/push/vapid";
import { publicationNameSchema } from "./publication-contracts";
import { cancelPublicationBody, publicationAwait, publicationFetch } from "./publication-io";

const claimSchema = z
  .object({
    id: z.string().uuid(),
    ownerId: z.string().uuid(),
    jobId: z.string().uuid(),
    eventId: z.string().uuid(),
    holder: z.string().uuid(),
    attempt: z.number().int().min(1).max(5),
  })
  .strict();
export type TemplateNoticeClaim = z.infer<typeof claimSchema>;
export type TemplateNoticeOutcome = "delivered" | "retry" | "failed";
type Reason =
  | "delivered"
  | "retry"
  | "exhausted"
  | "owner_changed"
  | "invalid_terminal"
  | "subscription_limit"
  | "send_failed";

/** Metadata-only outbox; no Coder credential, provider output or session cookie. */
export class TemplatePublicationNotices {
  private readonly leaseMs: number;
  private readonly retryMs: number;
  constructor(
    private readonly db: PrismaClient,
    timing: { leaseMs?: number; retryMs?: number } = {},
  ) {
    this.leaseMs = z
      .number()
      .int()
      .min(20)
      .max(120000)
      .parse(timing.leaseMs ?? 120000);
    this.retryMs = z
      .number()
      .int()
      .min(1)
      .max(30000)
      .parse(timing.retryMs ?? 30000);
  }
  async claim(): Promise<TemplateNoticeClaim | null> {
    const origin = getConfiguredCoderUrl(),
      holder = randomUUID();
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`WITH exhausted AS (
     SELECT n.id FROM template_publication_notices n JOIN template_publication_jobs j ON j.owner_id=n.owner_id AND j.id=n.job_id JOIN template_publication_targets t ON t.id=j.target_id
     WHERE t.configured_origin=${origin} AND n.attempts>=5 AND ((n.status='pending' AND n.next_attempt_at<=clock_timestamp()) OR (n.status='processing' AND n.lease_until<=clock_timestamp()))
     ORDER BY n.next_attempt_at,n.id FOR UPDATE OF n SKIP LOCKED LIMIT 1
    ) UPDATE template_publication_notices n SET status='failed',last_reason='exhausted',finished_at=clock_timestamp(),lease_holder=NULL,lease_until=NULL FROM exhausted WHERE n.id=exhausted.id`;
        const leaseMs = this.leaseMs;
        const rows = await tx.$queryRaw<TemplateNoticeClaim[]>`WITH candidate AS (
     SELECT n.id FROM template_publication_notices n JOIN template_publication_jobs j ON j.owner_id=n.owner_id AND j.id=n.job_id JOIN template_publication_targets t ON t.id=j.target_id
     WHERE t.configured_origin=${origin} AND n.attempts<5 AND ((n.status='pending' AND n.next_attempt_at<=clock_timestamp()) OR (n.status='processing' AND n.lease_until<=clock_timestamp()))
     ORDER BY n.next_attempt_at,n.id FOR UPDATE OF n SKIP LOCKED LIMIT 1
    ) UPDATE template_publication_notices n SET status='processing',attempts=n.attempts+1,lease_holder=${holder}::uuid,lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond'
      FROM candidate WHERE n.id=candidate.id RETURNING n.id,n.owner_id AS "ownerId",n.job_id AS "jobId",n.event_id AS "eventId",n.attempts AS attempt,n.lease_holder AS holder`;
        return rows[0] ? claimSchema.parse(rows[0]) : null;
      },
      { timeout: 10000, maxWait: 10000 },
    );
  }
  async notification(
    input: TemplateNoticeClaim,
  ): Promise<{ payload: PushPayload } | { skip: Reason } | null> {
    const c = claimSchema.parse(input),
      origin = getConfiguredCoderUrl();
    const rows = await this.db.$queryRaw<
      {
        name: string;
        stage: string;
        eventCode: string;
        eventKey: string;
        coderUserId: string;
        actorCoderUserId: string;
        coderUrl: string;
      }[]
    >`
    SELECT j.template_name AS name,j.stage,e.code AS "eventCode",e.key AS "eventKey",u.coder_user_id AS "coderUserId",j.actor_coder_user_id AS "actorCoderUserId",u.coder_url AS "coderUrl"
      FROM template_publication_notices n JOIN template_publication_jobs j ON j.owner_id=n.owner_id AND j.id=n.job_id
      JOIN template_publication_events e ON e.owner_id=n.owner_id AND e.job_id=n.job_id AND e.id=n.event_id
      JOIN template_publication_targets t ON t.id=j.target_id JOIN users u ON u.id=j.owner_id
      WHERE n.id=${c.id}::uuid AND n.owner_id=${c.ownerId}::uuid AND n.job_id=${c.jobId}::uuid AND n.event_id=${c.eventId}::uuid
        AND n.status='processing' AND n.attempts=${c.attempt} AND n.lease_holder=${c.holder}::uuid AND n.lease_until>clock_timestamp() AND t.configured_origin=${origin}`;
    const row = rows[0];
    if (!row) return null;
    if (row.coderUserId !== row.actorCoderUserId || row.coderUrl !== origin)
      return { skip: "owner_changed" };
    if (
      !publicationNameSchema.safeParse(row.name).success ||
      !["succeeded", "failed", "held"].includes(row.stage) ||
      row.eventKey !== `terminal:${row.stage}` ||
      row.eventCode !== (row.stage === "succeeded" ? "activation_verified" : row.stage)
    )
      return { skip: "invalid_terminal" };
    return {
      payload: {
        kind: "template",
        title:
          row.stage === "succeeded"
            ? "Template published"
            : row.stage === "held"
              ? "Template publication needs review"
              : "Template push failed",
        body: `${row.name}: ${row.stage === "succeeded" ? "ready to use" : "open Hive to review the result"}`,
        tag: `hive-template-${c.jobId}`,
        url: `/templates/${encodeURIComponent(row.name)}?publication=${c.jobId}`,
      },
    };
  }
  async acknowledge(
    input: TemplateNoticeClaim,
    outcome: TemplateNoticeOutcome | "skipped",
    reason: Reason,
  ): Promise<boolean> {
    const c = claimSchema.parse(input);
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM template_publication_notices WHERE id=${c.id}::uuid AND owner_id=${c.ownerId}::uuid FOR UPDATE`;
        const row = await tx.templatePublicationNotice.findFirst({
          where: {
            id: c.id,
            ownerId: c.ownerId,
            jobId: c.jobId,
            eventId: c.eventId,
            status: "processing",
            attempts: c.attempt,
            leaseHolder: c.holder,
          },
        });
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!row?.leaseUntil || row.leaseUntil <= clock.now) return false;
        const identities = await tx.$queryRaw<
          { coderUserId: string; actorCoderUserId: string; coderUrl: string; origin: string }[]
        >`SELECT u.coder_user_id AS "coderUserId",j.actor_coder_user_id AS "actorCoderUserId",u.coder_url AS "coderUrl",t.configured_origin AS origin FROM users u JOIN template_publication_jobs j ON j.owner_id=u.id JOIN template_publication_targets t ON t.id=j.target_id WHERE j.owner_id=${c.ownerId}::uuid AND j.id=${c.jobId}::uuid FOR SHARE OF u`;
        const actor = identities[0];
        if (!actor || actor.origin !== getConfiguredCoderUrl()) return false;
        if (
          outcome !== "skipped" &&
          (actor.coderUserId !== actor.actorCoderUserId || actor.coderUrl !== actor.origin)
        )
          return false;
        const terminal = outcome !== "retry" || c.attempt >= 5;
        await tx.templatePublicationNotice.update({
          where: { id: c.id },
          data: {
            status: outcome === "retry" ? (terminal ? "failed" : "pending") : outcome,
            lastReason: outcome === "retry" && terminal ? "exhausted" : reason,
            leaseHolder: null,
            leaseUntil: null,
            finishedAt: terminal ? clock.now : null,
            nextAttemptAt: new Date(
              clock.now.getTime() + Math.min(3600000, this.retryMs * 2 ** (c.attempt - 1)),
            ),
          },
        });
        const [after] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (after.now >= row.leaseUntil) throw new Error("template_notice_lease_expired");
        return true;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
        maxWait: 10000,
      },
    );
  }
}

export async function sendTemplatePublicationPush(
  db: PrismaClient,
  ownerId: string,
  payload: PushPayload,
  subject: string,
  signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<TemplateNoticeOutcome> {
  signal.throwIfAborted();
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: ownerId },
    take: 21,
  });
  signal.throwIfAborted();
  if (subscriptions.length > 20) return "failed";
  const enabled = subscriptions.filter(
    (row) => notificationPreferencesSchema.parse(row.preferences ?? {}).template,
  );
  if (!enabled.length) return "delivered";
  if (!subject) return "retry";
  const keys = await getVapidKeys();
  signal.throwIfAborted();
  const boundedTransport: typeof fetch = async (input, init) => {
    const requestSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
    const response = await publicationFetch(
      fetch(input, { ...init, signal: requestSignal }),
      requestSignal,
    );
    await cancelPublicationBody(response);
    if (response.redirected) throw new Error("push_redirect_rejected");
    // The shared VAPID helper only needs status; do not give it a body whose
    // cancellation could outlive the sender/drained database request.
    return new Response(null, { status: response.status });
  };
  const sends = await Promise.allSettled(
    enabled.map(async (row) => {
      try {
        signal.throwIfAborted();
        await sendFetchPush(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: "normal", vapidDetails: { subject, ...keys } },
          boundedTransport,
        );
      } catch (error) {
        const code =
          error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
        if (code !== 404 && code !== 410) throw error;
        signal.throwIfAborted();
        await db.pushSubscription.deleteMany({
          where: { id: row.id, userId: ownerId, endpoint: row.endpoint },
        });
      }
    }),
  );
  return sends.some((result) => result.status === "rejected") ? "retry" : "delivered";
}

export async function dispatchTemplatePublicationNotices(
  db: PrismaClient,
  send: (
    ownerId: string,
    payload: PushPayload,
    signal: AbortSignal,
  ) => Promise<TemplateNoticeOutcome>,
  options: {
    enabled?: boolean;
    timing?: { leaseMs?: number; retryMs?: number; sendMs?: number };
  } = {},
) {
  const counts = { enabled: false, delivered: 0, retry: 0, failed: 0, skipped: 0, stale: 0 };
  if (!(options.enabled ?? process.env.HIVE_TEMPLATE_NOTIFICATION_DISPATCH_ENABLED === "true"))
    return counts;
  counts.enabled = true;
  const sendMs = z
    .number()
    .int()
    .min(1)
    .max(15000)
    .parse(options.timing?.sendMs ?? 15000);
  const store = new TemplatePublicationNotices(db, options.timing),
    claim = await store.claim();
  if (!claim) return counts;
  const notice = await store.notification(claim);
  if (!notice) {
    counts.stale++;
    return counts;
  }
  let outcome: TemplateNoticeOutcome | "skipped", reason: Reason;
  if ("skip" in notice) {
    outcome = "skipped";
    reason = notice.skip;
  } else {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), sendMs);
    const work = Promise.resolve().then(() => send(claim.ownerId, notice.payload, abort.signal));
    try {
      outcome = await publicationAwait(work, abort.signal);
      reason =
        outcome === "delivered" ? "delivered" : outcome === "retry" ? "retry" : "send_failed";
    } catch {
      outcome = "retry";
      reason = "send_failed";
    } finally {
      clearTimeout(timer);
      abort.abort();
      // A deadline is not proof that a callback has finished DB work. Keep the
      // caller's database lifetime open through late reads/key work/deletes.
      await work.catch(() => {});
    }
  }
  if (outcome === "retry" && claim.attempt >= 5) {
    outcome = "failed";
    reason = "exhausted";
  }
  try {
    if (await store.acknowledge(claim, outcome, reason)) counts[outcome]++;
    else counts.stale++;
  } catch {
    counts.stale++;
  }
  return counts;
}
