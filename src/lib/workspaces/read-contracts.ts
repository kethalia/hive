import { z } from "zod";

export const WORKSPACE_READ_PROFILE_IDS = [
  "software",
  "browser",
  "game",
  "electronics",
  "infrastructure",
] as const;
export const workspaceReadProfileSchema = z.enum(WORKSPACE_READ_PROFILE_IDS);
export type WorkspaceReadProfile = z.infer<typeof workspaceReadProfileSchema>;
export const WORKSPACE_READ_MAX_TICKET_BYTES = 786432;
export const WORKSPACE_READ_MAX_REQUEST_BYTES = 540672;
export const WORKSPACE_READ_MAX_REPLY_BYTES = 131072;
export const WORKSPACE_READ_PAGE_SIZE = 64;
export const WORKSPACE_READ_PATH_BATCH_SIZE = 128;
const session = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._-]+$/);
export const workspaceReadRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("identity") }).strict(),
  z.object({ operation: z.literal("sessions"), cursor: z.string().max(256).optional() }).strict(),
  z.object({ operation: z.literal("directory"), sessionName: session }).strict(),
  z
    .object({
      operation: z.literal("paths"),
      sessionName: session,
      fallbackPath: z.string().min(1).max(4096).optional(),
      paths: z.array(z.string().min(1).max(4096)).max(WORKSPACE_READ_PATH_BATCH_SIZE),
    })
    .strict(),
]);
export type WorkspaceReadRequest = z.infer<typeof workspaceReadRequestSchema>;
export const workspaceReadErrorSchema = z.enum([
  "unsupported_profile_operation",
  "request_too_large",
  "tmux_unavailable",
  "tmux_timeout",
  "too_many_sessions",
  "stale_cursor",
  "invalid_cursor",
  "unsupported_session_name",
  "directory_unavailable",
  "read_unavailable",
]);
export type WorkspaceReadErrorCode = z.infer<typeof workspaceReadErrorSchema>;
const cwd = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (v) =>
      v.startsWith("/") &&
      !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
export const workspaceReadDataSchemas = {
  identity: z
    .object({
      profile: workspaceReadProfileSchema,
      projectsRoot: cwd,
      manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      configDigest: z.string().regex(/^[a-f0-9]{64}$/),
      publicKeyPem: z.string().min(80).max(256),
    })
    .strict(),
  sessions: z
    .object({
      sessions: z
        .array(
          z
            .object({
              name: session,
              created: z.number().int().nonnegative(),
              windows: z.number().int().positive(),
            })
            .strict(),
        )
        .max(WORKSPACE_READ_PAGE_SIZE),
      nextCursor: z.string().max(256).nullable(),
    })
    .strict(),
  directory: z
    .object({
      cwd: cwd.nullable(),
      state: z.enum(["present", "missing_session", "missing_server"]),
    })
    .strict(),
  paths: z
    .object({
      cwd: cwd.nullable(),
      source: z.enum(["tmux", "fallback", "default"]),
      candidates: z
        .array(
          z
            .object({
              index: z.number().int().nonnegative().max(127),
              status: z.enum([
                "file",
                "directory",
                "missing",
                "outside_supported_root",
                "cwd_unavailable",
                "invalid_path",
                "unavailable",
              ]),
            })
            .strict(),
        )
        .max(WORKSPACE_READ_PATH_BATCH_SIZE),
    })
    .strict(),
} as const;
export type WorkspaceReadData<K extends WorkspaceReadRequest["operation"]> = z.infer<
  (typeof workspaceReadDataSchemas)[K]
>;
export const workspaceReadBindingSchema = z
  .object({
    coderOrigin: z.string().url(),
    hiveUserId: z.string().uuid(),
    ownerId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    buildId: z.string().uuid(),
    agentId: z.string().uuid(),
    templateId: z.string().uuid(),
    appOrigin: z.string().url(),
    appId: z.string().uuid(),
  })
  .strict();
export const workspaceReadClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.string().url(),
    scope: z.literal("workspace:read:v1"),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    lifetimeId: z.string().uuid().nullable(),
    profile: workspaceReadProfileSchema,
    binding: workspaceReadBindingSchema,
    request: workspaceReadRequestSchema,
  })
  .strict();
export const workspaceReadEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    lifetimeId: z.string().uuid(),
    operation: z.enum(["identity", "sessions", "directory", "paths"]),
    readOnly: z.literal(true),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
      z.object({ ok: z.literal(false), error: workspaceReadErrorSchema }).strict(),
    ]),
  })
  .strict();
export class WorkspaceReadError extends Error {
  constructor(
    public readonly code:
      | WorkspaceReadErrorCode
      | "disabled"
      | "workspace_unavailable"
      | "unsupported_workspace"
      | "invalid_response",
  ) {
    super(code);
    this.name = "WorkspaceReadError";
  }
}

export function workspaceReadCanonical(value: unknown): string {
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
export const workspaceReadResponsePayload = (value: unknown) =>
  `hive-workspace-read-response-v1\nPOST\n/workspace/read\n${workspaceReadCanonical(value)}`;
