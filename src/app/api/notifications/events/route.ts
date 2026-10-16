import { createHash } from "node:crypto";
import { getDb } from "@hive/db";
import { z } from "zod";
import { enqueueNotification } from "@/lib/push/event-queue";
import { notificationLabels } from "@/lib/push/types";
import { getRedisConnection } from "@/lib/queue/connection";

export const runtime = "nodejs";
const eventSchema = z.object({
  eventId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  kind: z.enum(["question", "approval", "ready", "failure"]),
  agent: z.enum(["codex", "claude"]),
  sessionName: z.string().max(200).default(""),
  projectName: z.string().max(200).default(""),
});
export async function POST(request: Request) {
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
  let event: z.infer<typeof eventSchema>;
  try {
    event = eventSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return Response.json({ error: "Invalid event" }, { status: 400 });
  }
  const redis = getRedisConnection();
  const rateKey = `notification-rate:${source.id}:${Math.floor(Date.now() / 60_000)}`;
  const rate = await redis.incr(rateKey);
  if (rate === 1) await redis.expire(rateKey, 120);
  if (rate > 60) return new Response(null, { status: 429 });
  const url = new URL(
    `/workspaces/${encodeURIComponent(source.workspaceId)}/terminal/workspace`,
    "https://hive.local",
  );
  if (event.sessionName) {
    url.pathname = `/workspaces/${encodeURIComponent(source.workspaceId)}/terminal`;
    url.searchParams.set("session", event.sessionName);
    url.searchParams.set("notification", event.eventId);
  }
  const project = event.projectName.replace(/\s+/g, " ").trim();
  // Clone session IDs are routing identifiers, not useful notification labels.
  const session = /^git-clone-[a-f0-9]{32}$/.test(event.sessionName)
    ? ""
    : event.sessionName.replace(/\s+/g, " ").trim();
  const location =
    project && session && project !== session ? `${project} (${session})` : project || session;
  const agent = event.agent === "codex" ? "Codex" : "Claude Code";
  const message = {
    question: "has a question for you",
    approval: "is waiting for your approval",
    ready: "has finished its turn",
    failure: "stopped because of an error",
  }[event.kind];
  await enqueueNotification(
    {
      userId: source.userId,
      sourceId: source.id,
      payload: {
        kind: event.kind,
        title: notificationLabels[event.kind],
        body: `${agent} ${message}${location ? ` in ${location}` : ""} on ${source.workspaceName}.`,
        tag: `hive-${source.id}-${event.eventId}`,
        url: url.pathname + url.search,
      },
    },
    event.eventId,
  );
  return Response.json({ accepted: true }, { status: 202 });
}
