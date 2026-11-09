import type { CodexGuardianAdmission, CodexGuardianRuntime, Prisma } from "@hive/db";
import type { GuardianPolicy } from "@/lib/codex-session/guardian-contracts";
import { effectiveUnstartedSuccessor } from "@/lib/codex-session/guardian-unstarted-store.server";
import { epicIsolationSchema } from "./epic-claim.server";
import { epicDigest, epicPlanSchema } from "./epic-contracts";

/** The ordinary project-wide tree-exit fence remains the default. Only a
 * reserved epic node may coexist with its own coordinator/other epic nodes,
 * on different deployment-enrolled storage domains. Models cannot supply this
 * policy or turn an unrelated live project runtime into an epic participant. */
export async function epicNativeAdmission(
  tx: Prisma.TransactionClient,
  input: {
    runtime: CodexGuardianRuntime;
    admission: CodexGuardianAdmission;
    priorRegistrationIds: string[];
    guardianPolicy: GuardianPolicy;
    isolationPolicy: unknown;
  },
) {
  const { runtime, admission } = input;
  const policy = epicIsolationSchema.safeParse(input.isolationPolicy);
  if (!policy.success || !input.priorRegistrationIds.length) return false;
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  const starts = await tx.$queryRaw<
    {
      epic_id: string;
      plan_digest: string;
      workspace_id: string;
      build_id: string;
      isolation_domain: string;
      phase: string;
    }[]
  >`SELECT epic_id,plan_digest,workspace_id,build_id,isolation_domain,phase FROM delivery_epic_start_intents
    WHERE owner_id=${runtime.ownerId}::uuid AND intent_id=${admission.preparationIntentId}::uuid LIMIT 2 FOR SHARE`;
  if (
    starts.length !== 1 ||
    !["reserved", "accepted"].includes(starts[0].phase) ||
    starts[0].workspace_id !== runtime.workspaceId ||
    !(await effectiveUnstartedSuccessor(tx, {
      ownerId: runtime.ownerId,
      taskId: admission.preparationIntentId,
      workspaceId: runtime.workspaceId,
      oldBuildId: starts[0].build_id,
      newBuildId: runtime.buildId,
    }))
  )
    return false;
  const start = starts[0];
  const heads = await tx.$queryRaw<
    { plan: unknown; plan_digest: string; authored_by_task_id: string }[]
  >`SELECT p.plan,p.plan_digest,p.authored_by_task_id FROM delivery_epic_plan_heads h
    JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
    WHERE h.owner_id=${runtime.ownerId}::uuid AND h.epic_id=${start.epic_id}::uuid FOR SHARE OF h`;
  if (heads.length !== 1 || epicDigest(heads[0].plan) !== heads[0].plan_digest) return false;
  const parsed = epicPlanSchema.safeParse(heads[0].plan);
  if (
    !parsed.success ||
    parsed.data.projectId !== admission.projectId ||
    parsed.data.epicId !== start.epic_id
  )
    return false;
  const plan = parsed.data;
  await tx.$queryRaw`SELECT id FROM delivery_tasks WHERE owner_id=${runtime.ownerId}::uuid AND id=${heads[0].authored_by_task_id}::uuid FOR SHARE`;
  const author = await tx.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId: runtime.ownerId, id: heads[0].authored_by_task_id } },
    include: { managerBinding: true },
  });
  if (
    !author?.managerBinding ||
    author.epicId !== start.epic_id ||
    author.projectId !== admission.projectId ||
    author.pauseRequested ||
    author.schedulingPaused ||
    author.managerBinding.blockedReason
  )
    return false;
  const enrolled = (workspaceId: string, buildId: string) => {
    const matches = policy.data.workspaces.filter(
      (entry) =>
        entry.ownerId === runtime.ownerId &&
        entry.workspaceId === workspaceId &&
        entry.validUntil > now.getTime(),
    );
    return matches.length === 1 && matches[0].buildId === buildId ? matches[0] : null;
  };
  const allocation = enrolled(runtime.workspaceId, runtime.buildId);
  if (!allocation || start.isolation_domain !== allocation.isolationDomain) return false;
  let validUntil = allocation.validUntil;
  const workspaces = new Set([runtime.workspaceId]),
    domains = new Set([allocation.isolationDomain]);
  const exactNode = async (
    intentId: string,
    workspaceId: string,
    buildId: string,
    isolationDomain: string,
  ) => {
    const node = plan.tasks.find((entry) => entry.intentId === intentId);
    if (!node || node.workspaceId !== workspaceId) return false;
    const pins = await tx.$queryRaw<
      {
        plan: unknown;
        plan_digest: string;
        phase: string;
        build_id: string;
        isolation_domain: string;
      }[]
    >`
      SELECT p.plan,p.plan_digest,s.phase,s.build_id,s.isolation_domain FROM delivery_epic_start_intents s
      JOIN delivery_epic_plans p ON p.owner_id=s.owner_id AND p.epic_id=s.epic_id AND p.plan_digest=s.plan_digest
      WHERE s.owner_id=${runtime.ownerId}::uuid AND s.epic_id=${start.epic_id}::uuid
      AND s.intent_id=${intentId}::uuid AND s.workspace_id=${workspaceId}::uuid FOR SHARE OF s`;
    if (
      pins.length !== 1 ||
      !(await effectiveUnstartedSuccessor(tx, {
        ownerId: runtime.ownerId,
        taskId: intentId,
        workspaceId,
        oldBuildId: pins[0].build_id,
        newBuildId: buildId,
      })) ||
      pins[0].isolation_domain !== isolationDomain ||
      !["reserved", "accepted"].includes(pins[0].phase) ||
      epicDigest(pins[0].plan) !== pins[0].plan_digest
    )
      return false;
    const pinned = epicPlanSchema.safeParse(pins[0].plan);
    const pinnedNode = pinned.success
      ? pinned.data.tasks.find((entry) => entry.intentId === intentId)
      : undefined;
    return pinnedNode !== undefined && epicDigest(pinnedNode) === epicDigest(node);
  };
  if (
    !(await exactNode(
      admission.preparationIntentId,
      runtime.workspaceId,
      runtime.buildId,
      allocation.isolationDomain,
    ))
  )
    return false;
  const priorIds = [...new Set(input.priorRegistrationIds)];
  if (priorIds.length > 32) return false;
  for (const registrationId of priorIds.sort()) {
    // Hold prior authority stable until the new launch commits. A serializable
    // read snapshot alone is insufficient to order a concurrent revocation.
    await tx.$queryRaw`SELECT r.id FROM codex_host_registrations r
      JOIN codex_host_slots s ON s.owner_id=r.owner_id AND s.id=r.slot_id
      WHERE r.owner_id=${runtime.ownerId}::uuid AND r.id=${registrationId}::uuid FOR UPDATE OF s,r`;
    await tx.$queryRaw`SELECT a.id FROM codex_guardian_admissions a
      JOIN codex_guardian_runtimes r ON r.owner_id=a.owner_id AND r.id=a.runtime_id
      WHERE a.owner_id=${runtime.ownerId}::uuid AND a.project_id=${admission.projectId}::uuid
      AND a.registration_id=${registrationId}::uuid FOR UPDATE OF a,r`;
    const prior = await tx.codexGuardianAdmission.findMany({
      where: { ownerId: runtime.ownerId, projectId: admission.projectId, registrationId },
      include: { runtime: true, registration: { include: { slot: true } } },
      take: 2,
    });
    if (prior.length !== 1) return false;
    const member = prior[0],
      host = member.runtime,
      registration = member.registration,
      domain = enrolled(host.workspaceId, host.buildId);
    if (
      !domain ||
      member.phase !== "native" ||
      host.phase !== "open" ||
      host.closedBarrierId ||
      !host.producerApproved ||
      !host.nativeLaunchId ||
      !host.serverInstanceId ||
      !member.nativeThreadId ||
      host.authorityUntil <= now ||
      !registration ||
      registration.revokedAt ||
      registration.expiresAt <= now ||
      registration.slot.activeRegistrationId !== registration.id ||
      registration.slot.generation !== registration.generation ||
      registration.buildId !== host.buildId ||
      registration.serverInstanceId !== host.serverInstanceId ||
      registration.hostKeyFingerprint !== host.hostKeyFingerprint ||
      workspaces.has(host.workspaceId) ||
      domains.has(domain.isolationDomain) ||
      !input.guardianPolicy.packages.some(
        (pin) =>
          pin.packageManifestSha256 === host.packageManifestSha256 &&
          pin.guardianElfSha256 === host.guardianElfSha256 &&
          pin.nodeSha256 === host.nodeSha256 &&
          pin.policyDigest === host.policyDigest &&
          pin.metadataPolicyDigest === host.metadataPolicyDigest,
      )
    )
      return false;
    await tx.$queryRaw`SELECT id FROM delivery_manager_bindings WHERE owner_id=${runtime.ownerId}::uuid
      AND preparation_intent_id=${member.preparationIntentId}::uuid ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT t.id FROM delivery_tasks t JOIN delivery_manager_bindings b
      ON b.owner_id=t.owner_id AND b.id=t.manager_binding_id
      WHERE b.owner_id=${runtime.ownerId}::uuid AND b.preparation_intent_id=${member.preparationIntentId}::uuid
      ORDER BY t.id FOR UPDATE OF t`;
    const bindings = await tx.deliveryManagerBinding.findMany({
      where: {
        ownerId: runtime.ownerId,
        preparationIntentId: member.preparationIntentId,
        workspaceId: host.workspaceId,
        buildId: host.buildId,
        serverInstanceId: host.serverInstanceId,
        nativeThreadId: member.nativeThreadId,
      },
      include: { tasks: true },
      take: 2,
    });
    if (
      bindings.length !== 1 ||
      bindings[0].blockedReason ||
      bindings[0].tasks.length !== 1 ||
      bindings[0].tasks[0].epicId !== start.epic_id ||
      bindings[0].tasks[0].projectId !== admission.projectId ||
      bindings[0].tasks[0].pauseRequested ||
      bindings[0].tasks[0].schedulingPaused
    )
      return false;
    if (
      bindings[0].id !== author.managerBinding.id &&
      !(await exactNode(
        member.preparationIntentId,
        host.workspaceId,
        host.buildId,
        domain.isolationDomain,
      ))
    )
      return false;
    workspaces.add(host.workspaceId);
    domains.add(domain.isolationDomain);
    validUntil = Math.min(
      validUntil,
      domain.validUntil,
      host.authorityUntil.getTime(),
      registration.expiresAt.getTime(),
    );
  }
  return { validUntil };
}
