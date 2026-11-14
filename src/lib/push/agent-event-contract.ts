import { z } from "zod";
import { notificationLabels, type PushPayload } from "./types";

export const agentEventSchema = z.object({
  eventId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  kind: z.enum(["question", "approval", "ready", "failure"]),
  agent: z.enum(["codex", "claude"]),
  sessionName: z.string().max(200).default(""),
  projectName: z.string().max(200).default(""),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;
export function agentEventPayload(
  source: { id: string; workspaceId: string; workspaceName: string },
  event: AgentEvent,
): PushPayload {
  const url = new URL("/workspaces", "https://hive.local");
  url.searchParams.set("workspace", source.workspaceId);
  if (event.sessionName) {
    url.searchParams.set("session", event.sessionName);
    url.searchParams.set("notification", event.eventId);
  }
  const project = event.projectName.replace(/\s+/g, " ").trim();
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
  return {
    kind: event.kind,
    title: notificationLabels[event.kind],
    body: `${agent} ${message}${location ? ` in ${location}` : ""} on ${source.workspaceName}.`,
    tag: `hive-${source.id}-${event.eventId}`,
    url: url.pathname + url.search,
  };
}
