import { z } from "zod";

// Deliberate display subset of `codex app-server generate-ts --experimental`
// from 0.165.0. Unknown items remain visible placeholders, never guessed transcripts.
const id = z.string().min(1).max(200);
const text = z.string().max(1_000_000);
const itemIdentity = z.object({ id, type: z.string().min(1).max(100) });
const textItem = itemIdentity.extend({ text });
const userItem = itemIdentity.extend({
  content: z.array(z.object({ type: z.string(), text: text.optional() })).max(1000),
});
const commandItem = itemIdentity.extend({
  command: text,
  aggregatedOutput: text.nullable(),
  status: z.string(),
  exitCode: z.number().nullable(),
});

export type SessionItem = {
  id: string;
  type: string;
  text?: string;
  content?: { type: string; text?: string }[];
  command?: string;
  aggregatedOutput?: string | null;
  status?: string;
  exitCode?: number | null;
  unsupported?: boolean;
};

export const itemSchema = z.unknown().transform((value): SessionItem => {
  const identity = itemIdentity.parse(value);
  switch (identity.type) {
    case "agentMessage":
    case "plan":
      return textItem.parse(value);
    case "userMessage":
      return userItem.parse(value);
    case "commandExecution":
      return commandItem.parse(value);
    default:
      // In particular, do not retain hidden reasoning or arbitrary tool arguments.
      return { ...identity, unsupported: true };
  }
});

export const turnSchema = z.object({
  id,
  items: z.array(itemSchema).max(1000),
  itemsView: z.enum(["full", "summary", "notLoaded"]),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
});
export type SessionTurn = z.infer<typeof turnSchema>;

export const pageSchema = z.object({
  data: z.array(turnSchema).max(100),
  nextCursor: z.string().nullable(),
});
export const resumeSchema = z.object({ thread: z.object({ id }) });

const notification = z.object({ method: z.string(), params: z.record(z.unknown()) });
const scoped = z.object({ threadId: id });
const turnEvent = scoped.extend({ turn: turnSchema });
const itemEvent = scoped.extend({ turnId: id, item: itemSchema });
const deltaEvent = scoped.extend({ turnId: id, itemId: id, delta: text });

export type SessionEvent =
  | { kind: "turn"; threadId: string; turn: SessionTurn; complete: boolean }
  | { kind: "item"; threadId: string; turnId: string; item: SessionItem; complete: boolean }
  | {
      kind: "delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
      field: "text" | "aggregatedOutput";
    }
  | { kind: "invalidate"; threadId: string };

export function parseSessionEvent(raw: unknown, threadId: string): SessionEvent | null {
  const event = notification.parse(raw);
  // Global server notifications and other threads cannot mutate this projection.
  if (event.params.threadId !== threadId) return null;
  switch (event.method) {
    case "turn/started":
    case "turn/completed":
      return {
        kind: "turn",
        ...turnEvent.parse(event.params),
        complete: event.method === "turn/completed",
      };
    case "item/started":
    case "item/completed":
      return {
        kind: "item",
        ...itemEvent.parse(event.params),
        complete: event.method === "item/completed",
      };
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
      return {
        kind: "delta",
        ...deltaEvent.parse(event.params),
        field: event.method === "item/agentMessage/delta" ? "text" : "aggregatedOutput",
      };
    case "thread/reverted":
    case "thread/archived":
    case "thread/deleted":
    case "thread/closed":
      return { kind: "invalidate", ...scoped.parse(event.params) };
    default:
      return null;
  }
}
