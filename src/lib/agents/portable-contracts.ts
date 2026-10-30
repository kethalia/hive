import { z } from "zod";
import { agentResumeResultSchema, agentSessionKeySchema, agentToolsSnapshotSchema } from "./types";

export const agentOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("identity") }).strict(),
  z.object({ operation: z.literal("inventory") }).strict(),
  z.object({ operation: z.literal("sessions") }).strict(),
  z.object({ operation: z.literal("install") }).strict(),
  z.object({ operation: z.literal("disable") }).strict(),
  z.object({ operation: z.literal("configure-coder") }).strict(),
  z.object({ operation: z.literal("resume"), key: agentSessionKeySchema }).strict(),
]);
export type AgentOperation = z.infer<typeof agentOperationSchema>;
export const agentResultSchemas = {
  identity: z
    .object({
      publicKeyPem: z.string().min(80).max(256),
      configDigest: z.string().regex(/^[a-f0-9]{64}$/),
      manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      environment: z
        .object({
          CODEX_HOME: z.string().min(1).max(4096).optional(),
          CLAUDE_CONFIG_DIR: z.string().min(1).max(4096).optional(),
        })
        .strict(),
    })
    .strict(),
  inventory: agentToolsSnapshotSchema.omit({ sessions: true, checkedAt: true }),
  sessions: agentToolsSnapshotSchema.pick({ sessions: true, checkedAt: true }),
  install: z.object({ message: z.string().max(200) }).strict(),
  disable: z.object({ message: z.string().max(200) }).strict(),
  "configure-coder": z.object({ message: z.string().max(200) }).strict(),
  resume: agentResumeResultSchema,
} as const;
export type AgentOperationResult<K extends AgentOperation["operation"]> = z.infer<
  (typeof agentResultSchemas)[K]
>;
export const agentBridgeBindingSchema = z
  .object({
    coderOrigin: z.string().url(),
    ownerId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    buildId: z.string().uuid(),
    agentId: z.string().uuid(),
    templateId: z.string().uuid(),
    appOrigin: z.string().url(),
    appId: z.string().uuid(),
  })
  .strict();
export type AgentBridgeBinding = z.infer<typeof agentBridgeBindingSchema>;
export const agentReplySchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    lifetimeId: z.string().uuid(),
    operation: z.enum([
      "identity",
      "inventory",
      "sessions",
      "install",
      "disable",
      "configure-coder",
      "resume",
    ]),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
      z.object({ ok: z.literal(false), error: z.literal("agent_operation_failed") }).strict(),
    ]),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export function agentCanonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return JSON.stringify(sorted(value));
}
export const agentProofPayload = (value: unknown) =>
  `hive-agent-response-v1\nPOST\n/agent/operation\n${agentCanonical(value)}`;
