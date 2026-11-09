import { createHash } from "node:crypto";
import { decrypt } from "@hive/auth";
import { Prisma, type PrismaClient } from "@hive/db";
import { startProjectTask } from "@/lib/projects/task.server";
import { epicIsolationSchema } from "./epic-claim.server";
import { epicDigest, epicPlanSchema } from "./epic-contracts";
import {
  type EpicDependencyLineage,
  epicDependencyLineageSchema,
  epicIntegrationDependency,
} from "./epic-dependency.server";
import { readEpicGitHubForTask } from "./epic-github-read.server";
import { observeEpicPreviewMerge } from "./epic-merge-observation.server";
import { reconcileEpicPreviewMerge } from "./epic-merge-reconcile.server";
import { reserveEpicStart } from "./epic-start.server";
import { repositoryPolicyStore } from "./repository-policy.server";
import { DeliveryConflict } from "./state";

/** One bounded scheduling pass. Ambiguous starts retain their reservation and
 * replay the deterministic project request; there is no per-task approval. */
export async function reconcileEpicStart(
  db: PrismaClient,
  rawPolicy: unknown,
  encryptionKey: string,
  modelTiers: readonly { tier: string; model: string; effort: string }[],
  signal?: AbortSignal,
) {
  const policy = epicIsolationSchema.parse(rawPolicy);
  const heads = await db.$queryRaw<
    {
      owner_id: string;
      epic_id: string;
      plan: unknown;
      plan_digest: string;
      workspace_id: string;
      build_id: string;
    }[]
  >`
    WITH eligible AS (
      SELECT h.owner_id,h.epic_id,p.plan,p.plan_digest,b.workspace_id,b.build_id
      FROM delivery_epic_plan_heads h
      JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
      JOIN delivery_tasks t ON t.owner_id=p.owner_id AND t.id=p.authored_by_task_id
      JOIN delivery_manager_bindings b ON b.owner_id=t.owner_id AND b.id=t.manager_binding_id
      WHERE NOT t.pause_requested AND NOT t.scheduling_paused
        AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(policy.workspaces)}::jsonb)
            AS enrollment("ownerId" uuid,"workspaceId" uuid,"buildId" uuid,"validUntil" bigint)
          WHERE enrollment."ownerId"=h.owner_id AND enrollment."workspaceId"=b.workspace_id
            AND enrollment."buildId"=b.build_id
            AND enrollment."validUntil">extract(epoch FROM statement_timestamp())*1000
        )
    ), ranked AS (
      SELECT *,row_number() OVER (ORDER BY epic_id)-1 AS position,count(*) OVER () AS total FROM eligible
    )
    SELECT owner_id,epic_id,plan,plan_digest,workspace_id,build_id FROM ranked
    WHERE mod(position-mod(floor(extract(epoch FROM statement_timestamp())/60)::bigint*16,total)+total,total)<16
    ORDER BY mod(position-mod(floor(extract(epoch FROM statement_timestamp())/60)::bigint*16,total)+total,total)`;
  for (const head of heads) {
    signal?.throwIfAborted();
    if (epicDigest(head.plan) !== head.plan_digest) continue;
    const plan = epicPlanSchema.parse(head.plan);
    const now = Date.now();
    const author = policy.workspaces.filter(
      (entry) =>
        entry.ownerId === head.owner_id &&
        entry.workspaceId === head.workspace_id &&
        entry.buildId === head.build_id &&
        entry.validUntil > now,
    );
    if (author.length !== 1) continue;
    for (const node of plan.tasks) {
      signal?.throwIfAborted();
      if (
        !modelTiers.some(
          (tier) =>
            tier.tier === node.modelTier &&
            tier.model === node.model &&
            tier.effort === node.effort,
        )
      )
        continue;
      const allocation = policy.workspaces.filter(
        (entry) =>
          entry.ownerId === head.owner_id &&
          entry.workspaceId === node.workspaceId &&
          entry.validUntil > now,
      );
      // The coordinator remains a physical writer. Its domain cannot be reused
      // until the trusted closure and archival protocol has completed.
      if (
        allocation.length !== 1 ||
        allocation[0].isolationDomain === author[0].isolationDomain ||
        node.workspaceId === head.workspace_id
      )
        continue;
      try {
        await reconcileEpicPreviewMerge(
          db,
          {
            ownerId: head.owner_id,
            epicId: head.epic_id,
            intentId: node.intentId,
            readerWorkspaceId: head.workspace_id,
            readerBuildId: head.build_id,
          },
          signal ?? AbortSignal.timeout(30000),
        );
        const read: typeof readEpicGitHubForTask = (client, scope, operation, readSignal) =>
          readEpicGitHubForTask(
            client,
            { ...scope, readerWorkspaceId: head.workspace_id, readerBuildId: head.build_id },
            operation,
            readSignal,
          );
        const lineage: EpicDependencyLineage[] = [];
        for (const dependency of node.dependsOn) {
          await observeEpicPreviewMerge(
            db,
            repositoryPolicyStore(db),
            { ownerId: head.owner_id, epicId: head.epic_id, intentId: dependency },
            read,
            signal,
          );
          const anchor = await epicIntegrationDependency(db, repositoryPolicyStore(db), {
            ownerId: head.owner_id,
            epicId: head.epic_id,
            intentId: dependency,
          });
          let proof: {
            repositoryId: string;
            base: string;
            head: string;
            status: "ahead" | "identical";
            mergeBase: string;
          };
          const lineageBegan = (
            await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
          )[0].now.getTime();
          try {
            const result = await read(
              db,
              { ownerId: head.owner_id, taskId: anchor.taskId },
              {
                operation: "lineage",
                baseSha: anchor.integrationSha,
                headSha: node.expectedRevision,
              },
              signal,
            );
            if (result.operation !== "lineage")
              throw new DeliveryConflict("epic_lineage_unverified");
            proof = {
              repositoryId: result.repository.providerRepositoryId,
              base: result.baseSha,
              head: result.headSha,
              status: result.status,
              mergeBase: result.mergeBaseSha,
            };
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof DeliveryConflict) throw error;
            throw new DeliveryConflict("epic_lineage_unavailable");
          }
          lineage.push(
            epicDependencyLineageSchema.parse({
              dependency,
              ...proof,
              ...(anchor.milestone === "implementation_preview"
                ? {
                    milestone: anchor.milestone,
                    readinessDigest: anchor.readiness.digest,
                    completionEventId: anchor.readiness.completionEventId,
                    sourceReceiptDigest: anchor.readiness.sourceReceiptDigest,
                    mergeDigest: anchor.mergeDigest,
                    observedAt: lineageBegan,
                    expiresAt: lineageBegan + 30000,
                  }
                : { releaseId: anchor.releaseId, receiptDigest: anchor.receiptDigest }),
            }),
          );
        }
        const reservation = await db.$transaction(
          (tx) =>
            reserveEpicStart(tx, db, head.owner_id, head.epic_id, node.intentId, policy, lineage),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5000,
            timeout: 10000,
          },
        );
        if (reservation.phase === "accepted") continue;
        const rows = await db.$queryRaw<
          { ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array; text_digest: string }[]
        >`
          SELECT ciphertext,iv,auth_tag,text_digest FROM delivery_epic_task_inputs
          WHERE owner_id=${head.owner_id}::uuid AND epic_id=${head.epic_id}::uuid AND plan_digest=${reservation.planDigest} AND intent_id=${node.intentId}::uuid`;
        if (rows.length !== 1) throw new DeliveryConflict("epic_plan_input_mismatch");
        const text = decrypt(
          {
            ciphertext: Buffer.from(rows[0].ciphertext),
            iv: Buffer.from(rows[0].iv),
            authTag: Buffer.from(rows[0].auth_tag),
          },
          encryptionKey,
        );
        if (
          createHash("sha256").update(text, "utf8").digest("hex") !== node.textDigest ||
          rows[0].text_digest !== node.textDigest
        )
          throw new DeliveryConflict("epic_plan_input_mismatch");
        const owner = await db.user.findUnique({ where: { id: head.owner_id } });
        if (!owner) throw new DeliveryConflict("epic_owner_unavailable");
        signal?.throwIfAborted();
        await startProjectTask({ id: owner.id, coderUserId: owner.coderUserId }, plan.projectId, {
          workspaceId: node.workspaceId,
          requestId: node.requestId,
          expectedRevision: node.expectedRevision,
          text,
        });
        await db.$executeRaw`UPDATE delivery_epic_start_intents SET phase='accepted' WHERE owner_id=${head.owner_id}::uuid AND epic_id=${head.epic_id}::uuid AND intent_id=${node.intentId}::uuid AND phase='reserved'`;
        return { started: true };
      } catch (error) {
        if (
          error instanceof DeliveryConflict &&
          [
            "epic_dependencies_pending",
            "epic_dependency_release_pending",
            "epic_wip_limit",
            "epic_writer_overlap",
            "epic_lineage_unavailable",
            "epic_lineage_unverified",
            "epic_start_changed",
          ].includes(error.code)
        )
          continue;
        throw error;
      }
    }
  }
  return { started: false };
}
