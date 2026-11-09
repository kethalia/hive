import { createHash } from "node:crypto";
import { getDb, type PrismaClient } from "@hive/db";
import { TemplatePublicationError } from "@/lib/templates/publication-contracts";
import { publicationBody } from "@/lib/templates/publication-io";
import { type AgentEvent, agentEventSchema } from "./agent-event-contract";
import { AgentEventError, acceptAgentEvent } from "./agent-events";

const headers = { "Cache-Control": "private, no-store" };
export function agentEventsRoute(deps: { enabled: () => boolean; database: () => PrismaClient }) {
  return async (request: Request) => {
    if (!deps.enabled())
      return Response.json({ error: "events_disabled" }, { status: 404, headers });
    if (request.method !== "POST") return new Response(null, { status: 405, headers });
    const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return new Response(null, { status: 401, headers });
    if (!request.body) return new Response(null, { status: 400, headers });
    let event: AgentEvent;
    try {
      const bytes = await publicationBody(
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
          error instanceof TemplatePublicationError && error.code === "provider_response_limit"
            ? 413
            : 400,
        headers,
      });
    }
    try {
      const accepted = await acceptAgentEvent(
        deps.database(),
        createHash("sha256").update(token).digest("hex"),
        event,
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
  enabled: () => process.env.HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED === "true",
  database: getDb,
});
