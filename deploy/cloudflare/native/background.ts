import { getDb, type PrismaClient } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { dispatchAgentEvents } from "@/lib/push/agent-events";
import { sendBoundedPush } from "@/lib/push/bounded-send";
import { type BackgroundBinding, wakeBackground } from "@/lib/queue/background-wake.server";
import { dispatchLegacyTokenRotation } from "@/lib/queue/token-rotation-cloudflare.server";
import type { TemplateAssets } from "@/lib/templates/publication-artifact";
import { dispatchTemplateNotices } from "@/lib/templates/publication-notices";
import { dispatchTemplateJobs } from "@/lib/templates/publication-service";
import { cleanupTerminalDiagnostics } from "@/lib/terminal/diagnostics.server";
import { assertNativeEnvironment } from "./composition.mjs";

export type BackgroundEnvironment = {
  DATABASE_URL?: string;
  HIVE_NATIVE_MODE?: string;
  HIVE_DATABASE_ROLE?: string;
  HIVE_DATABASE_NAME?: string;
  ASSETS: TemplateAssets;
  VAPID_SUBJECT?: string;
  HIVE_PUBLIC_ORIGIN?: string;
  BACKGROUND: BackgroundBinding;
};

// The next durable due time includes active leases, so a lost invocation can
// resume after its existing claim expires without continuously polling Neon.
export async function nextBackgroundAt(db: PrismaClient, ownerId: string): Promise<number | null> {
  const [row] = await db.$queryRaw<{ at: Date | null }[]>`
    SELECT min(due) AS at FROM (
      SELECT greatest(next_attempt_at,coalesce(lease_until,next_attempt_at)) AS due
        FROM template_jobs WHERE owner_id=${ownerId}::uuid AND phase NOT IN ('succeeded','failed','held')
      UNION ALL SELECT next_attempt_at FROM template_notices
        WHERE owner_id=${ownerId}::uuid AND status IN ('pending','processing')
      UNION ALL SELECT next_attempt_at FROM agent_notification_events
        WHERE owner_id=${ownerId}::uuid AND status IN ('pending','processing')
      UNION ALL SELECT greatest(rotation_next_at,coalesce(rotation_lease_until,rotation_next_at))
        FROM coder_tokens WHERE user_id=${ownerId}::uuid
    ) pending`;
  return row?.at?.getTime() ?? null;
}

async function databaseWork<T>(
  env: BackgroundEnvironment,
  operation: (db: PrismaClient) => Promise<T>,
) {
  assertNativeEnvironment(env);
  const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
    queryTimeoutMillis: 10000,
    transactionTimeoutMillis: 10000,
  });
  try {
    return await database.run(() => operation(getDb()));
  } finally {
    await database.close();
  }
}

/** One owner per invocation, with drained provider operations before pool close. */
export async function dispatchBackground(env: BackgroundEnvironment, ownerId: string) {
  return databaseWork(env, async (db) => {
    const subject = env.VAPID_SUBJECT || env.HIVE_PUBLIC_ORIGIN || "";
    let failed = false;
    // One queue's failure must not starve another queue for the same owner.
    // Each operation is fully drained before continuing or closing this scope.
    const stage = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch {
        failed = true;
      }
    };
    await stage(() =>
      dispatchTemplateJobs(db, env.ASSETS, {
        ownerId,
        limit: 2,
        signal: AbortSignal.timeout(20000),
      }),
    );
    await stage(() =>
      dispatchAgentEvents(
        db,
        (id, payload, signal, deadline) =>
          sendBoundedPush(db, id, payload, subject, signal, deadline),
        { ownerId, limit: 5, sendMs: 10000 },
      ),
    );
    await stage(() =>
      dispatchTemplateNotices(db, subject, {
        ownerId,
        limit: 2,
        signal: AbortSignal.timeout(10000),
      }),
    );
    await stage(() =>
      dispatchLegacyTokenRotation(db, {
        ownerId,
        limit: 1,
        deadline: Date.now() + 15000,
      }),
    );
    if (failed) throw new Error("Background dispatch incomplete");
    return nextBackgroundAt(db, ownerId);
  });
}

/** Hourly repair catches a commit whose enqueue-to-alarm handoff was interrupted. */
export async function repairBackground(env: BackgroundEnvironment) {
  await databaseWork(env, async (db) => {
    let after: string | null = null;
    let failed = false;
    for (let page = 0; page < 100; page++) {
      const owners: { ownerId: string }[] = await db.$queryRaw`
        SELECT DISTINCT owner_id AS "ownerId" FROM (
          SELECT owner_id FROM template_jobs WHERE phase NOT IN ('succeeded','failed','held')
          UNION SELECT owner_id FROM template_notices WHERE status IN ('pending','processing')
          UNION SELECT owner_id FROM agent_notification_events WHERE status IN ('pending','processing')
          UNION SELECT user_id FROM coder_tokens WHERE rotation_next_at<=clock_timestamp()
        ) pending WHERE (${after}::uuid IS NULL OR owner_id>${after}::uuid)
        ORDER BY owner_id LIMIT 50`;
      if (!owners.length) break;
      // Bounded concurrent RPCs. Keep draining the page when a single actor fails.
      const outcomes = await Promise.allSettled(
        owners.map(({ ownerId }) => wakeBackground(env, ownerId)),
      );
      if (outcomes.some((result) => result.status === "rejected")) failed = true;
      after = owners[owners.length - 1].ownerId;
      if (owners.length < 50) break;
    }
    await cleanupTerminalDiagnostics(db);
    if (failed) throw new Error("Background repair incomplete");
  });
}
