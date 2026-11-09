import { z } from "zod";
import { agentEventSchema } from "./agent-event-contract";

export const AGENT_WAKE_DURATION_MS = 30 * 60 * 1000;
export const AGENT_WAKE_ATTEMPT_MS = 45_000;
export const AGENT_WAKE_REQUEST_LIMIT = 100;
export const agentWakeIdentitySchema = z
  .object({
    ownerId: z.string().uuid(),
    sourceId: z.string().uuid(),
    eventKey: agentEventSchema.shape.eventId,
  })
  .strict();
export type AgentWakeIdentity = z.infer<typeof agentWakeIdentitySchema>;
export const agentWakeReceiptSchema = agentWakeIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    createdAt: z.number().int().nonnegative(),
    deadline: z.number().int().positive(),
    requests: z.number().int().positive(),
    attempts: z.number().int().min(0).max(AGENT_WAKE_REQUEST_LIMIT),
    phase: z.enum(["active", "terminal", "held"]),
    nextWake: z.number().int().nonnegative(),
    inFlightUntil: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (v) =>
      v.deadline === v.createdAt + AGENT_WAKE_DURATION_MS &&
      (v.phase !== "active" || v.requests < AGENT_WAKE_REQUEST_LIMIT),
  );
export type AgentWakeReceipt = z.infer<typeof agentWakeReceiptSchema>;
export type AgentWakeResult = { phase: "retry"; nextWake: number } | { phase: "terminal" | "held" };
export type AgentWakeEnvironment = {
  HIVE_NATIVE_MODE?: string;
  HIVE_NATIVE_PREVIEW_ENABLED?: string;
  HIVE_AGENT_NOTIFICATION_WAKE_ENABLED?: string;
  HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON?: string;
  HIVE_AGENT_NOTIFICATION_WAKE?: {
    getByName(name: string): {
      reserve(identity: AgentWakeIdentity): Promise<AgentWakeReceipt>;
      inspect(identity: AgentWakeIdentity): Promise<AgentWakeReceipt>;
    };
  };
};
export function sameAgentWake(a: AgentWakeIdentity, b: AgentWakeIdentity) {
  return a.ownerId === b.ownerId && a.sourceId === b.sourceId && a.eventKey === b.eventKey;
}
/** The selector remains configured during disablement until PostgreSQL is terminal
 * and unknown producer commits have been reconciled. It continues to fence senders. */
export function agentWakeEnrollment(env: AgentWakeEnvironment) {
  if (env.HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON === undefined) {
    if (env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED === "true") throw Error("agent_wake_unavailable");
    return null;
  }
  if (env.HIVE_NATIVE_MODE !== "preview" || env.HIVE_NATIVE_PREVIEW_ENABLED !== "true")
    throw Error("agent_wake_unavailable");
  return agentWakeIdentitySchema.parse(JSON.parse(env.HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON));
}
export function agentWakeName(identity: AgentWakeIdentity) {
  const value = agentWakeIdentitySchema.parse(identity);
  return `agent-notification/v1/${value.ownerId}/${value.sourceId}/${value.eventKey}`;
}
