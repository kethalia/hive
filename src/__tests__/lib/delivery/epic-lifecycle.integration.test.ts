import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { epicDigest } from "@/lib/delivery/epic-contracts";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { guardianFixture } from "../codex-session/guardian-fixture";

const mocks = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>() }));
vi.mock("@/lib/delivery/release-evidence.server", () => ({
  verifyReleaseEvidence: async () => true,
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({
    env: {
      HIVE_DELIVERY_EVIDENCE: {
        put: async (key: string, bytes: Uint8Array) => {
          if (!mocks.objects.has(key)) mocks.objects.set(key, bytes);
        },
        get: async (key: string) => {
          const bytes = mocks.objects.get(key);
          return bytes
            ? {
                key,
                size: bytes.length,
                body: new ReadableStream({
                  start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                  },
                }),
              }
            : null;
        },
      },
    },
  }),
}));

import {
  acknowledgeEpicArchive,
  prepareEpicRelease,
  submitEpicRelease,
} from "@/lib/delivery/epic-closure.server";
import { reserveEpicStart } from "@/lib/delivery/epic-start.server";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
describe.skipIf(!url)("epic PostgreSQL lifecycle with explicit provider and host doubles", () => {
  it("rotates bounded scheduler windows across zero, 16 and more epics", async () => {
    for (const count of [0, 16, 37]) {
      const seen = new Set<number>();
      for (let tick = 0; tick < Math.max(1, count); tick++) {
        const rows = await db.$queryRaw<{ position: bigint }[]>`
          WITH ranked AS (SELECT n-1 AS position,count(*) OVER () AS total FROM generate_series(1,${count}::int) n)
          SELECT position FROM ranked WHERE mod(position-mod(${tick}::bigint*16,total)+total,total)<16`;
        expect(rows.length).toBeLessThanOrEqual(16);
        for (const row of rows) seen.add(Number(row.position));
      }
      expect(seen.size).toBe(count);
    }
  });
  it("retains writer through preservation and tree closure, then permits the next guarded reservation using a squash receipt", async () => {
    const f = await guardianFixture(db);
    const manager = new DeliveryManagerService(db, {
      ...f.dependencies,
      guardianPolicy: f.guardian.policy,
      progressionProtocol: 1,
    });
    await manager.execute(
      f.managerEnvelope({
        operation: "create_task",
        payload: {
          ...f.definition,
          steps: [
            {
              id: f.stepId,
              kind: "understand",
              criterionIds: ["C1"],
              requiredEvidenceKinds: ["analysis"],
            },
          ],
        },
      }),
    );
    const claim = (await manager.execute(
      f.managerEnvelope({
        operation: "claim_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          expectedVersion: 0,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      }),
    )) as { attemptId: string; version: number; leaseGeneration: number; managerBindingId: string };
    await manager.execute(
      f.managerEnvelope({
        operation: "report_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          attemptId: claim.attemptId,
          expectedVersion: claim.version,
          leaseGeneration: claim.leaseGeneration,
          sourceSha: f.context.revision,
          report: {
            summary: "Fixture report",
            difficulty: "low",
            difficultyReason: "Fixture",
            issues: [],
            remainingUncertainty: "Mock providers",
            nextAction: "Continue",
          },
        },
      }),
    );
    const barrierId = randomUUID(),
      ownershipDigest = "a".repeat(64),
      bindingDigest = f.guardian.prepared.admission.preparationDigest;
    const closed = await f.guardian.store.closeBarrier({
      ownerId: f.user.id,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: 2,
      barrierId,
      ownershipDigest,
      projectBindings: [{ projectId: f.project.id, bindingDigest }],
      snapshots: [
        {
          projectId: f.project.id,
          admissionId: f.guardian.bound.admission.id,
          admissionGeneration: 3,
          managerBindingId: claim.managerBindingId,
          currentAttemptId: claim.attemptId,
          managerThreadId: f.managerThreadId,
          parentTurnId: f.parentTurnId,
          cursorVersion: 1,
          nativeSequence: 0,
          observedAt: new Date().toISOString(),
          historyDigest: "b".repeat(64),
          loadedInventoryDigest: "c".repeat(64),
          fullHistory: true,
          rootTurns: 1,
          historyBytes: 100,
          pendingHandlers: 0,
          pendingObservers: 0,
          unknownFacts: 0,
          activeRoots: 0,
        },
      ],
    });
    const treeReceipt = {
      schemaVersion: 1 as const,
      scope: "managed_native_tree_only" as const,
      cleanupAuthorized: false as const,
      guardianExited: true as const,
      receiptId: randomUUID(),
      lifetimeId: f.guardian.runtime.lifetimeId,
      bindingDigest: f.guardian.runtime.bindingDigest,
      ownershipDigest,
      projects: [{ projectId: f.project.id, bindingDigest }],
      launchSetDigest: "a".repeat(64),
      guardianSha256: f.guardian.runtime.guardianElfSha256,
      guardianIdentity: {
        pid: 100,
        startTime: "100",
        bootId: randomUUID(),
        executable: "/fixture/guardian",
        device: "1",
        inode: "2",
      },
      generation: closed.runtimeGeneration,
      closedRequestId: 3,
      drainRequestId: 4,
      finalWaitResult: "ECHILD" as const,
      waitFlags: "__WALL" as const,
      reaped: 2,
      decisions: [
        { projectId: f.project.id, bindingDigest, decisionId: closed.decisions[0].decisionId },
      ],
      workerBarrier: {
        closed: true as const,
        lifetimeId: f.guardian.runtime.lifetimeId,
        generation: 2,
        ownershipDigest,
        barrierId,
      },
      workerPid: 101,
      packageManifestSha256: f.guardian.runtime.packageManifestSha256,
      workerSha256: "b".repeat(64),
      nodeSha256: f.guardian.runtime.nodeSha256,
    };
    await f.guardian.store.closeTree({
      ownerId: f.user.id,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: closed.runtimeGeneration,
      barrierId,
      receipt: treeReceipt,
    });
    const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: f.guardian.runtime.id },
    });
    const epicId = randomUUID(),
      revisionId = randomUUID(),
      releaseId = randomUUID(),
      actionId = randomUUID(),
      nextIntent = randomUUID(),
      nextRequest = randomUUID(),
      mergeSha = "d".repeat(40),
      sourceSha = "b".repeat(40),
      treeSha = "e".repeat(40);
    const intent = await db.projectTaskIntent.findUniqueOrThrow({
      where: { id: f.context.preparationIntentId },
    });
    const plan = {
      schemaVersion: 1,
      epicId,
      projectId: f.project.id,
      ownerIntentDigest: "1".repeat(64),
      outcomeDigest: "2".repeat(64),
      criteria: ["C1"],
      version: 1,
      previousPlanDigest: null,
      maxConcurrentTasks: 1,
      tasks: [
        {
          intentId: intent.id,
          requestId: intent.requestId,
          workspaceId: f.host.workspaceId,
          expectedRevision: f.context.revision,
          textDigest: "3".repeat(64),
          criteria: ["C1"],
          dependsOn: [],
          role: "implementation",
        },
        {
          intentId: nextIntent,
          requestId: nextRequest,
          workspaceId: f.host.workspaceId,
          expectedRevision: mergeSha,
          textDigest: "4".repeat(64),
          criteria: ["C1"],
          dependsOn: [intent.id],
          role: "integration",
        },
      ],
    };
    const domain = `fixture-${randomUUID()}`;
    const planDigest = epicDigest(plan),
      rulesDigest = "9".repeat(64),
      targetDigest = "8".repeat(64);
    const request = {
      repositoryId: "123",
      pullRequestId: "456",
      pullNumber: 1,
      headSha: sourceSha,
      baseSha: "c".repeat(40),
      baseRef: "integration",
      rulesDigest,
      method: "squash",
    };
    const mergeReceipt = {
      provider: "github",
      repositoryId: "123",
      pullRequestId: "456",
      pullNumber: 1,
      headSha: sourceSha,
      baseSha: request.baseSha,
      mergeSha,
      requestId: randomUUID(),
      rulesDigest,
    };
    // Explicit synthetic provider evidence only; actual lifecycle transitions below run on PostgreSQL.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`INSERT INTO delivery_epics(id,owner_id,project_id,outcome,criteria,state) VALUES (${epicId}::uuid,${f.user.id}::uuid,${f.project.id}::uuid,'fixture','["C1"]'::jsonb,'pending')`;
      await tx.$executeRaw`INSERT INTO delivery_source_revisions(id,owner_id,task_id,manager_binding_id,step_id,producing_attempt_id,version,input_sha,head_sha,tree_sha,manifest_digest,operation_id,request_digest,producer,proof_digest,repository_id,provider_account_id,full_name,branch,base_branch,pull_request_id,pull_number) VALUES (${revisionId}::uuid,${f.user.id}::uuid,${f.taskId}::uuid,${claim.managerBindingId}::uuid,${f.stepId}::uuid,${claim.attemptId}::uuid,1,${f.context.revision},${sourceSha},${treeSha},${"1".repeat(64)},${randomUUID()}::uuid,${"2".repeat(64)},'protected-source-broker-v1',${"3".repeat(64)},'123','456','fixture/native','fixture','integration','456',1)`;
      await tx.$executeRaw`UPDATE delivery_tasks SET epic_id=${epicId}::uuid,source_sha=${sourceSha},source_revision_id=${revisionId}::uuid,source_version=1 WHERE id=${f.taskId}::uuid`;
      await tx.$executeRaw`INSERT INTO delivery_epic_plans(owner_id,epic_id,version,plan,plan_digest,authored_by_task_id) VALUES (${f.user.id}::uuid,${epicId}::uuid,1,${JSON.stringify(plan)}::jsonb,${planDigest},${f.taskId}::uuid)`;
      await tx.$executeRaw`INSERT INTO delivery_epic_plan_heads(owner_id,epic_id,version,plan_digest) VALUES (${f.user.id}::uuid,${epicId}::uuid,1,${planDigest})`;
      await tx.$executeRaw`INSERT INTO delivery_epic_start_intents(owner_id,epic_id,intent_id,plan_digest,workspace_id,build_id,isolation_domain,request_id,phase) VALUES (${f.user.id}::uuid,${epicId}::uuid,${intent.id}::uuid,${planDigest},${f.host.workspaceId}::uuid,${f.host.buildId}::uuid,${domain},${intent.requestId}::uuid,'accepted')`;
      await tx.$executeRaw`INSERT INTO delivery_epic_writer_reservations(owner_id,epic_id,intent_id,task_id,plan_digest,workspace_id,build_id,lease_id,checkout_incarnation,checkout_identity_digest,isolation_domain) VALUES (${f.user.id}::uuid,${epicId}::uuid,${intent.id}::uuid,${f.taskId}::uuid,${planDigest},${f.host.workspaceId}::uuid,${f.host.buildId}::uuid,${f.context.leaseId}::uuid,${f.guardian.checkout.checkoutIncarnation}::uuid,${epicDigest(f.guardian.checkout.checkoutIdentity)},${domain})`;
      await tx.$executeRaw`INSERT INTO delivery_releases(id,owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest,phase) VALUES (${releaseId}::uuid,${f.user.id}::uuid,${f.taskId}::uuid,${revisionId}::uuid,${targetDigest},${targetDigest},'{}'::jsonb,${targetDigest},'healthy')`;
      await tx.$executeRaw`INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation,phase,receipt,receipt_digest) VALUES (${actionId}::uuid,${releaseId}::uuid,'merge',${targetDigest},${JSON.stringify(request)}::jsonb,${githubSourceDigest(request)},1,'observed',${JSON.stringify(mergeReceipt)}::jsonb,${githubSourceDigest(mergeReceipt)})`;
    });
    const policy = {
      schemaVersion: 1,
      workspaces: [
        {
          ownerId: f.user.id,
          workspaceId: f.host.workspaceId,
          buildId: f.host.buildId,
          isolationDomain: domain,
          validUntil: Date.now() + 60000,
        },
      ],
    };
    await expect(
      db.$transaction((tx) => reserveEpicStart(tx, db, f.user.id, epicId, nextIntent, policy)),
    ).rejects.toThrow("epic_wip_limit");
    const prepared = await prepareEpicRelease(db, runtime, f.project.id);
    expect(mocks.objects.size).toBeGreaterThan(0);
    const release = {
      schemaVersion: 1 as const,
      repositoryId: "123",
      taskId: intent.id,
      leaseId: f.context.leaseId,
      leaseGeneration: f.context.leaseGeneration,
      revision: sourceSha,
      checkoutIncarnation: f.guardian.checkout.checkoutIncarnation,
      checkoutIdentity: f.guardian.checkout.checkoutIdentity,
      releasedAt: Date.now(),
    };
    const submitted = await submitEpicRelease(
      db,
      runtime,
      f.project.id,
      release,
      f.guardian.sessionConfig.privateKeyPem,
    );
    expect(submitted.token).toContain(".");
    expect(prepared.treeReceiptDigest).toBe(guardianDigest(treeReceipt));
    await acknowledgeEpicArchive(db, runtime, f.project.id, "5".repeat(64), "6".repeat(64));
    const reservation = await db.$transaction((tx) =>
      reserveEpicStart(tx, db, f.user.id, epicId, nextIntent, policy, [
        {
          dependency: intent.id,
          repositoryId: "123",
          base: mergeSha,
          head: mergeSha,
          status: "identical",
          mergeBase: mergeSha,
          releaseId,
          receiptDigest: githubSourceDigest(mergeReceipt),
        },
      ]),
    );
    expect(reservation.phase).toBe("reserved");
  }, 30000);
});
