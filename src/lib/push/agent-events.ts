import { createHash, randomUUID } from "node:crypto";
import { getConfiguredCoderUrl } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import { publicationAwait } from "@/lib/templates/publication-io";
import { type AgentEvent, agentEventPayload, agentEventSchema } from "./agent-event-contract";
import { agentWakeActive, agentWakeScope, readAgentWake } from "./agent-event-wake.server";
import {
  type AgentWakeIdentity,
  type AgentWakeReceipt,
  sameAgentWake,
} from "./agent-event-wake-contracts";
import {
  claimDurablePush,
  type DurablePushClaim,
  durablePushClaimSchema,
  settleDurablePush,
} from "./durable-outbox";
import type { PushPayload } from "./types";

type Source = {
  id: string;
  ownerId: string;
  workspaceId: string;
  workspaceName: string;
  coderUserId: string;
  coderUrl: string;
};
async function sourceForToken(
  db: Pick<PrismaClient, "$queryRawUnsafe">,
  tokenHash: string,
  lock: boolean,
) {
  const [source] = await db.$queryRawUnsafe<Source[]>(
    `
    SELECT s.id,s.user_id AS "ownerId",s.workspace_id AS "workspaceId",s.workspace_name AS "workspaceName",
      u.coder_user_id AS "coderUserId",u.coder_url AS "coderUrl"
    FROM notification_sources s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 OR s.pending_token_hash=$1 ${lock ? "FOR UPDATE OF s" : ""}`,
    tokenHash,
  );
  return source;
}
async function requireWakeDeadline(
  tx: Pick<PrismaClient, "$queryRaw">,
  receipt: AgentWakeReceipt | null,
) {
  if (!receipt) return;
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!agentWakeActive(receipt, clock.now.getTime())) throw Error("agent_wake_unavailable");
}

