import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { withAgentWakeEnvironment } from "../../../src/lib/push/agent-event-wake.server";
import {
  type AgentWakeEnvironment,
  type AgentWakeReceipt,
  type AgentWakeResult,
  agentWakeEnrollment,
  sameAgentWake,
} from "../../../src/lib/push/agent-event-wake-contracts";
import { dispatchAgentEvents, exactAgentEventState } from "../../../src/lib/push/agent-events";
import { sendBoundedPush } from "../../../src/lib/push/bounded-send";

/** Internal same-Worker call. PostgreSQL alone holds payload and delivery leases. */
export async function runExactAgentNotificationWake(
  env: AgentWakeEnvironment & {
    DATABASE_URL?: string;
    HIVE_AGENT_NOTIFICATION_DISPATCH_ENABLED?: string;
    VAPID_SUBJECT?: string;
    HIVE_PUBLIC_ORIGIN?: string;
  },
  receipt: AgentWakeReceipt,
): Promise<AgentWakeResult> {
  const enrolled = agentWakeEnrollment(env);
  if (
    !enrolled ||
    !sameAgentWake(enrolled, receipt) ||
    env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED !== "true" ||
    env.HIVE_AGENT_NOTIFICATION_DISPATCH_ENABLED !== "true"
  )
    return { phase: "held" };
  const deadline = Math.min(receipt.deadline, receipt.inFlightUntil);
  if (receipt.phase !== "active" || deadline <= Date.now()) return { phase: "held" };
  const signal = AbortSignal.timeout(deadline - Date.now());
  const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
    queryTimeoutMillis: 5000,
    transactionTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });
  return withAgentWakeEnvironment(env, () =>
    database.run(async () => {
      try {
        const db = getDb();
        signal.throwIfAborted();
        await dispatchAgentEvents(
          db,
          (ownerId, payload, signal, deadline) =>
            sendBoundedPush(
              db,
              ownerId,
              payload,
              env.VAPID_SUBJECT?.trim() || env.HIVE_PUBLIC_ORIGIN?.trim() || "",
              signal,
              deadline,
            ),
          { enabled: true, exact: receipt, signal },
        );
        signal.throwIfAborted();
        const row = await exactAgentEventState(db, receipt);
        if (row && ["delivered", "failed"].includes(row.status)) return { phase: "terminal" };
        // Missing rows include unknown producer commits. Retain the original fixed
        // reservation and deadline, never create a second enrollment or refresh it.
        return {
          phase: "retry",
          nextWake: Math.max(Date.now() + 1000, row?.nextWake.getTime() ?? Date.now() + 10000),
        };
      } finally {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            database.close(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(Error("agent_wake_cleanup_unavailable")), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    }),
  );
}
