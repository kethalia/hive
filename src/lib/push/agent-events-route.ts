import { createHash } from "node:crypto";
import { getDb, type PrismaClient } from "@hive/db";
import { wakeCloudflareBackground } from "@/lib/queue/background-wake.server";
import { terminalBody } from "@/lib/terminal/transport-io";
import { type AgentEvent, agentEventSchema } from "./agent-event-contract";
import { AgentEventError, acceptAgentEvent } from "./agent-events";

const headers = { "Cache-Control": "private, no-store" };
export function agentEventsRoute(deps: {
  enabled: () => boolean;
  database: () => PrismaClient;
  wake?: (ownerId: string) => Promise<void>;
}) {
  return async (request: Request) => {
    if (!deps.enabled())
      return Response.json({ error: "events_disabled" }, { status: 404, headers });
    if (request.method !== "POST") return new Response(null, { status: 405, headers });
    const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return new Response(null, { status: 401, headers });
    if (!request.body) return new Response(null, { status: 400, headers });
    let event: AgentEvent;
    try {
      const bytes = await terminalBody(
        new Response(request.body),
        4096,
        AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
      );
      event = agentEventSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch (error) {
      return new Response(null, {
        status:
          error instanceof Error && error.message === "Terminal response limit reached" ? 413 : 400,
        headers,
      });
    }
    try {
      const accepted = await acceptAgentEvent(
        deps.database(),
        createHash("sha256").update(token).digest("hex"),
        event,
        deps.wake,
      );
      return Response.json(accepted, { status: 202, headers });
    } catch (error) {
      const status =
        error instanceof AgentEventError
          ? ({ unauthorized: 401, rate_limited: 429, backlog: 429, event_conflict: 409 } as const)[
              error.code
            ]
          : 503;
      return Response.json(
        { error: status === 503 ? "events_unavailable" : "event_rejected" },
        { status, headers },
      );
    }
  };
}
export const cloudflareAgentEventRoute = agentEventsRoute({
  enabled: () => true,
  database: getDb,
  wake: wakeCloudflareBackground,
});