export class AgentEventError extends Error {
  constructor(readonly code: "unauthorized" | "rate_limited" | "backlog" | "event_conflict") {
    super(code);
  }
}
export async function acceptAgentEvent(db: PrismaClient, tokenHash: string, input: AgentEvent) {
  const event = agentEventSchema.parse(input),
    origin = getConfiguredCoderUrl();
  const eventDigest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  // Authenticate first, reserve outside the revocable source lock, then recheck
  // that exact source under the original transaction. Nonpilot callbacks do no RPC.
  const enrollment = agentWakeScope();
  let authorized: Source | undefined;
  let receipt: AgentWakeReceipt | null = null;
  if (enrollment?.eventKey === event.eventId) {
    authorized = await sourceForToken(db, tokenHash, false);
    if (!authorized || authorized.coderUrl !== origin) throw new AgentEventError("unauthorized");
    const identity = {
      ownerId: authorized.ownerId,
      sourceId: authorized.id,
      eventKey: event.eventId,
    };
    if (sameAgentWake(enrollment, identity)) {
      receipt = await readAgentWake(identity, true);
      if (!receipt) throw Error("agent_wake_unavailable");
    }
  }
  return db.$transaction(
    async (tx) => {
      // Lock the source used by credential staging/revocation; never trust an owner
      // or workspace from the callback body. Active and pending credentials retain
      // their existing overlap semantics. Revocation cannot resurrect a source.
      const source = await sourceForToken(tx, tokenHash, true);
      if (
        !source ||
        source.coderUrl !== origin ||
        (authorized &&
          Object.keys(authorized).some(
            (key) => authorized?.[key as keyof Source] !== source[key as keyof Source],
          ))
      )
        throw new AgentEventError("unauthorized");
      const existing = await tx.$queryRaw<{ digest: string; status: string }[]>`
      SELECT payload_digest AS digest,status FROM agent_notification_events
      WHERE source_id=${source.id}::uuid AND event_key=${event.eventId}`;
      if (existing[0]) {
        if (existing[0].digest !== eventDigest) throw new AgentEventError("event_conflict");
        if (!["delivered", "failed"].includes(existing[0].status))
          await requireWakeDeadline(tx, receipt);
        return { accepted: true as const };
      }
      await requireWakeDeadline(tx, receipt);
      const [backlog] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM (SELECT id FROM agent_notification_events
       WHERE source_id=${source.id}::uuid AND status IN ('pending','processing') LIMIT 600) bounded`;
      if (Number(backlog.count) >= 600) throw new AgentEventError("backlog");
      const rate = await tx.$queryRaw<{ accepted: number }[]>`
      WITH clock AS MATERIALIZED (SELECT date_trunc('minute',clock_timestamp()) AS minute)
      INSERT INTO agent_notification_rate_windows(source_id,owner_id,window_start,accepted)
      SELECT ${source.id}::uuid,${source.ownerId}::uuid,minute,1 FROM clock
      ON CONFLICT(source_id) DO UPDATE SET
        window_start=EXCLUDED.window_start,
        accepted=CASE WHEN agent_notification_rate_windows.window_start=EXCLUDED.window_start
          THEN agent_notification_rate_windows.accepted+1 ELSE 1 END
      WHERE agent_notification_rate_windows.window_start<>EXCLUDED.window_start OR agent_notification_rate_windows.accepted<60
      RETURNING accepted`;
      if (!rate[0]) throw new AgentEventError("rate_limited");
      const payload = agentEventPayload(
        { ...source, workspaceName: source.workspaceName.slice(0, 200) },
        event,
      );
      await requireWakeDeadline(tx, receipt);
      await tx.$executeRaw`
      INSERT INTO agent_notification_events(id,owner_id,source_id,event_id,event_key,payload,payload_digest,coder_user_id,coder_origin)
      VALUES(${randomUUID()}::uuid,${source.ownerId}::uuid,${source.id}::uuid,${randomUUID()}::uuid,${event.eventId},
        ${JSON.stringify(payload)}::jsonb,${eventDigest},${source.coderUserId}::uuid,${origin})`;
      await requireWakeDeadline(tx, receipt);
      return { accepted: true as const };
    },
    { timeout: 10000, maxWait: 10000 },
  );
}

async function notification(
  db: PrismaClient,
  value: DurablePushClaim,
): Promise<{ payload: PushPayload; sourceId: string; eventKey: string } | null> {
  const c = durablePushClaimSchema.parse(value),
    origin = getConfiguredCoderUrl();
  const [row] = await db.$queryRaw<{ payload: PushPayload; sourceId: string; eventKey: string }[]>`
    SELECT n.payload,n.source_id AS "sourceId",n.event_key AS "eventKey" FROM agent_notification_events n JOIN notification_sources s ON s.id=n.source_id AND s.user_id=n.owner_id
      JOIN users u ON u.id=n.owner_id
    WHERE n.id=${c.id}::uuid AND n.owner_id=${c.ownerId}::uuid AND n.event_id=${c.eventId}::uuid
      AND n.attempts=${c.attempt} AND n.status='processing' AND n.next_attempt_at>clock_timestamp()
      AND n.coder_origin=${origin} AND u.coder_url=n.coder_origin AND u.coder_user_id=n.coder_user_id`;
  return row ?? null;
}

export async function dispatchAgentEvents(
  db: PrismaClient,
  send: (
    ownerId: string,
    payload: PushPayload,
    signal: AbortSignal,
  ) => Promise<"delivered" | "retry" | "failed">,
  options: {
    enabled?: boolean;
    sendMs?: number;
    exact?: AgentWakeIdentity;
    signal?: AbortSignal;
  } = {},
) {
  const counts = { enabled: false, delivered: 0, retry: 0, failed: 0, stale: 0 };
  if (!options.enabled) return counts;
  const ms = options.sendMs ?? 15000;
  if (!Number.isInteger(ms) || ms < 1 || ms > 15000) throw new Error("Invalid sender bound");
  counts.enabled = true;
  options.signal?.throwIfAborted();
  let ownerId: string,
    exactId: string | null = null;
  if (options.exact) {
    const [row] = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM agent_notification_events WHERE owner_id=${options.exact.ownerId}::uuid
        AND source_id=${options.exact.sourceId}::uuid AND event_key=${options.exact.eventKey}`;
    if (!row) return counts;
    ownerId = options.exact.ownerId;
    exactId = row.id;
  } else {
    // Only the ordinary owner-wide dispatcher performs bounded terminal retention.
    await db.$executeRaw`DELETE FROM agent_notification_events WHERE id IN (
      SELECT id FROM agent_notification_events WHERE status IN ('delivered','failed')
        AND created_at<clock_timestamp()-interval '24 hours' ORDER BY created_at,id LIMIT 100)`;
    const [owner] = await db.$queryRaw<{ ownerId: string }[]>`
      SELECT owner_id AS "ownerId" FROM agent_notification_events WHERE status IN ('pending','processing')
        AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT 1`;
    if (!owner) return counts;
    ownerId = owner.ownerId;
  }
  options.signal?.throwIfAborted();
  const [claim] = await claimDurablePush(
    db,
    "agent_notification_events",
    ownerId,
    1,
    120000,
    exactId,
  );
  if (!claim) return counts;
  options.signal?.throwIfAborted();
  const row = await notification(db, claim);
  let permitted = true;
  let unavailable = false;
  if (row) {
    try {
      const receipt = await readAgentWake({
        ownerId: claim.ownerId,
        sourceId: row.sourceId,
        eventKey: row.eventKey,
      });
      permitted = !receipt || agentWakeActive(receipt);
    } catch {
      permitted = false;
      unavailable = true;
    }
  }
  options.signal?.throwIfAborted();
  let result: "delivered" | "retry" | "failed" = unavailable ? "retry" : "failed";
  if (row && permitted) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), ms);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return send(claim.ownerId, row.payload, signal);
    });
    try {
      result = await publicationAwait(work, signal);
    } catch {
      result = "retry";
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Keep the request database alive until the real sender has drained,
      // including late VAPID/subscription reads and expired endpoint deletion.
      await work.catch(() => {});
    }
  }
  options.signal?.throwIfAborted();
  const outcome = result === "retry" && claim.attempt >= 5 ? "failed" : result;
  if (await settleDurablePush(db, "agent_notification_events", claim, outcome)) counts[outcome]++;
  else counts.stale++;
  return counts;
}

export async function exactAgentEventState(db: PrismaClient, identity: AgentWakeIdentity) {
  const [row] = await db.$queryRaw<{ status: string; nextWake: Date; now: Date }[]>`
    SELECT status,next_attempt_at AS "nextWake",clock_timestamp() AS now FROM agent_notification_events
    WHERE owner_id=${identity.ownerId}::uuid AND source_id=${identity.sourceId}::uuid AND event_key=${identity.eventKey}`;
  return row;
}
