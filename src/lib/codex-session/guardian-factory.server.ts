import { getDb } from "@hive/db";
import { createPortableAccountService } from "@/lib/agents/portable-config.server";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { signedHostProjectRequest } from "@/lib/projects/host.server";
import { projectTaskStatusSchema } from "@/lib/projects/task-contracts";
import { checkoutVolumeEvidenceSchema } from "../delivery/checkout-cleanup-contracts";
import {
  deliverGuardianEnrollment,
  provisionRegisteredHost,
  requestGuardianAccountMaintenance,
  requestGuardianEmptyClose,
  requestGuardianIdentity,
} from "./bootstrap-delivery.server";
import { guardianDeploymentPolicy, guardianDigest } from "./guardian-contracts";
import { verifyRemountResources } from "./guardian-remount.server";
import { guardianVolumeSchema } from "./guardian-remount-contracts";
import {
  type GuardianOwnerTransport,
  type GuardianProvisionStage,
  GuardianService,
} from "./guardian-service.server";
import {
  verifyUnstartedCoderLifecycle,
  verifyUnusedEpochCoderLifecycle,
} from "./guardian-unstarted-contracts";
import {
  createRegisteredSessionService,
  registeredSessionConfig,
} from "./registered-session.server";
import { resolveVerifiedWorkspaceHost } from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

