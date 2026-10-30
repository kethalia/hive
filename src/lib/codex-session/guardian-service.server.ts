import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { type CodexGuardianRuntime, Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { expectedGuardianHostConfig, guardianConfigSha256 } from "./guardian-config.server";
import {
  type GuardianPolicy,
  type GuardianProducerScope,
  guardianCheckoutSchema,
  guardianDigest,
} from "./guardian-contracts";
import { GuardianAdmissionStore, lockProducerMetadata } from "./guardian-store.server";
import {
  type GuardianTransportEnvelope,
  guardianEnrollmentClaimsSchema,
  guardianIdentityProofPayload,
  guardianIdentityResponseSchema,
  guardianTransportEnvelopeSchema,
  guardianTransportProofPayload,
} from "./guardian-transport-contracts";
import type { RegisteredSessionConfig } from "./registered-session.server";
import type {
  RegistrationBinding,
  RegistrationPrincipal,
  VerifiedHostBinding,
} from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

const requireGuardian: (value: unknown) => asserts value = (value) => {
  if (!value) throw new RegistrationRejected();
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (pem: string) =>
  createHash("sha256")
    .update(createPublicKey(pem).export({ format: "der", type: "spki" }))
    .digest("hex");
export interface GuardianOwnerTransport {
  // Implementations must use only fixed owner-only Coder app paths, with a fresh
  // request-local app cookie. Never accept a URL or credential from these frames.
  identity(binding: VerifiedHostBinding, nonce: string): Promise<unknown>;
  bootstrap(binding: VerifiedHostBinding, grant: string): Promise<unknown>;
}
export interface GuardianServiceDependencies {
  resolveWorkspace(
    principal: RegistrationPrincipal,
    workspaceId: string,
  ): Promise<VerifiedHostBinding>;
  transport?: GuardianOwnerTransport;
  signal?: AbortSignal;
  now?: () => number;
  env?: Record<string, string | undefined>;
}
/** Host keys authenticate the approved installed software boundary. Startup
 * evidence is deliberately not represented as hardware remote attestation. */
export class GuardianService {
  readonly store: GuardianAdmissionStore;
  private readonly key;
  private readonly publicKey;
  private readonly env;
  constructor(
    private readonly db: PrismaClient,
    private readonly config: RegisteredSessionConfig,
    private readonly policy: GuardianPolicy,
    private readonly encryptionKey: string,
    private readonly dependencies: GuardianServiceDependencies,
  ) {
    requireGuardian(policy.enabled);
    this.key = createPrivateKey(config.privateKeyPem);
    this.publicKey = createPublicKey(this.key);
    requireGuardian(this.key.asymmetricKeyType === "ed25519");
    this.env = dependencies.env ?? process.env;
    this.store = this.requestStore();
  }
  private requestStore(authorizationExpiresAt?: number) {
    return new GuardianAdmissionStore(this.db, {
      policy: this.policy,
      encryptionKey: this.encryptionKey,
      signal: this.dependencies.signal,
      authorizationExpiresAt,
      expectedConfigSha256: (b) =>
        guardianConfigSha256(expectedGuardianHostConfig(b, this.config, this.env)),
    });
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }
  private active() {
    this.dependencies.signal?.throwIfAborted();
  }
  private workspace(binding: VerifiedHostBinding): RegistrationBinding {
    return { ...binding, projects: [] };
  }
  private async resolve(principal: RegistrationPrincipal, workspaceId: string) {
    this.active();
    const binding = await this.dependencies.resolveWorkspace(principal, workspaceId);
    this.active();
    requireGuardian(
      binding.hiveUserId === principal.hiveUserId &&
        binding.ownerId === principal.coderUserId &&
        binding.workspaceId === workspaceId,
    );
    return binding;
  }
  private checkPins(
    runtime: Pick<
      CodexGuardianRuntime,
      | "packageManifestSha256"
      | "guardianElfSha256"
      | "nodeSha256"
      | "policyDigest"
      | "metadataPolicyDigest"
    >,
  ) {
    requireGuardian(
      this.policy.enabled &&
        this.policy.packages.some(
          (p) =>
            p.protocol === "guardian-v1" &&
            p.packageManifestSha256 === runtime.packageManifestSha256 &&
            p.guardianElfSha256 === runtime.guardianElfSha256 &&
            p.nodeSha256 === runtime.nodeSha256 &&
            p.policyDigest === runtime.policyDigest &&
            p.metadataPolicyDigest === runtime.metadataPolicyDigest,
        ),
    );
  }
  private live(value: { issuedAt: number; expiresAt: number }) {
    const now = this.now();
    requireGuardian(
      value.issuedAt <= now &&
        value.expiresAt > now &&
        value.expiresAt > value.issuedAt &&
        value.expiresAt - value.issuedAt <= 60000,
    );
  }
  private verifyIdentity(binding: VerifiedHostBinding, raw: unknown, nonce: string) {
    const packet = guardianIdentityResponseSchema.parse(raw);
    this.live(packet);
    requireGuardian(packet.nonce === nonce);
    const { identity, startup } = packet;
    this.checkPins(identity);
    const key = createPublicKey(identity.outerPublicKeyPem);
    requireGuardian(
      key.asymmetricKeyType === "ed25519" &&
        key.export({ format: "pem", type: "spki" }).toString() === identity.outerPublicKeyPem &&
        verify(
          null,
          Buffer.from(guardianIdentityProofPayload(packet)),
          key,
          Buffer.from(packet.proof, "base64url"),
        ),
    );
    const config = expectedGuardianHostConfig(this.workspace(binding), this.config, this.env),
      configSha256 = guardianConfigSha256(config);
    const expectedBinding = sha(
      JSON.stringify({
        schemaVersion: 1,
        configSha256,
        packageManifestSha256: identity.packageManifestSha256,
      }),
    );
    requireGuardian(
      identity.configSha256 === configSha256 &&
        identity.bindingDigest === expectedBinding &&
        startup.configSha256 === configSha256 &&
        startup.packageManifestSha256 === identity.packageManifestSha256 &&
        startup.guardianSha256 === identity.guardianElfSha256 &&
        startup.nodeSha256 === identity.nodeSha256 &&
        startup.lifetimeId === identity.lifetimeId &&
        startup.bindingDigest === identity.bindingDigest &&
        startup.port === config.port,
    );
    const outer = startup.outerIdentity,
      guardian = startup.guardianIdentity,
      worker = startup.workerIdentity;
    requireGuardian(
      new Set([outer.pid, guardian.pid, worker.pid]).size === 3 &&
        guardian.parentPid === outer.pid &&
        worker.parentPid === guardian.pid &&
        outer.bootId === guardian.bootId &&
        outer.bootId === worker.bootId &&
        outer.executable === worker.executable &&
        outer.device === worker.device &&
        outer.inode === worker.inode,
    );
    return packet;
  }
  async provision(principal: RegistrationPrincipal, workspaceId: string) {
    const transport = this.dependencies.transport;
    requireGuardian(transport);
    const binding = await this.resolve(principal, workspaceId),
      nonce = randomBytes(32).toString("hex");
    const packet = this.verifyIdentity(binding, await transport.identity(binding, nonce), nonce);
    this.active();
    const existing = await this.db.codexGuardianRuntime.findFirst({
      where: { ownerId: principal.hiveUserId, lifetimeId: packet.identity.lifetimeId },
    });
    this.active();
    if (!existing)
      requireGuardian(packet.startup.projects.length === 0 && packet.startup.generation === 1);
    const store = this.requestStore(packet.expiresAt);
    const runtime = await store.reserveRuntime(this.workspace(binding), packet.identity);
    this.active();
    this.live(packet);
    if (runtime.phase === "open") {
      requireGuardian(packet.startup.generation === runtime.generation);
      return { runtimeId: runtime.id, enrolled: true };
    }
    requireGuardian(
      runtime.phase === "reserved" &&
        packet.startup.projects.length === 0 &&
        packet.startup.generation === 1,
    );
    const issuedAt = Math.floor(this.now() / 1000),
      jti = randomUUID();
    const claims = {
      iss: this.config.hiveOrigin,
      aud: "hive:workspace-guardian" as const,
      scope: "workspace:guardian:enroll" as const,
      jti,
      iat: issuedAt,
      exp: issuedAt + 60,
      runtimeId: runtime.id,
      hiveUserId: principal.hiveUserId,
      coderOwnerId: principal.coderUserId,
      workspaceId: binding.workspaceId,
      agentId: binding.agentId,
      buildId: binding.buildId,
      appId: binding.appId,
      lifetimeId: runtime.lifetimeId,
      outerKeyFingerprint: runtime.outerKeyFingerprint,
      bindingDigest: runtime.bindingDigest,
      identityDigest: guardianDigest({
        identity: packet.identity,
        binding: this.workspace(binding),
      }),
      startupDigest: guardianDigest(packet.startup),
    };
    const header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.config.keyId }),
      ).toString("base64url"),
      body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const grant = `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), this.key).toString("base64url")}`;
    await store.sealGrant({
      ownerId: principal.hiveUserId,
      runtimeId: runtime.id,
      id: jti,
      tokenDigest: sha(grant),
      bindingDigest: guardianDigest(claims),
      issuedAt: new Date(issuedAt * 1000),
      expiresAt: new Date((issuedAt + 60) * 1000),
    });
    this.active();
    await transport.bootstrap(binding, grant);
    this.active();
    const fresh = await this.db.codexGuardianRuntime.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: principal.hiveUserId, id: runtime.id } },
    });
    requireGuardian(fresh.phase === "open" && fresh.enrolledAt);
    return { runtimeId: runtime.id, enrolled: true };
  }
  private claims(grant: string) {
    const parts = grant.split(".");
    requireGuardian(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
    const header = z
      .object({ alg: z.literal("EdDSA"), typ: z.literal("JWT"), kid: z.literal(this.config.keyId) })
      .strict()
      .parse(JSON.parse(Buffer.from(parts[0], "base64url").toString()));
    requireGuardian(
      header &&
        verify(
          null,
          Buffer.from(`${parts[0]}.${parts[1]}`),
          this.publicKey,
          Buffer.from(parts[2], "base64url"),
        ),
    );
    const claims = guardianEnrollmentClaimsSchema.parse(
      JSON.parse(Buffer.from(parts[1], "base64url").toString()),
    );
    const now = Math.floor(this.now() / 1000);
    requireGuardian(
      claims.iss === this.config.hiveOrigin &&
        claims.iat <= now &&
        claims.exp > now &&
        claims.exp > claims.iat &&
        claims.exp - claims.iat <= 60,
    );
    return claims;
  }
  private async runtime(input: GuardianTransportEnvelope) {
    this.active();
    this.live(input);
    const runtime = await this.db.codexGuardianRuntime.findUnique({
      where: { id: input.runtimeId },
    });
    requireGuardian(runtime);
    const key = createPublicKey(runtime.outerPublicKeyPem);
    requireGuardian(
      key.asymmetricKeyType === "ed25519" &&
        verify(
          null,
          Buffer.from(guardianTransportProofPayload(input)),
          key,
          Buffer.from(input.proof, "base64url"),
        ),
    );
    this.checkPins(runtime);
    const user = await this.db.user.findUnique({ where: { id: runtime.ownerId } });
    requireGuardian(user);
    const binding = await this.resolve(
      { hiveUserId: user.id, coderUserId: user.coderUserId },
      runtime.workspaceId,
    );
    const expected = expectedGuardianHostConfig(this.workspace(binding), this.config, this.env);
    requireGuardian(
      guardianDigest(runtime.binding) === guardianDigest(this.workspace(binding)) &&
        runtime.configSha256 === guardianConfigSha256(expected),
    );
    this.active();
    this.live(input);
    return runtime;
  }
  private async nativeScope(
    runtime: CodexGuardianRuntime,
    projectId: string,
    registrationId?: string,
    threadId?: string,
  ): Promise<GuardianProducerScope> {
    this.active();
    const admission = await this.db.codexGuardianAdmission.findUnique({
      where: {
        ownerId_runtimeId_projectId: { ownerId: runtime.ownerId, runtimeId: runtime.id, projectId },
      },
    });
    requireGuardian(admission);
    this.active();
    const checkout = guardianCheckoutSchema.parse(admission.checkoutBinding);
    const id = registrationId ?? admission.registrationId;
    requireGuardian(id);
    const registration = await this.db.codexHostRegistration.findUnique({
      where: { ownerId_id: { ownerId: runtime.ownerId, id } },
    });
    requireGuardian(registration);
    this.active();
    const managerThreadId = threadId ?? admission.nativeThreadId;
    requireGuardian(managerThreadId);
    return {
      hiveUserId: runtime.ownerId,
      registrationId: registration.id,
      workspaceId: runtime.workspaceId,
      buildId: runtime.buildId,
      serverInstanceId: registration.serverInstanceId,
      managerThreadId,
      projectId,
      preparationIntentId: checkout.preparationIntentId,
      repositoryId: checkout.repositoryId,
      leaseId: checkout.leaseId,
      leaseGeneration: checkout.leaseGeneration,
    };
  }
  async execute(raw: unknown) {
    const input = guardianTransportEnvelopeSchema.parse(raw),
      runtime = await this.runtime(input);
    this.active();
    const store = this.requestStore(input.expiresAt);
    if (input.action === "enroll") {
      const claims = this.claims(input.grant);
      requireGuardian(
        claims.runtimeId === runtime.id &&
          claims.hiveUserId === runtime.ownerId &&
          claims.workspaceId === runtime.workspaceId &&
          claims.buildId === runtime.buildId &&
          claims.lifetimeId === runtime.lifetimeId &&
          claims.outerKeyFingerprint === fingerprint(runtime.outerPublicKeyPem) &&
          claims.bindingDigest === runtime.bindingDigest,
      );
      const binding = runtime.binding as unknown as RegistrationBinding;
      requireGuardian(
        claims.coderOwnerId === binding.ownerId &&
          claims.agentId === binding.agentId &&
          claims.appId === binding.appId &&
          claims.identityDigest ===
            guardianDigest({
              identity: {
                lifetimeId: runtime.lifetimeId,
                bindingDigest: runtime.bindingDigest,
                outerPublicKeyPem: runtime.outerPublicKeyPem,
                packageManifestSha256: runtime.packageManifestSha256,
                guardianElfSha256: runtime.guardianElfSha256,
                nodeSha256: runtime.nodeSha256,
                policyDigest: runtime.policyDigest,
                metadataPolicyDigest: runtime.metadataPolicyDigest,
                configSha256: runtime.configSha256,
              },
              binding,
            }),
      );
      const enrollmentStore = this.requestStore(Math.min(input.expiresAt, claims.exp * 1000));
      const enrolled = await enrollmentStore.enroll({
        ownerId: runtime.ownerId,
        runtimeId: runtime.id,
        grantId: claims.jti,
        tokenDigest: sha(input.grant),
        bindingDigest: guardianDigest(claims),
        consumptionDigest: guardianDigest(input),
      });
      return { accepted: true, runtimeId: runtime.id, runtimeGeneration: enrolled.generation };
    }
    const common = {
      ownerId: runtime.ownerId,
      runtimeId: runtime.id,
      runtimeGeneration: input.runtimeGeneration,
    };
    if (input.action === "prepare")
      return store.prepare({
        ...common,
        preparation: input.preparation,
        preparationDigest: input.preparationDigest,
      });
    if (input.action === "checkout")
      return store.bindCheckout({ ...common, checkout: input.checkout });
    if (input.action === "launch")
      return store.reserveNativeLaunch({
        ...common,
        nativeLaunchId: input.nativeLaunchId,
        launchIntentDigest: input.launchIntentDigest,
        projectIds: input.projectIds,
      });
    if (input.action === "native") {
      const scope = await this.nativeScope(
        runtime,
        input.projectId,
        input.registrationId,
        input.managerThreadId,
      );
      this.active();
      this.live(input);
      return store.finalizeNative({
        scope,
        runtimeId: runtime.id,
        runtimeGeneration: input.runtimeGeneration,
        metadata: input.metadata,
      });
    }
    if (input.action === "fence")
      return store.fence({
        ...common,
        projectId: input.projectId,
        preparationDigest: input.preparationDigest,
      });
    if (input.action === "metadata") {
      const scope = await this.nativeScope(runtime, input.projectId);
      this.active();
      this.live(input);
      return this.db.$transaction(
        async (tx) => {
          const result = await lockProducerMetadata(tx, scope, this.policy);
          requireGuardian(
            result.runtimeGeneration === input.runtimeGeneration &&
              result.admissionId === input.admissionId &&
              result.admissionGeneration === input.admissionGeneration &&
              result.metadataPinsDigest === input.metadataPinsDigest,
          );
          this.active();
          this.live(input);
          const [time] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          requireGuardian(time && time.now.getTime() < input.expiresAt);
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
      );
    }
    return store.closeBarrier({
      ...common,
      barrierId: input.barrierId,
      ownershipDigest: input.ownershipDigest,
      projectBindings: input.projectBindings,
      snapshots: input.snapshots,
    });
  }
}
