import type { CoderClient } from "@/lib/coder/client";
import {
  type RegistrationPrincipal,
  resolveVerifiedWorkspaceHost,
  type VerifiedHostBinding,
} from "@/lib/codex-session/registration.server";
import {
  AgentBridgeClient,
  type AgentBridgeClientConfig,
  AgentBridgeError,
  type AgentBridgeTransport,
} from "./portable-client.server";
import {
  type AgentOperation,
  type AgentOperationResult,
  agentOperationSchema,
} from "./portable-contracts";

type Reader = Pick<
  CoderClient,
  | "getWorkspace"
  | "getWorkspaceResources"
  | "getApplicationsHost"
  | "getBaseUrl"
  | "getApplicationAuthRedirect"
>;
type Pin = {
  templateId: string;
  profile: AgentBridgeClientConfig["profile"];
  manifestSha256: string;
  helperSha256: string;
};
export type AgentBridgeServiceConfig = {
  issuer: string;
  keyId: string;
  privateKeyPem: string;
  pins: Pin[];
  cookieDomains: string[];
  home: string;
};
export type AgentBridgeServiceDependencies = {
  coderForPrincipal(principal: RegistrationPrincipal, signal: AbortSignal): Promise<Reader>;
  transport(coder: Reader, binding: VerifiedHostBinding): AgentBridgeTransport;
};
const MUTATIONS = new Set(["install", "disable", "configure-coder", "resume"]);
/** Request-local authority: resolve the exact owner-only agent app before and
 * after each operation. No mutation is retried on an uncertain result. */
export class AgentBridgeService {
  constructor(
    private readonly config: AgentBridgeServiceConfig,
    private readonly deps: AgentBridgeServiceDependencies,
  ) {}
  async execute<K extends Exclude<AgentOperation["operation"], "identity">>(
    principal: RegistrationPrincipal,
    workspaceId: string,
    request: Extract<AgentOperation, { operation: K }>,
    callerSignal?: AbortSignal,
  ): Promise<AgentOperationResult<K>> {
    let completed = false;
    const signal = AbortSignal.any([
      AbortSignal.timeout(55000),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      const parsed = agentOperationSchema.parse(request);
      if (
        parsed.operation === "identity" ||
        this.config.pins.length === 0 ||
        new Set(this.config.pins.map((p) => p.templateId)).size !== this.config.pins.length
      )
        throw new Error();
      const coder = await this.deps.coderForPrincipal(principal, signal);
      const authority = {
        hiveOrigin: this.config.issuer,
        softwareTemplateIds: this.config.pins.map((p) => p.templateId),
        appSlug: "hive-agent",
        gatewayPort: 13344,
        cookieDomains: this.config.cookieDomains,
      };
      const before = await resolveVerifiedWorkspaceHost(
        authority,
        async () => coder,
        principal,
        workspaceId,
      );
      signal.throwIfAborted();
      const pin = this.config.pins.find((p) => p.templateId === before.binding.templateId);
      if (!pin) throw new Error();
      const { hiveUserId: _hiveUserId, ...hostBinding } = before.binding;
      const config: AgentBridgeClientConfig = {
        issuer: this.config.issuer,
        keyId: this.config.keyId,
        privateKeyPem: this.config.privateKeyPem,
        binding: hostBinding,
        hiveUserId: principal.hiveUserId,
        home: this.config.home,
        profile: pin.profile,
        manifestSha256: pin.manifestSha256,
        helperSha256: pin.helperSha256,
      };
      const client = new AgentBridgeClient(config, this.deps.transport(coder, before.binding));
      const result = await client.execute(
        parsed as Extract<AgentOperation, { operation: K }>,
        signal,
      );
      completed = true;
      const after = await resolveVerifiedWorkspaceHost(
        authority,
        async () => coder,
        principal,
        workspaceId,
        before.binding.agentId,
      );
      signal.throwIfAborted();
      if (JSON.stringify(after.binding) !== JSON.stringify(before.binding)) throw new Error();
      return result;
    } catch (error) {
      if (completed && MUTATIONS.has((request as AgentOperation).operation))
        throw new AgentBridgeError("outcome_unknown");
      if (error instanceof AgentBridgeError) throw error;
      throw new AgentBridgeError("unavailable");
    }
  }
}
