import { z } from "zod";

export const agentNameSchema = z.enum(["codex", "claude"]);
export const agentSessionKeySchema = z
  .string()
  .regex(/^(codex|claude)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const agentInventorySchema = z.object({
  agent: agentNameSchema,
  installed: z.boolean(),
  version: z.string().max(80).nullable(),
  auth: z.enum(["signed-in", "signed-out", "unknown"]),
  tracking: z.boolean(),
  connections: z
    .array(z.object({ name: z.string().max(160), enabled: z.boolean(), auth: z.string().max(160) }))
    .max(200),
  plugins: z.array(z.object({ name: z.string().max(160), enabled: z.boolean() })).max(100),
  warnings: z.array(z.string().max(200)).max(10),
});
export const agentSessionSchema = z.object({
  key: agentSessionKeySchema,
  agent: agentNameSchema,
  id: z.string().uuid(),
  directory: z.string().max(4096),
  project: z.string().max(160),
  updatedAt: z.number().int().nonnegative(),
  state: z.enum([
    "ready",
    "working",
    "needs-input",
    "needs-approval",
    "interrupted",
    "ended",
    "failed",
    "offline",
  ]),
  running: z.boolean(),
  directoryExists: z.boolean(),
});
export const agentToolsSnapshotSchema = z.object({
  profile: z.string().max(160),
  agents: z.array(agentInventorySchema).max(2),
  sessions: z.array(agentSessionSchema).max(200),
  coderMcpSupported: z.boolean(),
  typescriptServerInstalled: z.boolean(),
  checkedAt: z.number().int().nonnegative(),
});
export const agentResumeResultSchema = z.object({
  sessionName: z.string().regex(/^[a-zA-Z0-9._-]{1,200}$/),
});
export type AgentToolsSnapshot = z.infer<typeof agentToolsSnapshotSchema>;
export type AgentSession = z.infer<typeof agentSessionSchema>;
export const agentLabels = { codex: "Codex", claude: "Claude Code" } as const;
