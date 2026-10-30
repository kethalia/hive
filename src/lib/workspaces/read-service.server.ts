import { createPrivateKey } from "node:crypto";
import { getDb } from "@hive/db";
import { z } from "zod";
import type { CoderClient } from "@/lib/coder/client";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import {
  type RegistrationPrincipal,
  resolveVerifiedWorkspaceHost,
  type VerifiedHostBinding,
} from "@/lib/codex-session/registration.server";
import { resolveConfiguredProjectsRoot } from "@/lib/git/clone-actions-contract";
import { WorkspaceReadClient, type WorkspaceReadClientConfig } from "./read-client.server";
import {
  type WorkspaceReadData,
  WorkspaceReadError,
  type WorkspaceReadRequest,
  workspaceReadProfileSchema,
  workspaceReadRequestSchema,
} from "./read-contracts";

if (typeof window !== "undefined") throw new Error("Workspace read service is server-only");
const profilePinSchema = z
  .object({
    templateId: z.string().uuid(),
    profile: workspaceReadProfileSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type WorkspaceReadServiceConfig = {
  privateKeyPem: string;
  keyId: string;
  hiveOrigin: string;
  profiles: z.infer<typeof profilePinSchema>[];
  projectsRoot: string;
  cookieDomains: string[];
  home: string;
};
export function workspaceReadServiceConfig(
  env: Record<string, string | undefined> = process.env,
): WorkspaceReadServiceConfig {
  if (env.HIVE_WORKSPACE_READ_ENABLED !== "true") throw new WorkspaceReadError("disabled");
  try {
    const profiles = z
      .array(profilePinSchema)
      .min(1)
      .max(32)
      .parse(JSON.parse(env.HIVE_WORKSPACE_READ_PROFILES_JSON ?? ""));
    if (new Set(profiles.map((p) => p.templateId)).size !== profiles.length) throw new Error();
    const privateKeyPem = env.HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY ?? "",
      keyId = env.HIVE_WORKSPACE_READ_ISSUER_KEY_ID ?? "",
      hiveOrigin = env.HIVE_WORKSPACE_READ_HIVE_ORIGIN ?? "",
      url = new URL(hiveOrigin);
    if (
      createPrivateKey(privateKeyPem).asymmetricKeyType !== "ed25519" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
      url.protocol !== "https:" ||
      url.origin !== hiveOrigin ||
      url.username ||
      url.password
    )
      throw new Error();
    return {
      privateKeyPem,
      keyId,
      hiveOrigin,
      profiles,
      projectsRoot: resolveConfiguredProjectsRoot(),
      cookieDomains: env.COOKIE_DOMAIN ? [env.COOKIE_DOMAIN] : [],
      home: "/home/coder",
    };
  } catch {
    throw new WorkspaceReadError("disabled");
  }
}
type Reader = Pick<
  CoderClient,
  | "getWorkspace"
  | "getWorkspaceResources"
  | "getApplicationsHost"
  | "getBaseUrl"
  | "getApplicationAuthRedirect"
>;
type Dependencies = {
  coderForPrincipal(principal: RegistrationPrincipal, signal: AbortSignal): Promise<Reader>;
  client?(
    config: WorkspaceReadClientConfig,
    coder: Reader,
    binding: VerifiedHostBinding,
  ): Pick<WorkspaceReadClient, "read">;
};
/** No credentials, Coder clients, pending IO or owner authority are cached across requests. */
export class WorkspaceReadService {
  constructor(
    private readonly config: WorkspaceReadServiceConfig,
    private readonly dependencies: Dependencies,
  ) {}
  async read<K extends Exclude<WorkspaceReadRequest["operation"], "identity">>(
    principal: RegistrationPrincipal,
    workspaceId: string,
    raw: Extract<WorkspaceReadRequest, { operation: K }>,
    callerSignal?: AbortSignal,
  ): Promise<WorkspaceReadData<K>> {
    return (await this.readBound(principal, workspaceId, raw, callerSignal)).data;
  }
  async readBound<K extends Exclude<WorkspaceReadRequest["operation"], "identity">>(
    principal: RegistrationPrincipal,
    workspaceId: string,
    raw: Extract<WorkspaceReadRequest, { operation: K }>,
    callerSignal?: AbortSignal,
  ): Promise<{ data: WorkspaceReadData<K>; binding: VerifiedHostBinding }> {
    const request = workspaceReadRequestSchema.parse(raw);
    if (request.operation === "identity") throw new WorkspaceReadError("invalid_response");
    const signal = AbortSignal.any([
      AbortSignal.timeout(25000),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      signal.throwIfAborted();
      const coder = await this.dependencies.coderForPrincipal(principal, signal);
      signal.throwIfAborted();
      const config = {
        hiveOrigin: this.config.hiveOrigin,
        softwareTemplateIds: this.config.profiles.map((p) => p.templateId),
        appSlug: "hive-read",
        gatewayPort: 13342,
        cookieDomains: this.config.cookieDomains,
      };
      const { binding } = await resolveVerifiedWorkspaceHost(
        config,
        async () => coder,
        principal,
        workspaceId,
      );
      signal.throwIfAborted();
      const pin = this.config.profiles.find((p) => p.templateId === binding.templateId);
      if (!pin) throw new WorkspaceReadError("unsupported_workspace");
      if (
        request.operation === "paths" &&
        !["software", "game", "electronics"].includes(pin.profile)
      )
        throw new WorkspaceReadError("unsupported_profile_operation");
      const clientConfig = {
        privateKeyPem: this.config.privateKeyPem,
        keyId: this.config.keyId,
        hiveOrigin: this.config.hiveOrigin,
        profile: pin.profile,
        manifestSha256: pin.manifestSha256,
        projectsRoot: this.config.projectsRoot,
        home: this.config.home,
      };
      const client =
        this.dependencies.client?.(clientConfig, coder, binding) ??
        new WorkspaceReadClient(clientConfig, coder, binding);
      const result = await client.read(raw, signal);
      signal.throwIfAborted();
      // Verify app identity as well as current ownership/build after the read.
      const current = await resolveVerifiedWorkspaceHost(
        config,
        async () => coder,
        principal,
        workspaceId,
        binding.agentId,
      );
      signal.throwIfAborted();
      if (JSON.stringify(current.binding) !== JSON.stringify(binding))
        throw new WorkspaceReadError("workspace_unavailable");
      return { data: result, binding };
    } catch (error) {
      callerSignal?.throwIfAborted();
      if (error instanceof WorkspaceReadError) throw error;
      throw new WorkspaceReadError("workspace_unavailable");
    }
  }
}
export function createWorkspaceReadService(config = workspaceReadServiceConfig()) {
  return new WorkspaceReadService(config, {
    async coderForPrincipal(principal, signal) {
      signal.throwIfAborted();
      const user = await getDb().user.findUnique({
        where: { id: principal.hiveUserId },
        select: { coderUserId: true },
      });
      signal.throwIfAborted();
      if (user?.coderUserId !== principal.coderUserId)
        throw new WorkspaceReadError("workspace_unavailable");
      return getCoderClientForUser(principal.hiveUserId, { signal });
    },
  });
}
