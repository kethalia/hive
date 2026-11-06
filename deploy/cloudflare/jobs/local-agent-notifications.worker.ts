// Local-only proof harness. Never deploy this entrypoint or expose its fixture capability.
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { neonConfig } from "../../../packages/db/node_modules/@neondatabase/serverless/index.mjs";
import { POST as actualAgentEventPOST } from "../../../src/app/api/notifications/events/route";
import { agentEventsRoute } from "../../../src/lib/push/agent-events-route";
import { runRequestLifetime } from "../app/request-lifetime";
import { dispatchScheduled } from "./worker";

type Environment = {
  DATABASE_URL: string;
  WS_PORT: string;
  LOCAL_PROOF_BEARER: string;
  CODER_URL: string;
};
export default {
  async fetch(
    request: Request,
    env: Environment,
    ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void },
  ) {
    if (
      new URL(request.url).pathname !== "/__local-agent-notifications" ||
      request.method !== "POST" ||
      request.headers.get("Authorization") !== `Bearer ${env.LOCAL_PROOF_BEARER}`
    )
      return new Response(null, { status: 404 });
    const url = new URL(env.DATABASE_URL);
    if (
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/hive_agent_notification_test" ||
      !/^\d+$/.test(env.WS_PORT)
    )
      return new Response(null, { status: 404 });
    neonConfig.wsProxy = () => `127.0.0.1:${env.WS_PORT}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineConnect = false;
    neonConfig.pipelineTLS = false;
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
      queryTimeoutMillis: 10000,
      transactionTimeoutMillis: 10000,
    });
    return runRequestLifetime(database, ctx, async () => {
      const db = getDb(),
        checks: Record<string, boolean> = {};
      const ownerId = randomUUID(),
        sourceId = randomUUID(),
        workspaceId = randomUUID(),
        token = "d".repeat(64);
      let stage = "fixture";
      const requireProof = (value: unknown, label: string) => {
        stage = label;
        if (!value) throw new Error(label);
        checks[label] = true;
      };
      try {
        const [existing] = await db.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM agent_notification_events`;
        requireProof(Number(existing.count) === 0, "empty_local_event_fixture");
        const disabled = agentEventsRoute({
          enabled: () => false,
          database: () => {
            throw new Error("disabled_db_access");
          },
        });
        requireProof(
          (
            await disabled(
              new Request("https://hive.invalid/api/notifications/events", { method: "POST" }),
            )
          ).status === 404,
          "default_off_ingress",
        );
        requireProof((await dispatchScheduled({})).enabled === false, "default_off_jobs");
        await db.user.create({
          data: {
            id: ownerId,
            coderUserId: randomUUID(),
            coderUrl: env.CODER_URL,
            username: "local-agent-proof",
            email: `${ownerId}@example.invalid`,
          },
        });
        await db.notificationSource.create({
          data: {
            id: sourceId,
            userId: ownerId,
            workspaceId,
            workspaceName: "workerd-proof",
            tokenHash: createHash("sha256").update(token).digest("hex"),
          },
        });
        const route = actualAgentEventPOST;
        const input = {
          eventId: "workerd-event",
          kind: "question",
          agent: "claude",
          projectName: "owner/repo",
          sessionName: "native-main",
          userId: randomUUID(),
        };
        const call = (body: unknown = input, credential = token) =>
          route(
            new Request("https://hive.invalid/api/notifications/events", {
              method: "POST",
              headers: { Authorization: `Bearer ${credential}` },
              body: JSON.stringify(body),
            }),
          );
        requireProof((await call()).status === 202, "actual_workerd_transaction_acceptance");
        requireProof((await call()).status === 202, "durable_replay");
        const [row] = await db.$queryRaw<
          { ownerId: string; payload: { kind: string; tag: string; url: string } }[]
        >`SELECT owner_id AS "ownerId",payload FROM agent_notification_events WHERE source_id=${sourceId}::uuid`;
        requireProof(
          row.ownerId === ownerId &&
            row.payload.kind === "question" &&
            row.payload.tag === `hive-${sourceId}-workerd-event` &&
            row.payload.url.includes(workspaceId),
          "owner_and_payload_binding",
        );
        const [rate] = await db.$queryRaw<
          { accepted: number }[]
        >`SELECT accepted FROM agent_notification_rate_windows WHERE source_id=${sourceId}::uuid`;
        requireProof(rate.accepted === 1, "duplicate_does_not_consume_rate");
        requireProof(
          (await call({ ...input, kind: "ready" })).status === 409,
          "immutable_event_conflict",
        );
        requireProof((await call(input, "a".repeat(64))).status === 401, "unknown_source_rejected");
        // Actual jobs and shared sender, with zero subscriptions. No provider send is
        // performed; this proves local composition and absence-of-recipient handling.
        const result = await dispatchScheduled({
          DATABASE_URL: env.DATABASE_URL,
          HIVE_AGENT_NOTIFICATION_DISPATCH_ENABLED: "true",
        });
        requireProof(
          result.enabled &&
            "agentNotifications" in result &&
            result.agentNotifications?.delivered === 1,
          "actual_jobs_dispatch_without_subscriptions",
        );
        const [settled] = await db.$queryRaw<
          { status: string; attempts: number }[]
        >`SELECT status,attempts FROM agent_notification_events WHERE source_id=${sourceId}::uuid`;
        requireProof(
          settled.status === "delivered" && settled.attempts === 1,
          "durable_acknowledgment",
        );
        await db.notificationSource.delete({ where: { id: sourceId } });
        requireProof((await call()).status === 401, "revoked_source_rejected");
        return Response.json({
          passed: true,
          checks,
          scope:
            "actual local Workerd route + full PrismaNeon PostgreSQL + actual jobs/shared sender, no subscriptions or provider delivery",
        });
      } catch {
        return Response.json({ passed: false, stage, checks }, { status: 500 });
      } finally {
        await db.notificationSource.deleteMany({ where: { id: sourceId, userId: ownerId } });
        await db.user.deleteMany({ where: { id: ownerId } });
      }
    });
  },
};
