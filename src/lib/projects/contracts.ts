import { z } from "zod";

export const projectRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    page: z.number().int().min(1).max(10_000).default(1),
    perPage: z.number().int().min(1).max(100).default(100),
  })
  .strict();

export const repositoryProjectSchema = z
  .object({
    provider: z.literal("github"),
    providerRepositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    nodeId: z.string().regex(/^[A-Za-z0-9_=/+-]{1,256}$/),
    fullName: z.string().max(140),
    name: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .refine((value) => value !== "." && value !== ".."),
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    defaultBranch: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          ![...value].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      ),
    private: z.boolean(),
    archived: z.boolean(),
    htmlUrl: z.string().max(160),
    permissions: z
      .object({
        pull: z.boolean().nullable(),
        push: z.boolean().nullable(),
        admin: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.fullName === `${value.owner}/${value.name}` &&
      value.htmlUrl === `https://github.com/${value.fullName}`,
    "Invalid repository identity",
  );

export const projectPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("github"),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    repositories: z.array(repositoryProjectSchema).max(100),
    page: z.number().int().min(1).max(10_000),
    perPage: z.number().int().min(1).max(100),
    nextPage: z.number().int().min(2).max(10_000).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.repositories.length <= value.perPage &&
      (value.nextPage === null || value.nextPage === value.page + 1) &&
      new Set(value.repositories.map((repository) => repository.providerRepositoryId)).size ===
        value.repositories.length,
    "Invalid repository page",
  );

export const projectErrorCodeSchema = z.enum([
  "invalid_request",
  "unsupported_schema",
  "invalid_page",
  "invalid_page_size",
  "request_too_large",
  "workspace_agent_required",
  "external_auth_timeout",
  "external_auth_invalid_response",
  "external_auth_unavailable",
  "github_auth_required",
  "github_invalid_response",
  "github_invalid_pagination",
  "pagination_limit_reached",
  "github_response_too_large",
  "github_timeout",
  "github_unavailable",
  "github_rate_limited",
  "github_permission_denied",
  "github_redirect_rejected",
  "discovery_unavailable",
  "workspace_forbidden",
  "workspace_unavailable",
  "discovery_disabled",
]);
export type ProjectErrorCode = z.infer<typeof projectErrorCodeSchema>;
export type RepositoryProject = z.infer<typeof repositoryProjectSchema>;
export type ProjectPage = z.infer<typeof projectPageSchema>;

export const projectErrorMessages: Record<ProjectErrorCode, string> = {
  invalid_request: "Invalid project request.",
  unsupported_schema: "Update the workspace project helper.",
  invalid_page: "Invalid project page.",
  invalid_page_size: "Invalid project page size.",
  request_too_large: "Project request is too large.",
  workspace_agent_required: "Use a connected workspace to discover repositories.",
  external_auth_timeout: "GitHub sign-in check timed out. Try again.",
  external_auth_invalid_response: "Could not verify the workspace GitHub connection.",
  external_auth_unavailable: "Could not check the workspace GitHub connection.",
  github_auth_required: "Connect or reconnect GitHub in Coder, then refresh.",
  github_invalid_response: "GitHub returned an invalid repository list.",
  github_invalid_pagination: "GitHub returned invalid pagination. Refresh to try again.",
  pagination_limit_reached: "Repository page limit reached.",
  github_response_too_large: "Repository response is too large. Try a smaller page.",
  github_timeout: "GitHub timed out. Try again.",
  github_unavailable: "Could not load GitHub repositories. Try again.",
  github_rate_limited: "GitHub rate limit reached. Wait before trying again.",
  github_permission_denied: "GitHub access was denied. Check your connection in Coder.",
  github_redirect_rejected: "GitHub returned an unexpected redirect.",
  discovery_unavailable: "Could not discover repositories. Try again.",
  workspace_forbidden: "Select a workspace you own.",
  workspace_unavailable: "Start and connect your workspace, then refresh.",
  discovery_disabled: "Project discovery is not enabled.",
};