export function createGuardianService(
  options: {
    signal?: AbortSignal;
    transport?: GuardianOwnerTransport;
    onProvisionStage?: (stage: GuardianProvisionStage) => void;
  } = {},
) {
  options.onProvisionStage?.("guardian_config");
  const db = getDb(),
    config = registeredSessionConfig(),
    policy = guardianDeploymentPolicy();
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new RegistrationRejected();
  const fetchApp: typeof fetch = (input, init) => {
    options.signal?.throwIfAborted();
    return fetch(input, {
      ...init,
      ...(options.signal
        ? { signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]) }
        : {}),
    });
  };
  const resolve = async (
    principal: { hiveUserId: string; coderUserId: string },
    workspaceId: string,
  ) => {
    options.signal?.throwIfAborted();
    const user = await db.user.findUnique({ where: { id: principal.hiveUserId } });
    if (!user || user.coderUserId !== principal.coderUserId) throw new RegistrationRejected();
    const coder = await getCoderClientForUser(
      user.id,
      options.signal ? { signal: options.signal } : undefined,
    );
    const { binding } = await resolveVerifiedWorkspaceHost(
      config,
      async () => coder,
      principal,
      workspaceId,
    );
    options.signal?.throwIfAborted();
    return { binding, coder };
  };
  const currentCoder = async (binding: Parameters<GuardianOwnerTransport["identity"]>[0]) => {
    const fresh = await resolve(
      { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId },
      binding.workspaceId,
    );
    if (guardianDigest(fresh.binding) !== guardianDigest(binding)) throw new RegistrationRejected();
    return fresh.coder;
  };
  return new GuardianService(db, config, policy, encryptionKey, {
    async resolveCleanupVolume(binding, lifetimeId) {
      const coder = await currentCoder(binding),
        workspace = await coder.getWorkspace(binding.workspaceId, options.signal),
        resources = await coder.getWorkspaceResources(binding.workspaceId, binding.buildId);
      if (
        workspace.latest_build.id !== binding.buildId ||
        !workspace.latest_build.template_version_id
      )
        throw new RegistrationRejected();
      const candidates = resources.filter(
        (r) =>
          r.type === "kubernetes_deployment_v1" &&
          r.name === "workspace" &&
          r.agents?.length === 1 &&
          r.agents[0].id === binding.agentId,
      );
      if (
        candidates.length !== 1 ||
        resources.flatMap((r) => r.agents ?? []).filter((a) => a.id === binding.agentId).length !==
          1
      )
        throw new RegistrationRejected();
      const entries = candidates[0].metadata?.filter((m) => m.key === "hive_home_volume_v1");
      if (
        entries?.length !== 1 ||
        entries[0].sensitive ||
        typeof entries[0].value !== "string" ||
        entries[0].value.length > 2048
      )
        throw new RegistrationRejected();
      const volume = guardianVolumeSchema.parse(JSON.parse(entries[0].value));
      if (
        volume.pvcName !== `coder-${binding.workspaceId}-home` ||
        volume.boundVolumeName !== `pvc-${volume.pvcUid}`
      )
        throw new RegistrationRejected();
      await currentCoder(binding);
      return checkoutVolumeEvidenceSchema.parse({
        templateVersionId: workspace.latest_build.template_version_id,
        buildId: binding.buildId,
        lifetimeId,
        resourceId: candidates[0].id,
        observedAt: Date.now(),
        volume,
        volumeDigest: guardianDigest(volume),
      });
    },
    async assertUnstartedPredecessorStopped(binding, oldBuildId, continuation, attestation) {
      if (oldBuildId === binding.buildId) throw new RegistrationRejected();
      const coder = await currentCoder(binding);
      const history = await coder.getWorkspaceBuildHistory(binding.workspaceId, options.signal);
      if (
        continuation
          ? !attestation ||
            !verifyUnusedEpochCoderLifecycle(history, {
              workspaceId: binding.workspaceId,
              oldBuildId,
              heldBuildId: continuation.unusedEpochHop.buildId,
              newBuildId: binding.buildId,
            })
          : !verifyUnstartedCoderLifecycle(history, {
              workspaceId: binding.workspaceId,
              oldBuildId,
              newBuildId: binding.buildId,
            })
      )
        throw new RegistrationRejected();
      if (continuation && attestation) {
        const workspace = await coder.getWorkspace(binding.workspaceId, options.signal);
        if (
          workspace.latest_build.id !== binding.buildId ||
          workspace.latest_build.template_version_id !== attestation.finalTemplateVersionId
        )
          throw new RegistrationRejected();
        verifyRemountResources(
          await coder.getWorkspaceResources(binding.workspaceId, binding.buildId),
          attestation,
          binding.agentId,
        );
      }
      const fresh = await currentCoder(binding);
      if (fresh.getBaseUrl() !== binding.coderOrigin) throw new RegistrationRejected();
    },
    async assertMaintenanceAccountsIdle(binding) {
      const principal = { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId };
      for (const provider of ["codex", "claude"] as const) {
        if (
          process.env[
            provider === "codex" ? "HIVE_CODEX_ACCOUNTS_ENABLED" : "HIVE_CLAUDE_ACCOUNTS_ENABLED"
          ] !== "true"
        )
          continue;
        const result = await createPortableAccountService(provider).execute(
          principal,
          binding.workspaceId,
          {
            operation: provider === "codex" ? "codex-account" : "claude-account",
            account: { action: "status", cached: true },
          },
          options.signal,
        );
        if (
          !result ||
          typeof result !== "object" ||
          !("state" in result) ||
          result.state === "pending"
        )
          throw new RegistrationRejected();
      }
    },
    async registerMaintenanceHost(binding, projects) {
      if (!projects.length) throw new RegistrationRejected();
      const user = await db.user.findUniqueOrThrow({ where: { id: binding.hiveUserId } }),
        p = projects[0];
      const status = projectTaskStatusSchema.parse(
        await signedHostProjectRequest(
          user,
          binding.workspaceId,
          "/projects/tasks/status",
          {
            schemaVersion: 1,
            projectId: p.projectId,
            taskId: p.preparationIntentId,
            requestId: p.requestId,
          },
          options.signal ? { signal: options.signal } : {},
        ),
      );
      if (status.phase !== "awaitingRegistration") return;
      const service = createRegisteredSessionService(db, config, { signal: options.signal });
      await provisionRegisteredHost(
        service.authority,
        await currentCoder(binding),
        { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId },
        binding.workspaceId,
        binding.agentId,
        projects.map((p) => p.projectId),
        { signal: options.signal },
      );
    },
    signal: options.signal,
    onProvisionStage: options.onProvisionStage,
    transport: options.transport ?? {
      async identity(binding, nonce) {
        const value = await requestGuardianIdentity(
          await currentCoder(binding),
          binding,
          nonce,
          fetchApp,
          options.signal,
        );
        options.signal?.throwIfAborted();
        return value;
      },
      async accountMaintenance(binding, grant) {
        return requestGuardianAccountMaintenance(
          await currentCoder(binding),
          binding,
          grant,
          fetchApp,
          options.signal,
        );
      },
      async recoverEmptyClose(binding, grant) {
        return requestGuardianEmptyClose(
          await currentCoder(binding),
          binding,
          grant,
          fetchApp,
          options.signal,
        );
      },
      async bootstrap(binding, grant) {
        const value = await deliverGuardianEnrollment(
          await currentCoder(binding),
          binding,
          grant,
          fetchApp,
          options.signal,
        );
        options.signal?.throwIfAborted();
        return value;
      },
    },
    async resolveWorkspace(principal, workspaceId) {
      return (await resolve(principal, workspaceId)).binding;
    },
  });
}
