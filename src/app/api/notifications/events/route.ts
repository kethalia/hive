import { createHash } from "node:crypto";
import { getDb } from "@hive/db";
import {
  type AgentEvent,
  agentEventPayload,
  agentEventSchema as eventSchema,
} from "@/lib/push/agent-event-contract";
import { cloudflareAgentEventRoute } from "@/lib/push/agent-events-route";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (process.env.HIVE_RUNTIME_TARGET === "cloudflare") return cloudflareAgentEventRoute(request);
  const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const source = await getDb().notificationSource.findFirst({
    where: { OR: [{ tokenHash }, { pendingTokenHash: tokenHash }] },
  });
  if (!source) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // Hard bound even chunked bodies before parsing.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Missing event" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      return new Response(null, { status: 413 });
    }
    chunks.push(value);
  }
  let event: AgentEvent;
  try {
    event = eventSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return Response.json({ error: "Invalid event" }, { status: 400 });
  }
  const [{ enqueueNotification }, { getRedisConnection }] = await Promise.all([
    import("@/lib/push/event-queue"),
    import("@/lib/queue/connection"),
  ]);
  const redis = getRedisConnection();
  const rateKey = `notification-rate:${source.id}:${Math.floor(Date.now() / 60_000)}`;
  const rate = await redis.incr(rateKey);
  if (rate === 1) await redis.expire(rateKey, 120);
  if (rate > 60) return new Response(null, { status: 429 });
  await enqueueNotification(
    {
      userId: source.userId,
      sourceId: source.id,
      payload: agentEventPayload(source, event),
    },
    event.eventId,
  );
  return Response.json({ accepted: true }, { status: 202 });
}
