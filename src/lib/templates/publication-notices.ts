import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { sendBoundedPush } from "@/lib/push/bounded-send";

/** Independent same-Worker dispatch; an accepted provider send is at-least-once. */
export async function dispatchTemplateNotices(
  db: PrismaClient,
  subject: string,
  options: {
    limit?: number;
    signal?: AbortSignal;
    send?: typeof sendBoundedPush;
    ownerId?: string;
  } = {},
) {
  const owner = options.ownerId === undefined ? null : z.string().uuid().parse(options.ownerId);
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Invalid template notice bound");
  const deadline = Date.now() + 20000;
  const signal = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let processed = 0;
  for (; processed < limit && !signal.aborted; processed++) {
    await db.$executeRaw`WITH exhausted AS (
      SELECT id FROM template_notices WHERE status IN ('pending','processing') AND attempts=5 AND next_attempt_at<=clock_timestamp()
      AND (${owner}::uuid IS NULL OR owner_id=${owner}::uuid)
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 100
    ) UPDATE template_notices n SET status='failed' FROM exhausted WHERE n.id=exhausted.id`;
    const [notice] = await db.$queryRaw<
      {
        id: string;
        ownerId: string;
        jobId: string;
        attempts: number;
        name: string;
        phase: string;
      }[]
    >`WITH next AS (
      SELECT id FROM template_notices WHERE status IN ('pending','processing') AND attempts<5 AND next_attempt_at<=clock_timestamp()
        AND (${owner}::uuid IS NULL OR owner_id=${owner}::uuid) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE template_notices n SET status='processing',attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '60 seconds' FROM next WHERE n.id=next.id RETURNING n.*
    ) SELECT c.id,c.owner_id AS "ownerId",c.job_id AS "jobId",c.attempts,j.name,j.phase FROM claimed c JOIN template_jobs j ON j.id=c.job_id AND j.owner_id=c.owner_id`;
    if (!notice) break;
    let outcome: "delivered" | "retry" | "failed" = "retry";
    try {
      signal.throwIfAborted();
      outcome = await (options.send ?? sendBoundedPush)(
        db,
        notice.ownerId,
        {
          title: notice.phase === "succeeded" ? "Template pushed" : "Template push needs attention",
          body: `${notice.name}: ${notice.phase === "succeeded" ? "published successfully" : notice.phase === "held" ? "provider outcome requires review" : "publication failed"}`,
          kind: "template",
          tag: `template-${notice.jobId}`,
          url: `/templates/${encodeURIComponent(notice.name)}`,
        },
        subject,
        signal,
        deadline,
      );
    } catch {
      /* Drain send before settling its lease or closing the database. */
    }
    await db.$executeRaw`UPDATE template_notices SET status=${outcome === "retry" ? (notice.attempts >= 5 ? "failed" : "pending") : outcome},
      next_attempt_at=clock_timestamp()+interval '10 seconds' WHERE id=${notice.id}::uuid AND owner_id=${notice.ownerId}::uuid AND status='processing' AND attempts=${notice.attempts}`;
  }
  return { processed };
}
