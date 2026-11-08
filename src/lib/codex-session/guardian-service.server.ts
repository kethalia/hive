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
import type { CheckoutVolumeEvidence } from "../delivery/checkout-cleanup-contracts";
import {
  accountMaintenanceGrantSchema,
  accountMaintenanceRequestSchema,
  maintenanceOwnerResumeSchema,
} from "./account-maintenance-contracts";
import {
  AccountMaintenanceStore,
  parseAccountMaintenance,
} from "./account-maintenance-store.server";
import { GuardianSourceApplicationStore } from "./guardian-application-store.server";
import { expectedGuardianHostConfig, guardianConfigSha256 } from "./guardian-config.server";
import {
  type GuardianPolicy,
  type GuardianProducerScope,
  guardianCheckoutSchema,
  guardianDigest,
} from "./guardian-contracts";
import { readRemountRecoveryTicket, resolveRemountAttestation } from "./guardian-remount.server";
import {
  type GuardianRemountAttestation,
  type GuardianTransferContinuation,
  guardianRemountEnrollments,
} from "./guardian-remount-contracts";
import {
  GuardianAdmissionStore,
  type GuardianOperationReceiptInput,
  lockProducerMetadata,
} from "./guardian-store.server";
import {
  type GuardianTransportEnvelope,
  guardianEmptyCloseClaimsSchema,
  guardianEnrollmentClaimsSchema,
  guardianIdentityProofPayload,
  guardianIdentityResponseSchema,
  guardianOperationEnvelopeSchema,
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
const waitForClock = (delay: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  recoverEmptyClose?(binding: VerifiedHostBinding, grant: string): Promise<unknown>;
  accountMaintenance?(binding: VerifiedHostBinding, grant: string): Promise<unknown>;
}
export type GuardianProvisionStage =
  | "guardian_config"
  | "guardian_resolve"
  | "guardian_identity_transport"
  | "guardian_identity_validation"
  | "guardian_identity_schema"
  | "guardian_identity_liveness"
  | "guardian_identity_future"
  | "guardian_identity_expired"
  | "guardian_identity_bounds"
  | "guardian_identity_nonce"
  | "guardian_identity_pins"
  | "guardian_identity_signature"
  | "guardian_identity_config"
  | "guardian_identity_process"
  | "guardian_runtime_reservation"
  | "guardian_bootstrap"
  | "guardian_enrollment_confirmation";
export interface GuardianServiceDependencies {
  resolveCleanupVolume?(
    binding: VerifiedHostBinding,
    lifetimeId: string,
  ): Promise<CheckoutVolumeEvidence>;
  assertUnstartedPredecessorStopped?(
    binding: VerifiedHostBinding,
    oldBuildId: string,
    continuation?: GuardianTransferContinuation,
    attestation?: GuardianRemountAttestation,
  ): Promise<void>;
  assertMaintenanceAccountsIdle?(binding: VerifiedHostBinding): Promise<void>;
  registerMaintenanceHost?(
    binding: VerifiedHostBinding,
    projects: Array<{ projectId: string; preparationIntentId: string; requestId: string }>,
  ): Promise<void>;
  resolveWorkspace(
    principal: RegistrationPrincipal,
    workspaceId: string,
  ): Promise<VerifiedHostBinding>;
  transport?: GuardianOwnerTransport;
  signal?: AbortSignal;
  now?: () => number;
  clockWait?: (delay: number, signal?: AbortSignal) => Promise<void>;
  env?: Record<string, string | undefined>;
  onProvisionStage?: (stage: GuardianProvisionStage) => void;
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
  private requestStore(authorizationExpiresAt?: number, operation?: GuardianOperationReceiptInput) {
    return new GuardianAdmissionStore(this.db, {
      policy: this.policy,
      encryptionKey: this.encryptionKey,
      signal: this.dependencies.signal,
      authorizationExpiresAt,
      ...(operation ? { operation } : {}),
      expectedConfigSha256: (b) =>
        guardianConfigSha256(expectedGuardianHostConfig(b, this.config, this.env)),
    });
  }

  async recoveryContinuity(scope: {
    ownerId: string;
    coderOwnerId: string;
    workspaceId: string;
    projectId: string;
    taskId: string;
    recoveryId: string;
  }) {
    const binding = await this.resolve(
      { hiveUserId: scope.ownerId, coderUserId: scope.coderOwnerId },
      scope.workspaceId,
    );
    const ticket = await readRemountRecoveryTicket(this.db, this.env, scope);
    if (ticket) {
      const entries = guardianRemountEnrollments(this.env),
        a = entries.find((a) => guardianDigest(a) === ticket.attestationDigest);
      requireGuardian(
        a &&
          a.final.buildId === binding.buildId &&
          this.dependencies.assertUnstartedPredecessorStopped,
      );
      const events = await this.db.codexGuardianOperationReceipt.findMany({
        where: {
          ownerId: scope.ownerId,
          action: "authorization_retired",
          response: { path: ["retirement", "recoveryId"], equals: scope.recoveryId },
        },
        take: 2,
      });
      const event = events.find(
        (e) =>
          (e.response as { retirement?: { recoveryId?: string } }).retirement?.recoveryId ===
          scope.recoveryId,
      );
      requireGuardian(event);
      const retirement = (
        event.response as unknown as { retirement: { continuation: GuardianTransferContinuation } }
      ).retirement;
      await this.dependencies.assertUnstartedPredecessorStopped(
        binding,
        a.oldBuildId,
        retirement.continuation,
        a,
      );
      this.active();
    }
    return ticket;
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
  private live(value: { issuedAt: number; expiresAt: number }, now = this.now()) {
    requireGuardian(
      value.issuedAt <= now &&
        value.expiresAt > now &&
        value.expiresAt > value.issuedAt &&
        value.expiresAt - value.issuedAt <= 60000,
    );
  }
  private async resampleIssuedAt(value: { issuedAt: number }) {
    // Workerd may freeze Date.now() between I/O turns. Resample rather than
    // clamping the supplied timestamp or accepting a still-future signature.
    if (value.issuedAt > this.now()) {
      const wait = this.dependencies.clockWait ?? waitForClock;
      await wait(0, this.dependencies.signal);
      this.active();
      const remaining = value.issuedAt - this.now();
      if (remaining > 0 && remaining <= 1000) {
        await wait(remaining + 1, this.dependencies.signal);
        this.active();
      }
    }
  }
  private verifyIdentity(binding: VerifiedHostBinding, raw: unknown, nonce: string) {
    this.dependencies.onProvisionStage?.("guardian_identity_schema");
    const packet = guardianIdentityResponseSchema.parse(raw);
    const now = this.now();
    this.dependencies.onProvisionStage?.(
      packet.issuedAt > now
        ? "guardian_identity_future"
        : packet.expiresAt <= now
          ? "guardian_identity_expired"
          : packet.expiresAt <= packet.issuedAt || packet.expiresAt - packet.issuedAt > 60000
            ? "guardian_identity_bounds"
            : "guardian_identity_liveness",
    );
    this.live(packet, now);
    this.dependencies.onProvisionStage?.("guardian_identity_nonce");
    requireGuardian(packet.nonce === nonce);
    const { identity, startup } = packet;
    this.dependencies.onProvisionStage?.("guardian_identity_pins");
    this.checkPins(identity);
    this.dependencies.onProvisionStage?.("guardian_identity_signature");
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
    this.dependencies.onProvisionStage?.("guardian_identity_config");
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
    this.dependencies.onProvisionStage?.("guardian_identity_process");
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
  async verifyRecoveryIdentity(
    principal: RegistrationPrincipal,
    workspaceId: string,
    raw: unknown,
    nonce: string,
  ) {
    const binding = await this.resolve(principal, workspaceId);
    const parsed = guardianIdentityResponseSchema.parse(raw);
    await this.resampleIssuedAt(parsed);
    const packet = this.verifyIdentity(binding, parsed, nonce);
    const runtime = await this.requestStore(packet.expiresAt).reserveRuntime(
      this.workspace(binding),
      packet.identity,
    );
    requireGuardian(
      runtime.phase === "open" &&
        runtime.operationReceiptsEnabled &&
        packet.startup.generation === runtime.generation,
    );
    return { runtime, packet };
  }
  async provision(principal: RegistrationPrincipal, workspaceId: string) {
    const transport = this.dependencies.transport;
    requireGuardian(transport);
    this.dependencies.onProvisionStage?.("guardian_resolve");
    const binding = await this.resolve(principal, workspaceId),
      nonce = randomBytes(32).toString("hex");
    this.dependencies.onProvisionStage?.("guardian_identity_transport");
    const identity = await transport.identity(binding, nonce);
    this.dependencies.onProvisionStage?.("guardian_identity_schema");
    const parsedIdentity = guardianIdentityResponseSchema.parse(identity);
    this.active();
    await this.resampleIssuedAt(parsedIdentity);
    this.dependencies.onProvisionStage?.("guardian_identity_validation");
    const packet = this.verifyIdentity(binding, parsedIdentity, nonce);
    this.active();
    this.dependencies.onProvisionStage?.("guardian_runtime_reservation");
    const existing = await this.db.codexGuardianRuntime.findFirst({
      where: { ownerId: principal.hiveUserId, lifetimeId: packet.identity.lifetimeId },
    });
    this.active();
    if (!existing)
      requireGuardian(packet.startup.projects.length === 0 && packet.startup.generation === 1);
    requireGuardian(!packet.unstartedTransferContinuation || packet.unstartedTransfer);
    const remountAttestation =
      packet.unstartedTransferContinuation && packet.unstartedTransfer
        ? resolveRemountAttestation({
            proof: packet.unstartedTransfer,
            continuation: packet.unstartedTransferContinuation,
            binding: this.workspace(binding),
            identity: packet.identity,
            policy: this.policy,
            enrollments: guardianRemountEnrollments(this.env),
            now: this.now(),
          })
        : undefined;
    const store = this.requestStore(
      Math.min(packet.expiresAt, remountAttestation?.expiresAt ?? Infinity),
    );
    if (packet.unstartedTransfer) {
      requireGuardian(
        packet.startup.projects.length === 0 &&
          packet.startup.generation === 1 &&
          this.dependencies.assertUnstartedPredecessorStopped,
      );
      await this.dependencies.assertUnstartedPredecessorStopped(
        binding,
        packet.unstartedTransfer.oldBuildId,
        packet.unstartedTransferContinuation,
        remountAttestation,
      );
      this.active();
      this.live(packet);
    }
    const runtime = await store.reserveRuntime(
      this.workspace(binding),
      packet.identity,
      packet.unstartedTransfer,
      packet.unstartedTransferContinuation,
      guardianRemountEnrollments(this.env),
    );
    this.active();
    this.live(packet);
    if (runtime.phase === "open") {
      this.dependencies.onProvisionStage?.("guardian_enrollment_confirmation");
      requireGuardian(packet.startup.generation === runtime.generation);
      return { runtimeId: runtime.id, enrolled: true };
    }
    requireGuardian(
      runtime.phase === "reserved" &&
        packet.startup.projects.length === 0 &&
        packet.startup.generation === 1,
    );
    this.dependencies.onProvisionStage?.("guardian_bootstrap");
    const issuedAt = Math.floor(this.now() / 1000),
      jti = randomUUID();
    const claims = {
      iss: this.config.hiveOrigin,
      aud: "hive:workspace-guardian" as const,
      scope: "workspace:guardian:enroll" as const,
      jti,
      iat: issuedAt,
      exp: Math.min(issuedAt + 60, Math.floor((remountAttestation?.expiresAt ?? Infinity) / 1000)),
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
      ...(packet.unstartedTransfer
        ? {
            unstartedTransfer: {
              transferId: packet.unstartedTransfer.transferId,
              oldRuntimeId: packet.unstartedTransfer.oldRuntimeId,
              proofDigest: guardianDigest(packet.unstartedTransfer),
              ...(packet.unstartedTransferContinuation
                ? {
                    continuationDigest: guardianDigest(packet.unstartedTransferContinuation),
                    attestationDigest: guardianDigest(remountAttestation),
                  }
                : {}),
            },
          }
        : {}),
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
      expiresAt: new Date(claims.exp * 1000),
    });
    this.active();
    await transport.bootstrap(binding, grant);
    this.active();
    this.dependencies.onProvisionStage?.("guardian_enrollment_confirmation");
    const fresh = await this.db.codexGuardianRuntime.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: principal.hiveUserId, id: runtime.id } },
    });
    requireGuardian(fresh.phase === "open" && fresh.enrolledAt);
    return { runtimeId: runtime.id, enrolled: true };
  }
  /** Explicit owner operation; never invoked by automatic reconciliation. */
  async accountMaintenance(principal: RegistrationPrincipal, workspaceId: string, value: unknown) {
    requireGuardian(
      this.env.HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED === "true" &&
        this.policy.enabled &&
        this.policy.producerEnabled,
    );
    const input = accountMaintenanceRequestSchema.parse(value),
      binding = await this.resolve(principal, workspaceId),
      store = new AccountMaintenanceStore(this.db),
      transport = this.dependencies.transport;
    requireGuardian(transport?.accountMaintenance);
    const selected = async () => {
      const slot = await this.db.codexHostSlot.findUniqueOrThrow({
        where: {
          ownerId_coderOrigin_workspaceId_agentId: {
            ownerId: principal.hiveUserId,
            coderOrigin: binding.coderOrigin,
            workspaceId,
            agentId: binding.agentId,
          },
        },
      });
      return { slot, state: parseAccountMaintenance(slot.accountMaintenance) };
    };
    const ownerResume = async ({ slot, state }: Awaited<ReturnType<typeof selected>>) => {
      requireGuardian(
        state?.phase === "resuming" &&
          state.resumeRequestId &&
          state.resumeIntentRuntimeId &&
          state.resumeIntentEventId &&
          state.idleRuntimeId,
      );
      const receipt = await this.db.codexGuardianOperationReceipt.findUniqueOrThrow({
        where: {
          ownerId_runtimeId_eventId: {
            ownerId: principal.hiveUserId,
            runtimeId: state.resumeIntentRuntimeId,
            eventId: state.resumeIntentEventId,
          },
        },
      });
      requireGuardian(receipt.action === "maintenance_resume_intent");
      const scope = maintenanceOwnerResumeSchema.parse(
        (receipt.response as Prisma.JsonObject).maintenance,
      );
      requireGuardian(
        scope.ownerId === principal.hiveUserId &&
          scope.workspaceId === workspaceId &&
          scope.buildId === binding.buildId &&
          scope.slotId === slot.id &&
          scope.maintenanceId === state.id &&
          scope.requestId === state.resumeRequestId &&
          scope.idleRuntimeId === state.idleRuntimeId &&
          scope.maintenanceVersion === slot.accountMaintenanceVersion,
      );
      return scope;
    };
    const deliver = async (action: "pause" | "inspect-resume" | "resume", requestId: string) => {
      const { slot, state } = await selected();
      requireGuardian(state && state.buildId === binding.buildId);
      const candidates = await this.db.codexGuardianRuntime.findMany({
        where: {
          ownerId: principal.hiveUserId,
          slotId: slot.id,
          buildId: binding.buildId,
          phase: "open",
        },
        take: 2,
      });
      requireGuardian(candidates.length === 1);
      const runtime = candidates[0];
      if (action === "pause")
        requireGuardian(
          state.id === requestId &&
            ["requested", "waiting-boundary"].includes(state.phase) &&
            state.runtimes.some(
              (r) => r.runtimeId === runtime.id && r.runtimeGeneration === runtime.generation,
            ),
        );
      else
        requireGuardian(
          action === "inspect-resume"
            ? state.phase === "ready"
            : state.phase === "resuming" && state.idleRuntimeId === runtime.id,
        );
      let parkedJournalDigest: string | null = null;
      if (action === "resume") {
        requireGuardian(
          state.resumeRequestId === requestId &&
            state.resumeIntentRuntimeId &&
            state.resumeIntentEventId,
        );
        const scope = await ownerResume({ slot, state });
        requireGuardian(
          scope.requestId === requestId &&
            scope.idleRuntimeId === runtime.id &&
            scope.idleRuntimeGeneration === runtime.generation,
        );
        parkedJournalDigest = scope.parkedJournalDigest;
      }
      const now = Math.floor(this.now() / 1000),
        claims = accountMaintenanceGrantSchema.parse({
          iss: this.config.hiveOrigin,
          aud: "hive:workspace-guardian",
          scope: "workspace:guardian:account-maintenance",
          action,
          jti: requestId,
          iat: now,
          exp: now + 60,
          runtimeId: runtime.id,
          runtimeGeneration: runtime.generation,
          lifetimeId: runtime.lifetimeId,
          hiveUserId: principal.hiveUserId,
          coderOwnerId: principal.coderUserId,
          workspaceId,
          buildId: binding.buildId,
          maintenanceId: state.id,
          maintenanceVersion: slot.accountMaintenanceVersion,
          ownerIntentRuntimeId: action === "resume" ? state.resumeIntentRuntimeId : null,
          ownerIntentEventId: action === "resume" ? state.resumeIntentEventId : null,
          parkedJournalDigest,
        });
      const header = Buffer.from(
          JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.config.keyId }),
        ).toString("base64url"),
        body = Buffer.from(JSON.stringify(claims)).toString("base64url"),
        grant = `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), this.key).toString("base64url")}`;
      this.active();
      requireGuardian(transport.accountMaintenance);
      return transport.accountMaintenance(binding, grant);
    };
    if (input.action === "request") {
      await store.request(this.workspace(binding), input);
    } else if (input.action === "resume") {
      const { state } = await selected();
      if (state?.phase === "ready") {
        requireGuardian(this.dependencies.assertMaintenanceAccountsIdle);
        await this.dependencies.assertMaintenanceAccountsIdle(binding);
        await store.requestResume(
          this.workspace(binding),
          input,
          await deliver("inspect-resume", input.requestId),
        );
      } else requireGuardian(state?.resumeRequestId === input.requestId);
    }
    const reconcileDelivery = async () => {
      const selection = await selected();
      const { state } = selection;
      let result: unknown;
      if (state?.phase === "requested" || state?.phase === "waiting-boundary") {
        // The durable owner intent supplies identity after a lost request/ACK.
        // Status never creates a new pause or resume request.
        result = await deliver("pause", state.id);
      } else if (state?.phase === "resuming") {
        requireGuardian(
          state.resumeRequestId &&
            state.resumeIntentRuntimeId &&
            state.resumeIntentEventId &&
            state.idleRuntimeId,
        );
        await ownerResume(selection);
        const idle = await this.db.codexGuardianRuntime.findUniqueOrThrow({
          where: { ownerId_id: { ownerId: principal.hiveUserId, id: state.idleRuntimeId } },
        });
        requireGuardian(idle.buildId === binding.buildId);
        // An accepted host resume prepares admissions before its ACK. Those
        // persisted facts must go through registration/receipt readback below,
        // never a second launch command against the advanced actor.
        if (
          idle.phase !== "open" ||
          idle.generation !== 1 ||
          idle.nativeLaunchId ||
          idle.serverInstanceId ||
          idle.producerApproved
        )
          return;
        result = await deliver("resume", state.resumeRequestId);
      } else return;
      requireGuardian(
        z
          .object({ accepted: z.literal(true) })
          .strict()
          .safeParse(result).success,
      );
    };
    if (input.action === "status") {
      try {
        await reconcileDelivery();
      } catch {
        // Return the saved hold after transport/ACK loss so UI polling remains
        // available. No failure is interpreted as a new effect or success.
      }
    } else await reconcileDelivery();
    const current = await selected();
    if (
      current.state?.phase === "resuming" &&
      !current.slot.activeRegistrationId &&
      this.dependencies.registerMaintenanceHost
    ) {
      const scope = await ownerResume(current);
      if (input.action === "status") {
        try {
          await this.dependencies.registerMaintenanceHost(binding, scope.projects);
        } catch {
          // Same immutable receipt/project request identities are retried by a
          // later status; never repeat the first prompt or owner continuation.
        }
      } else await this.dependencies.registerMaintenanceHost(binding, scope.projects);
    }
    return store.status(this.workspace(binding));
  }

  /** Explicit owner operation; never invoked by automatic reconciliation. */
  async recoverExpiredEmpty(
    principal: RegistrationPrincipal,
    workspaceId: string,
    runtimeId: string,
  ) {
    const transport = this.dependencies.transport;
    requireGuardian(transport?.recoverEmptyClose);
    const binding = await this.resolve(principal, workspaceId);
    const ready = await this.requestStore().expiredEmptyReady({
      ownerId: principal.hiveUserId,
      runtimeId,
      workspaceId,
      bindingDigest: guardianDigest(this.workspace(binding)),
      configSha256: guardianConfigSha256(
        expectedGuardianHostConfig(this.workspace(binding), this.config, this.env),
      ),
    });
    requireGuardian(ready.buildId === binding.buildId);
    const now = Math.floor(this.now() / 1000);
    const claims = guardianEmptyCloseClaimsSchema.parse({
      iss: this.config.hiveOrigin,
      aud: "hive:workspace-guardian",
      scope: "workspace:guardian:recover-empty-close",
      jti: randomUUID(),
      iat: now,
      exp: now + 60,
      runtimeId: ready.runtimeId,
      hiveUserId: principal.hiveUserId,
      coderOwnerId: principal.coderUserId,
      workspaceId,
      buildId: ready.buildId,
      lifetimeId: ready.lifetimeId,
      runtimeGeneration: 1,
    });
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.config.keyId }),
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const grant = `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), this.key).toString("base64url")}`;
    const response = await transport.recoverEmptyClose(binding, grant);
    requireGuardian(
      z
        .object({ accepted: z.literal(true) })
        .strict()
        .safeParse(response).success,
    );
    return { accepted: true, treeExited: false, cleanupAuthorized: false };
  }
  private emptyCloseClaims(grant: string, historical: boolean) {
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
    const claims = guardianEmptyCloseClaimsSchema.parse(
      JSON.parse(Buffer.from(parts[1], "base64url").toString()),
    );
    const now = Math.floor(this.now() / 1000);
    requireGuardian(
      claims.iss === this.config.hiveOrigin &&
        claims.exp > claims.iat &&
        claims.exp - claims.iat <= 60 &&
        (historical || (claims.iat <= now && claims.exp > now)),
    );
    return claims;
  }
  private claims(grant: string, historical = false) {
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
        (historical || (claims.iat <= now && claims.exp > now)) &&
        claims.exp > claims.iat &&
        claims.exp - claims.iat <= 60,
    );
    return claims;
  }
  private async runtime(input: GuardianTransportEnvelope) {
    this.active();
    await this.resampleIssuedAt(input);
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
    const input = guardianTransportEnvelopeSchema.parse(raw);
    if (["apply_reserve", "apply_verify", "apply_commit"].includes(input.action))
      requireGuardian(this.env.HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED === "true");
    const runtime = await this.runtime(input);
    this.active();
    if (
      input.action === "cleanup_prepare" ||
      input.action === "cleanup_status" ||
      input.action === "cleanup_ack"
    ) {
      requireGuardian(runtime.phase === "tree_closed" || runtime.phase === "open");
      requireGuardian(input.runtimeGeneration === runtime.generation);
      const cleanup = await import("@/lib/delivery/checkout-cleanup.server");
      if (input.action === "cleanup_ack")
        return cleanup.acknowledgeCheckoutCleanup(this.db, runtime, input.receipt, input.projectId);
      requireGuardian(input.projectId === input.request.projectId);
      if (input.action === "cleanup_status")
        return cleanup.readCheckoutCleanup(
          this.db,
          runtime,
          input.request,
          this.config.privateKeyPem,
        );
      requireGuardian(this.dependencies.resolveCleanupVolume);
      const binding = await this.resolve(
        {
          hiveUserId: runtime.ownerId,
          coderUserId: (runtime.binding as unknown as RegistrationBinding).ownerId,
        },
        runtime.workspaceId,
      );
      const closure = await import("@/lib/delivery/epic-closure.server"),
        closed = await this.db.codexGuardianRuntime.findFirstOrThrow({
          where: { ownerId: runtime.ownerId, id: input.request.closedRuntimeId },
        }),
        scope = await closure.closedTaskScope(this.db, closed, input.projectId);
      requireGuardian(!scope.epicId || this.env.HIVE_DELIVERY_EPICS_ENABLED === "true");
      const volume = await this.dependencies.resolveCleanupVolume(binding, runtime.lifetimeId);
      this.active();
      this.live(input);
      return cleanup.prepareCheckoutCleanup(
        this.db,
        runtime,
        input.request,
        volume,
        this.config.privateKeyPem,
        undefined,
        input.expiresAt,
      );
    }
    if (
      input.action === "epic_release_prepare" ||
      input.action === "epic_release_submit" ||
      input.action === "epic_archive_ack"
    ) {
      requireGuardian(
        runtime.phase === "tree_closed" && input.runtimeGeneration === runtime.generation,
      );
      // Standalone tasks use the same completion-only authority, with their
      // immutable closure facts retained in existing task events.
      const lifecycle = await import("@/lib/delivery/epic-closure.server");
      const scope = await lifecycle.closedTaskScope(this.db, runtime, input.projectId);
      requireGuardian(!scope.epicId || this.env.HIVE_DELIVERY_EPICS_ENABLED === "true");
      if (input.action === "epic_release_prepare")
        return lifecycle.prepareEpicRelease(this.db, runtime, input.projectId);
      if (input.action === "epic_release_submit")
        return lifecycle.submitEpicRelease(
          this.db,
          runtime,
          input.projectId,
          input.releaseReceipt,
          this.config.privateKeyPem,
        );
      if (input.action === "epic_archive_ack")
        return lifecycle.acknowledgeEpicArchive(
          this.db,
          runtime,
          input.projectId,
          input.archiveDigest,
          input.sourceArchiveDigest,
        );
    }
    const parsedOperation = guardianOperationEnvelopeSchema.safeParse(input);
    const operation = parsedOperation.success
      ? {
          ownerId: runtime.ownerId,
          runtimeId: runtime.id,
          eventId: parsedOperation.data.eventId,
          action: parsedOperation.data.action,
          inputRuntimeGeneration: parsedOperation.data.runtimeGeneration,
          requestDigest: guardianDigest(parsedOperation.data),
          projectId:
            parsedOperation.data.action === "prepare"
              ? parsedOperation.data.preparation.projectId
              : parsedOperation.data.action === "checkout"
                ? parsedOperation.data.checkout.projectId
                : parsedOperation.data.projectId,
          recovery: parsedOperation.data.recovery,
        }
      : undefined;
    const store = this.requestStore(input.expiresAt, operation);
    if (input.action === "operation_readback") {
      const original = input.originalRequest;
      requireGuardian(
        original.runtimeId === runtime.id &&
          input.runtimeGeneration === original.runtimeGeneration &&
          input.lifetimeId === runtime.lifetimeId &&
          input.configSha256 === runtime.configSha256 &&
          verify(
            null,
            Buffer.from(guardianTransportProofPayload(original)),
            createPublicKey(runtime.outerPublicKeyPem),
            Buffer.from(original.proof, "base64url"),
          ),
      );
      const receipt = await store.operationReadback({
        ownerId: runtime.ownerId,
        runtimeId: runtime.id,
        eventId: original.eventId,
        action: original.action,
        inputRuntimeGeneration: original.runtimeGeneration,
        requestDigest: guardianDigest(original),
      });
      requireGuardian(receipt);
      return {
        accepted: true,
        historical: true,
        executionAuthorized: false,
        nonce: input.nonce,
        runtimeId: runtime.id,
        lifetimeId: runtime.lifetimeId,
        configSha256: runtime.configSha256,
        eventId: original.eventId,
        requestDigest: receipt.requestDigest,
        action: receipt.action,
        inputRuntimeGeneration: receipt.inputRuntimeGeneration,
        resultRuntimeGeneration: receipt.resultRuntimeGeneration,
        resultAdmissionGeneration: receipt.resultAdmissionGeneration,
        committedAt: receipt.committedAt.getTime(),
        result: receipt.response,
      };
    }
    if (input.action === "enrollment_readback") {
      const original = input.originalEnrollment;
      const claims = this.claims(original.grant, true);
      const binding = runtime.binding as unknown as RegistrationBinding;
      const key = createPublicKey(runtime.outerPublicKeyPem);
      requireGuardian(
        original.runtimeId === runtime.id &&
          input.runtimeGeneration === 1 &&
          input.lifetimeId === runtime.lifetimeId &&
          input.configSha256 === runtime.configSha256 &&
          input.grantId === claims.jti &&
          input.tokenDigest === sha(original.grant) &&
          input.consumptionDigest === guardianDigest(original) &&
          verify(
            null,
            Buffer.from(guardianTransportProofPayload(original)),
            key,
            Buffer.from(original.proof, "base64url"),
          ) &&
          claims.runtimeId === runtime.id &&
          claims.hiveUserId === runtime.ownerId &&
          claims.workspaceId === runtime.workspaceId &&
          claims.buildId === runtime.buildId &&
          claims.lifetimeId === runtime.lifetimeId &&
          claims.coderOwnerId === binding.ownerId &&
          claims.agentId === binding.agentId &&
          claims.appId === binding.appId &&
          claims.outerKeyFingerprint === fingerprint(runtime.outerPublicKeyPem) &&
          claims.bindingDigest === runtime.bindingDigest &&
          claims.identityDigest === input.identityDigest &&
          claims.startupDigest === input.startupDigest &&
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
      const historical = await store.enrollmentReadback({
        ownerId: runtime.ownerId,
        runtimeId: runtime.id,
        runtimeGeneration: input.runtimeGeneration,
        grantId: input.grantId,
        tokenDigest: input.tokenDigest,
        claimsDigest: guardianDigest(claims),
        consumptionDigest: input.consumptionDigest,
      });
      return {
        accepted: true,
        runtimeId: runtime.id,
        runtimeGeneration: 1,
        nonce: input.nonce,
        grantId: input.grantId,
        tokenDigest: input.tokenDigest,
        consumptionDigest: input.consumptionDigest,
        identityDigest: input.identityDigest,
        lifetimeId: input.lifetimeId,
        configSha256: input.configSha256,
        startupDigest: input.startupDigest,
        ...historical,
        empty: true,
      };
    }
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
    if (
      input.action === "apply_reserve" ||
      input.action === "apply_verify" ||
      input.action === "apply_commit"
    ) {
      const scope = await this.nativeScope(runtime, input.projectId);
      const application = new GuardianSourceApplicationStore(this.db, {
        policy: this.policy,
        expectedRuntime: { id: runtime.id, generation: input.runtimeGeneration },
        signal: this.dependencies.signal,
        authorizationExpiresAt: input.expiresAt,
      });
      if (input.action === "apply_reserve")
        return application.reserve(scope, {
          projectId: input.projectId,
          applicationId: input.applicationId,
          publicationOperationId: input.publicationOperationId,
          expectedAppliedSourceContext: input.expectedAppliedSourceContext,
          targetSourceContext: input.targetSourceContext,
          idleSnapshot: input.idleSnapshot,
          inputBarrier: input.inputBarrier,
        });
      if (input.action === "apply_verify") return application.verify(scope, input.applicationId);
      return application.commit(scope, input.applicationId, input.appliedReceipt);
    }
    const common = {
      ownerId: runtime.ownerId,
      runtimeId: runtime.id,
      runtimeGeneration: input.runtimeGeneration,
    };
    if (input.action === "drain_ready") return store.drainReady(common);
    if (input.action === "tree_closed")
      return store.closeTree({ ...common, barrierId: input.barrierId, receipt: input.receipt });
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
        authorityVersion: input.authorityVersion,
      });
    if (input.action === "native") {
      // Exact native retries are factual even if current registration state has
      // changed. Consult committed evidence before deriving a new native scope.
      requireGuardian(operation);
      const historical = await this.requestStore(input.expiresAt).operationReadback(
        operation,
        false,
      );
      if (historical) return historical.response;
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
        ...(input.maintenanceRebind ? { maintenanceRebind: input.maintenanceRebind } : {}),
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
    if (input.action === "maintenance_resume_ready") {
      requireGuardian(this.env.HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED === "true");
      return store.maintenanceResumeReady({
        ...common,
        maintenanceId: input.maintenanceId,
        ownerIntentRuntimeId: input.ownerIntentRuntimeId,
        ownerIntentEventId: input.ownerIntentEventId,
      });
    }
    if (input.action === "maintenance_close") {
      requireGuardian(this.env.HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED === "true");
      return store.closeMaintenanceBarrier({
        ...common,
        maintenanceId: input.maintenanceId,
        barrierId: input.barrierId,
        ownershipDigest: input.ownershipDigest,
        projectBindings: input.projectBindings,
        snapshots: input.snapshots,
      });
    }
    let emptyCloseGrantDigest: string | undefined;
    let closeStore = store;
    if (input.emptyCloseGrant) {
      requireGuardian(input.projectBindings.length === 0 && input.snapshots.length === 0);
      const historical = ["barrier_closed", "tree_closed"].includes(runtime.phase);
      const claims = this.emptyCloseClaims(input.emptyCloseGrant, historical);
      const binding = runtime.binding as unknown as RegistrationBinding;
      requireGuardian(
        claims.runtimeId === runtime.id &&
          claims.hiveUserId === runtime.ownerId &&
          claims.coderOwnerId === binding.ownerId &&
          claims.workspaceId === runtime.workspaceId &&
          claims.buildId === runtime.buildId &&
          claims.lifetimeId === runtime.lifetimeId &&
          claims.runtimeGeneration === input.runtimeGeneration,
      );
      emptyCloseGrantDigest = sha(input.emptyCloseGrant);
      // First closure must retain owner authority through lock waits and commit.
      // Exact committed-barrier replay remains factual after the grant expires.
      if (!historical) closeStore = this.requestStore(Math.min(input.expiresAt, claims.exp * 1000));
    }
    return closeStore.closeBarrier({
      ...common,
      ...(emptyCloseGrantDigest ? { emptyCloseGrantDigest } : {}),
      barrierId: input.barrierId,
      ownershipDigest: input.ownershipDigest,
      projectBindings: input.projectBindings,
      snapshots: input.snapshots,
    });
  }
}
