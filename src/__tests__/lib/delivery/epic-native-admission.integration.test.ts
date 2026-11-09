import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { epicDigest } from "@/lib/delivery/epic-contracts";
import { expectedEpicIntent, writeEpicPlan } from "@/lib/delivery/epic-plan.server";
import { reserveEpicStart } from "@/lib/delivery/epic-start.server";
import { isGitHubSerializationConflict } from "@/lib/delivery/github-persistence.server";
import { guardianFixture } from "../codex-session/guardian-fixture";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    !new URL(url).pathname.startsWith("/hive_acceptance_test"))
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!url)("epic admission through the actual native-launch fence", () => {
  it.each([
    "isolated",
    "closed_history",
    "disabled",
    "unknown",
    "cross_epic",
    "same_domain",
    "rotated_domain",
    "stale_build",
    "expired",
    "wrong_plan",
    "revoked",
    "expires_during_commit",
    "revoke_race",
  ] as const)("%s coordinator and reserved child", async (mode) => {
    const f = await acceptanceCandidateFixture(db);
    for (const flag of [
      "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
      "HIVE_DELIVERY_EXECUTION_ENABLED",
      "HIVE_DELIVERY_MANAGER_ENABLED",
      "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
    ])
      vi.stubEnv(flag, "true");
    vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(f.store.producer));
    const epicId = randomUUID(),
      requestId = randomUUID(),
      nextRequestId = randomUUID();
    const intentId = expectedEpicIntent(f.user.id, f.project.id, requestId);
    await db.deliveryEpic.create({
      data: {
        id: epicId,
        ownerId: f.user.id,
        projectId: f.project.id,
        outcome: "Isolated fixture epic",
        criteria: ["acceptance:behavior"],
      },
    });
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { epicId } });
    if (mode === "closed_history") {
      // Explicit historical-state double, not a claim of 33 process exits.
      // Real FK/immutable triggers remain active; current launch uses the store.
      for (let generation = 1000; generation < 1033; generation++) {
        await db.$transaction(async (tx) => {
          const historicalRegistration = randomUUID(),
            historicalRuntime = randomUUID(),
            barrier = randomUUID(),
            historicalAdmission = randomUUID();
          await tx.$executeRaw`INSERT INTO codex_host_registrations SELECT (jsonb_populate_record(NULL::codex_host_registrations,
          to_jsonb(r)||jsonb_build_object('id',${historicalRegistration},'generation',${generation}))).*
          FROM codex_host_registrations r WHERE r.id=${f.registration().id}::uuid`;
          await tx.$executeRaw`INSERT INTO codex_guardian_runtimes SELECT (jsonb_populate_record(NULL::codex_guardian_runtimes,
          to_jsonb(r)||jsonb_build_object('id',${historicalRuntime},'lifetime_id',${randomUUID()},'phase','tree_closed','closed_barrier_id',${barrier}))).*
          FROM codex_guardian_runtimes r WHERE r.id=${f.guardian.runtime.id}::uuid`;
          await tx.$executeRaw`INSERT INTO codex_guardian_barriers(id,owner_id,runtime_id,generation,ownership_digest,request_digest,closed_at)
          VALUES (${barrier}::uuid,${f.user.id}::uuid,${historicalRuntime}::uuid,2,${"a".repeat(64)},${"b".repeat(64)},clock_timestamp())`;
          const body = {
            explicitHistoricalFixture: true,
            runtimeId: historicalRuntime,
            barrierId: barrier,
          };
          await tx.$executeRaw`INSERT INTO codex_guardian_tree_receipts(owner_id,runtime_id,barrier_id,receipt_id,digest,body)
          VALUES (${f.user.id}::uuid,${historicalRuntime}::uuid,${barrier}::uuid,${randomUUID()}::uuid,${guardianDigest(body)},${JSON.stringify(body)}::jsonb)`;
          await tx.$executeRaw`INSERT INTO codex_guardian_admissions SELECT (jsonb_populate_record(NULL::codex_guardian_admissions,
          to_jsonb(a)||jsonb_build_object('id',${historicalAdmission},'runtime_id',${historicalRuntime},'registration_id',${historicalRegistration}))).*
          FROM codex_guardian_admissions a WHERE a.id=${f.guardian.bound.admission.id}::uuid`;
          await tx.$executeRaw`INSERT INTO codex_registered_threads SELECT (jsonb_populate_record(NULL::codex_registered_threads,
          to_jsonb(t)||jsonb_build_object('id',${randomUUID()},'registration_id',${historicalRegistration}))).*
          FROM codex_registered_threads t WHERE t.registration_id=${f.registration().id}::uuid`;
        });
      }
    }
    const launch = guardianFixture(db, {
      existing: { user: f.user, project: f.project, preparationIntentId: intentId, requestId },
      beforeIntent: async ({ user, project, context }) => {
        const selection = await f.policies.enroll(user.id, project.id);
        return db.$transaction((tx) =>
          f.policies.pinIntent(
            tx,
            {
              ownerId: user.id,
              projectId: project.id,
              repositoryId: project.providerRepositoryId,
              providerAccountId: project.providerAccountId,
              sourceSha: context.revision,
              text: f.originalIntent,
            },
            selection,
          ),
        );
      },
      physical: {
        revision: "a".repeat(40),
        leaseId: randomUUID(),
        leaseGeneration: 1,
        checkoutIncarnation: randomUUID(),
        checkoutIdentity: { device: "700", inode: "701" },
        gitIdentity: { device: "700", inode: "702" },
      },
      beforeNativeLaunch: async (stage) => {
        const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
          where: { id: stage.runtimeId },
        });
        const isolation = {
          schemaVersion: 1,
          workspaces: [
            {
              ownerId: f.user.id,
              workspaceId: f.host.workspaceId,
              buildId: f.host.buildId,
              isolationDomain: `author-${epicId}`,
              validUntil: Date.now() + 120000,
            },
            {
              ownerId: f.user.id,
              workspaceId: runtime.workspaceId,
              buildId: runtime.buildId,
              isolationDomain: `child-${epicId}`,
              validUntil: Date.now() + 120000,
            },
          ],
        };
        const text1 = "Implement isolated behavior",
          text2 = "Integrate isolated behavior";
        const digest = (text: string) => createHash("sha256").update(text).digest("hex");
        const first = {
          intentId,
          requestId,
          workspaceId: runtime.workspaceId,
          expectedRevision: "a".repeat(40),
          textDigest: digest(text1),
          criteria: ["acceptance:behavior"],
          dependsOn: [],
          role: "implementation",
        };
        const plan = {
          schemaVersion: 1,
          epicId,
          projectId: f.project.id,
          ownerIntentDigest: f.plan.intentDigest,
          outcomeDigest: epicDigest("Isolated fixture epic"),
          criteria: ["acceptance:behavior"],
          version: 1,
          previousPlanDigest: null,
          maxConcurrentTasks: 1,
          tasks: [
            first,
            {
              ...first,
              intentId: expectedEpicIntent(f.user.id, f.project.id, nextRequestId),
              requestId: nextRequestId,
              workspaceId: randomUUID(),
              role: "integration",
              dependsOn: [intentId],
              textDigest: digest(text2),
            },
          ],
        };
        await db.$transaction((tx) =>
          writeEpicPlan(
            tx,
            f.user.id,
            f.taskId,
            {
              plan,
              inputs: [
                { intentId, text: text1 },
                { intentId: plan.tasks[1].intentId, text: text2 },
              ],
            },
            "19".repeat(32),
          ),
        );
        await db.$transaction((tx) =>
          reserveEpicStart(tx, db, f.user.id, epicId, intentId, isolation),
        );
        vi.stubEnv("HIVE_DELIVERY_EPICS_ENABLED", mode === "disabled" ? "false" : "true");
        vi.stubEnv("ENCRYPTION_KEY", "19".repeat(32));
        vi.stubEnv("HIVE_CODEX_MANAGER_MODEL", "gpt-6.1-sol");
        vi.stubEnv("HIVE_CODEX_MANAGER_EFFORT", "low");
        if (mode === "same_domain")
          isolation.workspaces[1].isolationDomain = isolation.workspaces[0].isolationDomain;
        if (mode === "rotated_domain")
          isolation.workspaces[1].isolationDomain = `rotated-${epicId}`;
        if (mode === "stale_build") isolation.workspaces[0].buildId = randomUUID();
        if (mode === "expired") isolation.workspaces[0].validUntil = 1;
        vi.stubEnv("HIVE_DELIVERY_EPIC_ISOLATION_POLICY", JSON.stringify(isolation));
        if (mode === "unknown")
          await db.deliveryTask.update({ where: { id: f.taskId }, data: { epicId: null } });
        if (mode === "cross_epic") {
          const other = await db.deliveryEpic.create({
            data: {
              ownerId: f.user.id,
              projectId: f.project.id,
              outcome: "Other epic",
              criteria: ["acceptance:behavior"],
            },
          });
          await db.deliveryTask.update({ where: { id: f.taskId }, data: { epicId: other.id } });
        }
        if (mode === "wrong_plan") {
          // The actual plan writer rejects changing a started node before any
          // launch. Do not bypass its immutable plan contract to fake a head.
          await expect(
            db.$transaction((tx) =>
              writeEpicPlan(
                tx,
                f.user.id,
                f.taskId,
                {
                  plan: {
                    ...plan,
                    version: 2,
                    previousPlanDigest: epicDigest(plan),
                    tasks: [{ ...first, expectedRevision: "c".repeat(40) }, plan.tasks[1]],
                  },
                  inputs: [
                    { intentId, text: text1 },
                    { intentId: plan.tasks[1].intentId, text: text2 },
                  ],
                },
                "19".repeat(32),
              ),
            ),
          ).rejects.toThrow("epic_started_task_immutable");
          expect(
            (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: stage.runtimeId } }))
              .nativeLaunchId,
          ).toBeNull();
          throw Error("negative_case_complete");
        }
        if (mode === "revoked")
          await db.codexHostRegistration.update({
            where: { id: f.registration().id },
            data: { revokedAt: new Date() },
          });
        if (!["isolated", "closed_history"].includes(mode)) {
          const nativeLaunchId = randomUUID();
          const request = {
            ownerId: stage.ownerId,
            runtimeId: stage.runtimeId,
            runtimeGeneration: stage.runtimeGeneration,
            nativeLaunchId,
            projectIds: [f.project.id],
            launchIntentDigest: guardianDigest({
              runtimeId: stage.runtimeId,
              runtimeGeneration: stage.runtimeGeneration,
              nativeLaunchId,
              inventory: [
                {
                  admissionId: stage.bound.admission.id,
                  admissionGeneration: stage.bound.admission.generation,
                  checkout: stage.checkout,
                },
              ],
            }),
          };
          const call = () => stage.store.reserveNativeLaunch(request);
          if (mode === "expires_during_commit") {
            const name = `epic_fixture_delay_${randomUUID().replaceAll("-", "")}`;
            await db.$executeRawUnsafe(
              `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$`,
            );
            await db.$executeRawUnsafe(
              `CREATE TRIGGER ${name} BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW WHEN (NEW.id='${stage.runtimeId}'::uuid AND OLD.native_launch_id IS NULL AND NEW.native_launch_id IS NOT NULL) EXECUTE FUNCTION ${name}()`,
            );
            isolation.workspaces[1].validUntil = Date.now() + 1500;
            vi.stubEnv("HIVE_DELIVERY_EPIC_ISOLATION_POLICY", JSON.stringify(isolation));
            const began = Date.now();
            try {
              await expect(call()).rejects.toBeInstanceOf(RegistrationRejected);
              expect(Date.now() - began).toBeGreaterThanOrEqual(1900);
            } finally {
              await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON codex_guardian_runtimes`);
              await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
            }
          } else if (mode === "revoke_race") {
            let locked!: () => void, release!: () => void;
            const ready = new Promise<void>((done) => {
              locked = done;
            });
            const gate = new Promise<void>((done) => {
              release = done;
            });
            const revoke = db.$transaction(async (tx) => {
              await tx.codexHostRegistration.update({
                where: { id: f.registration().id },
                data: { revokedAt: new Date() },
              });
              locked();
              await gate;
            });
            await ready;
            const pending = call();
            let waiting = false;
            try {
              const end = Date.now() + 3000;
              while (Date.now() < end) {
                const rows = await db.$queryRaw<
                  { waiting: boolean }[]
                >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                  WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF s,r%') AS waiting`;
                if (rows[0].waiting) {
                  waiting = true;
                  break;
                }
                await new Promise((done) => setTimeout(done, 20));
              }
            } finally {
              release();
            }
            await revoke;
            const failure = await pending.then(
              () => null,
              (error: unknown) => error,
            );
            expect(
              failure instanceof RegistrationRejected || isGitHubSerializationConflict(failure),
            ).toBe(true);
            expect(waiting).toBe(true);
          } else await expect(call()).rejects.toBeInstanceOf(RegistrationRejected);
          expect(
            (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: stage.runtimeId } }))
              .nativeLaunchId,
          ).toBeNull();
          throw Error("negative_case_complete");
        }
      },
    });
    if (["isolated", "closed_history"].includes(mode)) {
      const child = await launch;
      expect(
        (
          await db.codexGuardianRuntime.findUniqueOrThrow({
            where: { id: child.guardian.runtime.id },
          })
        ).producerApproved,
      ).toBe(true);
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.guardian.runtime.id } }))
          .phase,
      ).toBe("open");
      expect(
        (
          await db.deliveryManagerBinding.findUniqueOrThrow({
            where: { id: f.claim.managerBindingId },
          })
        ).activeAttemptId,
      ).toBe(f.claim.attemptId);
      expect(
        (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } }))
          .quiescedAt,
      ).toBeNull();
    } else await expect(launch).rejects.toThrow("negative_case_complete");
  }, 15000);
});
