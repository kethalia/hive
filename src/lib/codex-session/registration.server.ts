// Server-only: no route, provisioner, or persistence fallback is installed here.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type { CoderClient } from "@/lib/coder/client";
import { assertWorkspaceAppIsolated } from "@/lib/security/workspace-app-isolation";

if (typeof window !== "undefined") throw new Error("Workspace registration is server-only.");
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function requireValue(value: unknown, reason = "Workspace registration rejected."): asserts value {
  if (!value) throw new Error(reason);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function origin(value: string) {
  const url = new URL(value);
  requireValue(
    url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.hostname.includes("*"),
  );
  return url;
}
export type RegistrationPrincipal = { hiveUserId: string; coderUserId: string };
export type RegistrationProject = { projectId: string; repositoryId: string };
export type RegistrationBinding = {
  coderOrigin: string;
  hiveUserId: string;
  ownerId: string;
  workspaceId: string;
  buildId: string;
  agentId: string;
  templateId: string;
  appOrigin: string;
  appId: string;
  projects: RegistrationProject[];
};
export type HostRegistration = {
  binding: RegistrationBinding;
  serverInstanceId: string;
  protocolVersion: "0.165.0";
  threads: Array<RegistrationProject & { threadId: string }>;
  hostPublicKeyPem: string;
  generation: number;
  registeredAt: number;
  expiresAt: number;
};
/** Mandatory durable implementation. reserve advances a per-owner/workspace/agent
 * generation. consumeAndRegister MUST atomically verify pending nonce/digest/expiry,
 * latest generation and binding, consume once, replace that agent's registration,
 * and revoke its previous server lifetime. No in-memory production fallback exists.
 */
export interface RegistrationStore {
  reserve(value: {
    grantId: string;
    binding: RegistrationBinding;
    expiresAt: number;
  }): Promise<number>;
  seal(value: { grantId: string; generation: number; grantDigest: string }): Promise<void>;
  consumeAndRegister(value: {
    grantId: string;
    grantDigest: string;
    expiresAt: number;
    now: number;
    registration: HostRegistration;
  }): Promise<boolean>;
}
type CoderReader = Pick<
  CoderClient,
  "getWorkspace" | "getWorkspaceResources" | "getApplicationsHost" | "getBaseUrl"
>;
export type RegistrationDependencies = {
  // Server-authenticated principal and Coder client; never supplied by host JSON.
  coderForPrincipal(principal: RegistrationPrincipal): Promise<CoderReader>;
  authorizedProjects(
    principal: RegistrationPrincipal,
    workspaceId: string,
    requestedProjectIds: string[],
  ): Promise<RegistrationProject[]>;
  store: RegistrationStore;
  now?: () => number;
};
type Config = {
  privateKeyPem: string;
  keyId: string;
  hiveOrigin: string;
  softwareTemplateIds: string[];
  appSlug: string;
  gatewayPort: number;
  cookieDomains: string[];
};
type Claims = {
  iss: string;
  aud: string;
  scope: "workspace:register";
  jti: string;
  iat: number;
  exp: number;
  generation: number;
  binding: RegistrationBinding;
};
export type RegistrationRequest = {
  grant: string;
  serverInstanceId: string;
  protocolVersion: "0.165.0";
  threads: HostRegistration["threads"];
  hostPublicKeyPem: string;
  proof: string;
};
function projects(value: RegistrationProject[]) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 32);
  const ids = new Set<string>();
  const repos = new Set<string>();
  for (const p of value) {
    requireValue(
      exact(p, ["projectId", "repositoryId"]) &&
        identifier(p.projectId) &&
        typeof p.repositoryId === "string" &&
        /^[1-9][0-9]{0,19}$/.test(p.repositoryId) &&
        !ids.has(p.projectId) &&
        !repos.has(p.repositoryId),
    );
    ids.add(p.projectId);
    repos.add(p.repositoryId);
  }
  return value
    .map((p) => ({ projectId: p.projectId, repositoryId: p.repositoryId }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
}
export function registrationProofPayload(request: Omit<RegistrationRequest, "proof">): string {
  return `hive-registration-v1\n${digest(request.grant)}\n${JSON.stringify({ serverInstanceId: request.serverInstanceId, protocolVersion: request.protocolVersion, threads: request.threads, hostPublicKeyPem: request.hostPublicKeyPem })}`;
}
export type VerifiedHostBinding = Omit<RegistrationBinding, "projects">;
export type VerifiedHostConfig = Pick<
  Config,
  "hiveOrigin" | "softwareTemplateIds" | "appSlug" | "gatewayPort" | "cookieDomains"
>;
/** Shared fresh Coder authority resolution. No project enrollment or native thread
 * is needed for discovery. Ambiguous matching connected agents fail closed. */
export async function resolveVerifiedWorkspaceHost(
  config: VerifiedHostConfig,
  coderForPrincipal: RegistrationDependencies["coderForPrincipal"],
  principal: RegistrationPrincipal,
  workspaceId: string,
  agentId?: string,
): Promise<{ coder: CoderReader; binding: VerifiedHostBinding }> {
  requireValue(
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.appSlug) &&
      config.softwareTemplateIds.length > 0 &&
      config.softwareTemplateIds.every(identifier) &&
      Number.isInteger(config.gatewayPort) &&
      config.gatewayPort > 0 &&
      config.gatewayPort <= 65535,
  );
  origin(config.hiveOrigin);
  requireValue(
    identifier(principal.hiveUserId) &&
      identifier(principal.coderUserId) &&
      identifier(workspaceId) &&
      (agentId === undefined || identifier(agentId)),
  );
  const coder = await coderForPrincipal(principal);
  const coderOrigin = origin(coder.getBaseUrl()).origin;
  const workspace = await coder.getWorkspace(workspaceId);
  requireValue(
    workspace.id === workspaceId &&
      workspace.owner_id === principal.coderUserId &&
      workspace.latest_build.status === "running" &&
      config.softwareTemplateIds.includes(workspace.template_id),
  );
  const resources = await coder.getWorkspaceResources(workspaceId, workspace.latest_build.id);
  const agents = resources
    .flatMap((resource) => resource.agents ?? [])
    .filter((agent) => {
      if (agent.status !== "connected" || (agentId !== undefined && agent.id !== agentId))
        return false;
      const apps: unknown = (agent as unknown as { apps?: unknown }).apps;
      return (
        Array.isArray(apps) &&
        apps.some(
          (app) =>
            app &&
            app.slug === config.appSlug &&
            app.sharing_level === "owner" &&
            app.subdomain === true &&
            app.external === false,
        )
      );
    });
  requireValue(agents.length === 1);
  // Coder's full WorkspaceAgent response carries apps. Current local SDK type
  // omits it; absence fails closed, never replaced with caller app metadata.
  const apps: unknown = (agents[0] as unknown as { apps?: unknown }).apps;
  requireValue(Array.isArray(apps));
  const matches = apps.filter(
    (app) =>
      app &&
      app.slug === config.appSlug &&
      app.sharing_level === "owner" &&
      app.subdomain === true &&
      app.external === false,
  );
  requireValue(matches.length === 1);
  requireValue(identifier(matches[0].id) && typeof matches[0].url === "string");
  const appTarget = new URL(matches[0].url);
  requireValue(
    appTarget.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(appTarget.hostname) &&
      Number(appTarget.port) === config.gatewayPort &&
      appTarget.pathname === "/" &&
      !appTarget.search &&
      !appTarget.hash &&
      !appTarget.username &&
      !appTarget.password,
  );
  const parts = [config.appSlug, agents[0].name, workspace.name, workspace.owner_name];
  requireValue(parts.every((part) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(part)));
  const label = parts.join("--");
  requireValue(label.length <= 63);
  const host = await coder.getApplicationsHost();
  requireValue(typeof host === "string" && (host.match(/\*/g) ?? []).length === 1);
  const appUrl = new URL(
    host.includes("://") ? host.replace("*", label) : `https://${host.replace("*", label)}`,
  );
  requireValue(
    appUrl.protocol === "https:" &&
      appUrl.pathname === "/" &&
      !appUrl.search &&
      !appUrl.hash &&
      appUrl.hostname.split(".")[0] === label,
  );
  origin(appUrl.origin);
  assertWorkspaceAppIsolated(
    appUrl.origin,
    origin(config.hiveOrigin).hostname,
    config.cookieDomains,
  );
  const fresh = await coder.getWorkspace(workspaceId);
  requireValue(
    fresh.id === workspace.id &&
      fresh.owner_id === workspace.owner_id &&
      fresh.latest_build.id === workspace.latest_build.id &&
      fresh.latest_build.status === "running" &&
      fresh.template_id === workspace.template_id,
  );
  return {
    coder,
    binding: {
      coderOrigin,
      hiveUserId: principal.hiveUserId,
      ownerId: principal.coderUserId,
      workspaceId,
      buildId: workspace.latest_build.id,
      agentId: agents[0].id,
      templateId: workspace.template_id,
      appOrigin: appUrl.origin,
      appId: matches[0].id,
    },
  };
}
export class WorkspaceRegistrationAuthority {
  private key;
  private publicKey;
  private now;
  constructor(
    private readonly config: Config,
    private readonly dependencies: RegistrationDependencies,
  ) {
    origin(config.hiveOrigin);
    requireValue(
      identifier(config.keyId) &&
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.appSlug) &&
        config.softwareTemplateIds.length > 0 &&
        config.softwareTemplateIds.every(identifier),
    );
    requireValue(
      Number.isInteger(config.gatewayPort) && config.gatewayPort > 0 && config.gatewayPort <= 65535,
    );
    requireValue(
      dependencies.store &&
        typeof dependencies.coderForPrincipal === "function" &&
        typeof dependencies.authorizedProjects === "function",
    );
    this.key = createPrivateKey(config.privateKeyPem);
    requireValue(this.key.asymmetricKeyType === "ed25519");
    this.publicKey = createPublicKey(this.key);
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }
  private async resolve(
    principal: RegistrationPrincipal,
    workspaceId: string,
    agentId: string,
    requestedProjectIds: string[],
  ): Promise<RegistrationBinding> {
    requireValue(
      Array.isArray(requestedProjectIds) &&
        requestedProjectIds.length > 0 &&
        requestedProjectIds.length <= 32 &&
        requestedProjectIds.every(identifier) &&
        new Set(requestedProjectIds).size === requestedProjectIds.length,
    );
    const { binding } = await resolveVerifiedWorkspaceHost(
      this.config,
      this.dependencies.coderForPrincipal,
      principal,
      workspaceId,
      agentId,
    );
    const authorized = projects(
      await this.dependencies.authorizedProjects(principal, workspaceId, requestedProjectIds),
    );
    requireValue(
      authorized.length === requestedProjectIds.length &&
        authorized.every((p) => requestedProjectIds.includes(p.projectId)),
    );
    return { ...binding, projects: authorized };
  }
  /** Fresh Coder owner/build/app validation before heartbeat or read issuance. */
  async reauthorize(binding: RegistrationBinding) {
    const fresh = await this.resolve(
      { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId },
      binding.workspaceId,
      binding.agentId,
      projects(binding.projects).map((p) => p.projectId),
    );
    const canonical = (b: RegistrationBinding) =>
      JSON.stringify([
        b.coderOrigin,
        b.hiveUserId,
        b.ownerId,
        b.workspaceId,
        b.buildId,
        b.agentId,
        b.templateId,
        b.appOrigin,
        b.appId,
        b.projects.map((p) => [p.projectId, p.repositoryId]).sort(),
      ]);
    requireValue(canonical(fresh) === canonical(binding), "Coder authority changed.");
    return fresh;
  }
  /** Called by trusted provisioner/session controller; never return grant to the browser. */
  async issue(
    principal: RegistrationPrincipal,
    workspaceId: string,
    agentId: string,
    requestedProjectIds: string[],
    ttlSeconds = 60,
  ) {
    requireValue(Number.isInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= 60);
    const binding = await this.resolve(principal, workspaceId, agentId, requestedProjectIds);
    const iat = this.now();
    const exp = iat + ttlSeconds;
    const jti = randomUUID();
    const generation = await this.dependencies.store.reserve({
      grantId: jti,
      binding,
      expiresAt: exp,
    });
    requireValue(Number.isSafeInteger(generation) && generation > 0);
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.config.keyId }),
    ).toString("base64url");
    const claims: Claims = {
      iss: this.config.hiveOrigin,
      aud: "hive:workspace-registration",
      scope: "workspace:register",
      jti,
      iat,
      exp,
      generation,
      binding,
    };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const grant = `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), this.key).toString("base64url")}`;
    await this.dependencies.store.seal({ grantId: jti, generation, grantDigest: digest(grant) });
    return { grant, expiresAt: exp, binding, generation };
  }
  async redeem(value: unknown): Promise<HostRegistration> {
    requireValue(
      exact(value, [
        "grant",
        "serverInstanceId",
        "protocolVersion",
        "threads",
        "hostPublicKeyPem",
        "proof",
      ]) &&
        typeof value.grant === "string" &&
        value.grant.length <= 16384 &&
        identifier(value.serverInstanceId) &&
        value.protocolVersion === "0.165.0" &&
        typeof value.hostPublicKeyPem === "string" &&
        value.hostPublicKeyPem.length <= 8192 &&
        typeof value.proof === "string" &&
        /^[A-Za-z0-9_-]{86}$/.test(value.proof),
    );
    const request = value as RegistrationRequest;
    const segments = request.grant.split(".");
    requireValue(segments.length === 3 && segments.every((part) => /^[A-Za-z0-9_-]+$/.test(part)));
    const header = JSON.parse(Buffer.from(segments[0], "base64url").toString());
    requireValue(
      exact(header, ["alg", "typ", "kid"]) &&
        header.alg === "EdDSA" &&
        header.typ === "JWT" &&
        header.kid === this.config.keyId,
    );
    requireValue(
      verify(
        null,
        Buffer.from(`${segments[0]}.${segments[1]}`),
        this.publicKey,
        Buffer.from(segments[2], "base64url"),
      ),
    );
    const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString()) as Claims;
    const now = this.now();
    requireValue(
      exact(claims, ["iss", "aud", "scope", "jti", "iat", "exp", "generation", "binding"]) &&
        claims.iss === this.config.hiveOrigin &&
        claims.aud === "hive:workspace-registration" &&
        claims.scope === "workspace:register" &&
        identifier(claims.jti) &&
        Number.isSafeInteger(claims.iat) &&
        Number.isSafeInteger(claims.exp) &&
        claims.iat <= now &&
        claims.exp > now &&
        claims.exp - claims.iat > 0 &&
        claims.exp - claims.iat <= 60 &&
        Number.isSafeInteger(claims.generation) &&
        claims.generation > 0,
    );
    const binding = claims.binding;
    requireValue(
      binding &&
        identifier(binding.hiveUserId) &&
        identifier(binding.ownerId) &&
        identifier(binding.workspaceId) &&
        identifier(binding.agentId),
    );
    const fresh = await this.resolve(
      { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId },
      binding.workspaceId,
      binding.agentId,
      projects(binding.projects).map((p) => p.projectId),
    );
    requireValue(
      JSON.stringify(fresh) === JSON.stringify(binding),
      "Coder authority changed before registration.",
    );
    requireValue(
      Array.isArray(request.threads) && request.threads.length > 0 && request.threads.length <= 32,
    );
    const seen = new Set<string>();
    const seenProjects = new Set<string>();
    for (const thread of request.threads) {
      requireValue(
        exact(thread, ["projectId", "repositoryId", "threadId"]) &&
          identifier(thread.threadId) &&
          !seen.has(thread.threadId) &&
          !seenProjects.has(thread.projectId) &&
          binding.projects.some(
            (p) => p.projectId === thread.projectId && p.repositoryId === thread.repositoryId,
          ),
      );
      seen.add(thread.threadId);
      seenProjects.add(thread.projectId);
    }
    const hostKey = createPublicKey(request.hostPublicKeyPem);
    requireValue(
      hostKey.asymmetricKeyType === "ed25519" &&
        verify(
          null,
          Buffer.from(registrationProofPayload(request)),
          hostKey,
          Buffer.from(request.proof, "base64url"),
        ),
    );
    const registeredAt = this.now();
    requireValue(registeredAt < claims.exp);
    const registration: HostRegistration = {
      binding,
      serverInstanceId: request.serverInstanceId,
      protocolVersion: "0.165.0",
      threads: request.threads.map((t) => ({ ...t })),
      hostPublicKeyPem: request.hostPublicKeyPem,
      generation: claims.generation,
      registeredAt,
      expiresAt: registeredAt + 60,
    };
    requireValue(
      await this.dependencies.store.consumeAndRegister({
        grantId: claims.jti,
        grantDigest: digest(request.grant),
        expiresAt: claims.exp,
        now: registeredAt,
        registration,
      }),
      "Registration grant consumed, superseded, or unavailable.",
    );
    return registration;
  }
}
