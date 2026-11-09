import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { retainCheckoutClosure } from "./checkout-closure-ledger.server";
import { executionActorHistory } from "./execution-authority.server";
import type { ImmutableGitHubArtifactStore } from "./github-persistence.server";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { repositoryPolicyStore } from "./repository-policy.server";
import { DeliveryConflict } from "./state";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function preserveEpicTask(
  db: PrismaClient,
  artifacts: ImmutableGitHubArtifactStore,
  ownerId: string,
  epicId: string | null,
  intentId: string,
) {
  const snapshot = async (tx: Prisma.TransactionClient) => {
    const tasks = await tx.deliveryTask.findMany({
      where: { ownerId, epicId, managerBinding: { is: { preparationIntentId: intentId } } },
      include: {
        project: true,
        managerBinding: true,
        conversation: true,
        currentSourceRevision: true,
      },
      take: 2,
    });
    const task = tasks.length === 1 ? tasks[0] : null;
    if (
      !task?.managerBinding ||
      !task.conversation ||
      !task.currentSourceRevision ||
      task.conversation.workspaceId !== task.managerBinding.workspaceId ||
      task.conversation.buildId !== task.managerBinding.buildId ||
      task.conversation.nativeThreadId !== task.managerBinding.nativeThreadId ||
      !(await verifyReleaseEvidence(tx, repositoryPolicyStore(db), {
        ownerId,
        taskId: task.id,
        sourceSha: task.sourceSha,
      }))
    )
      throw new DeliveryConflict("epic_completion_unverified");
    const events = await tx.deliveryEvent.findMany({
      where: { ownerId, taskId: task.id, NOT: { type: { startsWith: "checkout_" } } },
      include: { report: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 257,
    });
    if (!events.length || events.length > 256 || !events.some((event) => event.report))
      throw new DeliveryConflict("epic_preservation_incomplete");
    const evidence = await tx.deliveryEvidence.findMany({
      where: { ownerId, step: { taskId: task.id } },
      orderBy: { id: "asc" },
      take: 257,
    });
    if (evidence.length > 256) throw new DeliveryConflict("epic_preservation_incomplete");
    const actors = await executionActorHistory(tx, task.managerBinding);
    const actorSessions = await tx.codexRegisteredThread.findMany({
      where: {
        ownerId,
        projectId: task.projectId,
        conversationId: task.conversation.id,
        registration: { serverInstanceId: { in: Array.from(actors.keys()) } },
      },
      select: {
        nativeThreadId: true,
        registration: { select: { serverInstanceId: true, buildId: true } },
      },
      orderBy: [{ registrationId: "asc" }, { nativeThreadId: "asc" }],
      take: 1025,
    });
    if (
      actorSessions.length > 1024 ||
      Array.from(actors.keys()).some(
        (id) => !actorSessions.some((s) => s.registration.serverInstanceId === id),
      )
    )
      throw new DeliveryConflict("epic_preservation_incomplete");
    return { task, events, evidence, actors: Array.from(actors.keys()).sort(), actorSessions };
  };
  const before = await db.$transaction(snapshot, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
  const binding = before.task.managerBinding;
  if (!binding) throw new DeliveryConflict("epic_completion_unverified");
  const session = {
    ownerId,
    workspaceId: binding.workspaceId,
    buildId: binding.buildId,
    nativeThreadId: binding.nativeThreadId,
    retention: "local-session-directory",
  };
  const sessionDigest = sha(new TextEncoder().encode(JSON.stringify(session)));
  const body = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      ownerId,
      epicId,
      intentId,
      taskId: before.task.id,
      projectId: before.task.projectId,
      source: before.task.currentSourceRevision,
      events: before.events.map((event) => ({
        id: event.id,
        stepId: event.stepId,
        attemptId: event.attemptId,
        type: event.type,
        policyVersion: event.policyVersion,
        requestDigest: event.requestDigest,
        createdAt: event.createdAt,
        report: event.report,
      })),
      evidence: before.evidence,
      session,
      sessionDigest,
      actorServerInstanceIds: before.actors,
      actorSessions: before.actorSessions,
    }),
  );
  if (body.length > 2 * 1024 * 1024) throw new DeliveryConflict("epic_preservation_incomplete");
  const artifactDigest = sha(body),
    artifactKey = `delivery/${ownerId}/github/${before.task.project.providerRepositoryId}/${before.task.sourceSha}/${artifactDigest}.json`;
  const saved = await artifacts.writeAndVerify(artifactKey, body, artifactDigest);
  if (saved.contentDigest !== artifactDigest || saved.size !== body.length)
    throw new DeliveryConflict("epic_preservation_unverified");
  return db.$transaction(
    async (tx) => {
      const after = await snapshot(tx);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new DeliveryConflict("epic_preservation_changed");
      if (!epicId) {
        await retainCheckoutClosure(
          tx,
          { ownerId, taskId: before.task.id, intentId },
          "preserved",
          { sourceSha: before.task.sourceSha, artifactKey, artifactDigest, sessionDigest },
        );
        return { artifactDigest, sessionDigest, artifactKey };
      }
      await tx.$executeRaw`INSERT INTO delivery_epic_preservations(owner_id,epic_id,intent_id,task_id,source_sha,artifact_key,artifact_digest,session_digest) VALUES (${ownerId}::uuid,${epicId}::uuid,${intentId}::uuid,${before.task.id}::uuid,${before.task.sourceSha},${artifactKey},${artifactDigest},${sessionDigest}) ON CONFLICT DO NOTHING`;
      const rows = await tx.$queryRaw<
        { artifact_digest: string; session_digest: string }[]
      >`SELECT artifact_digest,session_digest FROM delivery_epic_preservations WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${intentId}::uuid`;
      if (
        rows.length !== 1 ||
        rows[0].artifact_digest !== artifactDigest ||
        rows[0].session_digest !== sessionDigest
      )
        throw new DeliveryConflict("epic_preservation_changed");
      return { artifactDigest, sessionDigest, artifactKey };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
