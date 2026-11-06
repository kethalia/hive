import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { nativeDigest } from "@/lib/delivery/release-native-preview-contracts";
import { nativeReleaseRoute } from "@/lib/delivery/release-native-preview-route.server";
import { packReleaseArtifact } from "../../../../scripts/release/artifact.mjs";
import { zipArchive } from "../../../../scripts/release/native-preview-fixture";
import { runtimeGrantsSql } from "../../../../services/migrate/src/runtime-grants.mjs";
import { nativeInstalledFixture } from "./native-preview-installed-fixture";
import { prepareNativeNormalRelease } from "./native-preview-normal-fixture";

const url = process.env.HIVE_NATIVE_RELEASE_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_native_release_test")
)
  throw Error("Local native fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_native_release_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
const signal = () => AbortSignal.timeout(30000);
describe.skipIf(!url)("installed native Preview publication PostgreSQL composition", () => {
  it("provisions both runtime roles after migration with append privileges and leaves database CONNECT ACL unchanged", async () => {
    // Role DDL and privileges are rolled back: no shared cluster role survives.
    const rollback = Error("fixture rollback");
    await expect(
      db.$transaction(async (tx) => {
        for (const role of ["hive_app_runtime", "hive_native_runtime"]) {
          await tx.$executeRawUnsafe(
            `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
          );
        }
        await tx.$executeRawUnsafe(
          "REVOKE CONNECT ON DATABASE hive_native_release_test FROM PUBLIC",
        );
        await tx.$executeRawUnsafe(
          "GRANT CONNECT ON DATABASE hive_native_release_test TO hive_app_runtime",
        );
        await tx.$executeRawUnsafe(
          "REVOKE CONNECT ON DATABASE hive_native_release_test FROM hive_native_runtime",
        );
        const before =
          await tx.$queryRaw`SELECT datacl::text AS datacl FROM pg_database WHERE datname=current_database()`;
        for (const role of ["hive_app_runtime", "hive_native_runtime"]) {
          await tx.$executeRawUnsafe(runtimeGrantsSql("public", role));
          for (const table of [
            "delivery_native_release_artifacts",
            "delivery_native_release_baselines",
            "delivery_native_publication_grants",
            "delivery_native_publication_receipts",
          ]) {
            const [privilege] = await tx.$queryRaw<
              {
                read: boolean;
                insert: boolean;
                update: boolean;
                delete: boolean;
                truncate: boolean;
              }[]
            >`SELECT has_table_privilege(${role},${table},'SELECT') AS read,has_table_privilege(${role},${table},'INSERT') AS insert,has_table_privilege(${role},${table},'UPDATE') AS update,has_table_privilege(${role},${table},'DELETE') AS delete,has_table_privilege(${role},${table},'TRUNCATE') AS truncate`;
            expect(privilege).toEqual({
              read: true,
              insert: true,
              update: false,
              delete: false,
              truncate: false,
            });
          }
        }
        expect(
          await tx.$queryRaw`SELECT datacl::text AS datacl FROM pg_database WHERE datname=current_database()`,
        ).toEqual(before);
        expect(
          await tx.$queryRaw`SELECT has_database_privilege('hive_native_runtime',current_database(),'CONNECT') AS native_connect,has_database_privilege('hive_app_runtime',current_database(),'CONNECT') AS app_connect`,
        ).toEqual([{ native_connect: false, app_connect: true }]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("composes genuine accepted source/tested tree and merge into native publication then compatible retained-byte recovery", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    await f.publish();
    expect(await f.native.step(f.scope.ownerId, f.scope.artifactId, signal())).toBe("observed");
    await f.native.observe(f.scope.ownerId, f.scope.releaseId, signal());
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await f.native.observe(f.scope.ownerId, f.scope.releaseId, signal());
    f.config.publicConfig.vars = {
      ...f.config.publicConfig.vars,
      HIVE_GENERIC_TERMINAL_ENABLED: "true",
    };
    const normal = await prepareNativeNormalRelease(db, f);
    const selected = {
      ...f.scope,
      purpose: "publish" as const,
      releaseId: normal.opened.releaseId,
      artifactReleaseId: normal.opened.releaseId,
      artifactId: crypto.randomUUID(),
      sourceSha: normal.mergedSha,
      builderRunId: "14",
      builderArtifactId: "15",
    };
    const candidateBytes = await packReleaseArtifact(
      new Map([
        [
          "app/worker.js",
          Buffer.from('throw Error("different candidate bytes must never execute")'),
        ],
        ["assets/index.html", Buffer.from("different candidate static asset")],
      ]),
    );
    f.builds.set("14", {
      artifactId: "15",
      sourceSha: normal.mergedSha,
      zip: zipArchive(candidateBytes),
    });
    // The external automatic writer is only the current concurrency witness;
    // it never replaces the independently accepted recovery artifact.
    f.state.current = "another-unattested-auto-build";
    await f.publish(selected);
    expect(await normal.native.step(selected.ownerId, selected.artifactId, signal())).toBe(
      "observed",
    );
    expect(await normal.native.observe(selected.ownerId, selected.releaseId, signal())).toBe(
      "sampling",
    );
    f.state.unhealthy = true;
    expect(
      await normal.native.observe(selected.ownerId, selected.releaseId, signal()),
    ).toMatchObject({ phase: "held" });
    f.state.unhealthy = false;
    const failedCurrent = f.state.current;
    f.state.current = "external-writer-after-regression";
    expect(await normal.native.planner.advance(selected.ownerId, selected.releaseId)).toBe("held");
    expect(
      await db.$queryRaw`SELECT id FROM delivery_release_actions WHERE release_id=${selected.releaseId}::uuid AND kind='recover'`,
    ).toEqual([]);
    f.state.current = failedCurrent;
    const incompatible = f.install({
      ...normal.controllerConfig,
      compatibilityRevision: crypto.randomUUID(),
    });
    await expect(
      incompatible.planner.advance(selected.ownerId, selected.releaseId),
    ).rejects.toThrow();
    f.install(normal.controllerConfig);
    expect(await normal.native.planner.advance(selected.ownerId, selected.releaseId)).toBe(
      "prepared",
    );
    const recover = (
      await db.$queryRaw<
        { id: string; request: Record<string, unknown> }[]
      >`SELECT id,request FROM delivery_release_actions WHERE release_id=${selected.releaseId}::uuid AND kind='recover'`
    )[0];
    expect(recover.request.artifactId).toBe(f.scope.artifactId);
    expect(recover.request.expectedCurrentDeploymentId).toBe(f.state.current);
    await f.publish({
      ...f.scope,
      purpose: "recover" as const,
      releaseId: selected.releaseId,
      actionId: recover.id,
    });
    const recoveredGrant = (
      await db.$queryRaw<
        { grant_data: { artifact: { archiveDigest: string } } }[]
      >`SELECT grant_data FROM delivery_native_publication_grants WHERE action_id=${recover.id}::uuid`
    )[0];
    const publishedGrant = (
      await db.$queryRaw<
        { grant_data: { artifact: { archiveDigest: string } } }[]
      >`SELECT grant_data FROM delivery_native_publication_grants WHERE action_id=${selected.artifactId}::uuid`
    )[0];
    expect(recoveredGrant.grant_data.artifact.archiveDigest).toBe(f.artifact.archiveDigest);
    expect(recoveredGrant.grant_data.artifact.archiveDigest).not.toBe(
      publishedGrant.grant_data.artifact.archiveDigest,
    );
    const retained = await normal.native.publications.artifact(
      selected.ownerId,
      f.scope.artifactId,
    );
    expect(retained.publicConfig.vars).not.toHaveProperty("HIVE_GENERIC_TERMINAL_ENABLED");
    expect(f.state.deployments.get(f.state.current)!.env).not.toHaveProperty(
      "HIVE_GENERIC_TERMINAL_ENABLED",
    );
    expect(await normal.native.step(selected.ownerId, recover.id, signal())).toBe("observed");
    expect(await normal.native.observe(selected.ownerId, selected.releaseId, signal())).toBe(
      "sampling",
    );
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(
      await normal.native.observe(selected.ownerId, selected.releaseId, signal()),
    ).toMatchObject({ phase: "recovered" });
    expect(f.state.writes).toHaveLength(9);
    expect((await normal.native.publications.resolveBaseline()).artifactId).toBe(
      f.scope.artifactId,
    );
    expect(
      f.state.requests.some((r) => /\/versions\/|\/workers\/scripts\/hive\/deployments/.test(r)),
    ).toBe(false);
  }, 60000);
  it("attests completed builder, locks grant before asset/native writes, persists receipt before readback, and accepts sampled baseline", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    await f.publish();
    expect(f.state.writes).toHaveLength(3);
    const receipt = await db.$queryRaw<
      { receipt: Record<string, unknown> }[]
    >`SELECT receipt FROM delivery_native_publication_receipts WHERE action_id=${f.scope.artifactId}::uuid`;
    expect(receipt).toHaveLength(1);
    expect(receipt[0].receipt.deploymentId).toBe(f.state.current);
    expect(receipt[0].receipt).not.toHaveProperty("versionId");
    expect(await f.native.step(f.scope.ownerId, f.scope.artifactId, signal())).toBe("observed");
    expect(await f.native.observe(f.scope.ownerId, f.scope.releaseId, signal())).toBe("sampling");
    // More than 1000 early observations must not permanently hide the later
    // successful sample needed to finish the window. These are explicit
    // persisted-provider fixture samples, not a claim of live health coverage.
    const first = (
      await db.$queryRaw<
        { evidence: Record<string, unknown> }[]
      >`SELECT evidence FROM delivery_release_observations WHERE release_id=${f.scope.releaseId}::uuid AND kind='stage_ready' LIMIT 1`
    )[0].evidence;
    const early = Array.from({ length: 1000 }, (_, index) => {
      const evidence = { ...first, fixtureIndex: index };
      return { evidence, digest: nativeDigest(evidence) };
    });
    await db.$executeRaw`INSERT INTO delivery_release_observations(id,release_id,kind,evidence,evidence_digest) SELECT gen_random_uuid(),${f.scope.releaseId}::uuid,'stage_ready',entry->'evidence',entry->>'digest' FROM jsonb_array_elements(${JSON.stringify(early)}::jsonb) entry`;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(await f.native.observe(f.scope.ownerId, f.scope.releaseId, signal())).toMatchObject({
      phase: "healthy",
    });
    const baseline = await f.native.publications.resolveBaseline();
    expect(baseline.artifactId).toBe(f.scope.artifactId);
    expect(baseline).not.toHaveProperty("deploymentId");
    expect(JSON.stringify({ baseline, receipt })).not.toContain(
      "provider-secret-must-never-escape",
    );
    await expect(f.native.lifecycle.openNativeBootstrap()).rejects.toThrow();
    const body = { actionId: f.scope.artifactId, ownerId: f.scope.ownerId, publisher: f.publisher };
    await expect(
      f.native.publications.grant(body, f.token("grant", body), signal()),
    ).rejects.toThrow();
  }, 60000);
  it("never redispatches after a native POST ACK loss and has no recoverable bootstrap baseline", async () => {
    const f = await nativeInstalledFixture(db, { bootstrapTtlMs: 2500 });
    await f.native.lifecycle.openNativeBootstrap();
    f.state.losePostAck = true;
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toHaveLength(3);
    expect(await db.$queryRaw`SELECT action_id FROM delivery_native_publication_receipts`).toEqual(
      [],
    );
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toHaveLength(3);
    expect(await f.native.planner.advance(f.scope.ownerId, f.scope.releaseId)).toBe("waiting");
    expect(await f.native.step(f.scope.ownerId, f.scope.artifactId, signal())).toBe("publishing");
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(await f.native.step(f.scope.ownerId, f.scope.artifactId, signal())).toBe("held");
    expect(
      (
        await db.$queryRaw<
          { phase: string }[]
        >`SELECT phase FROM delivery_release_actions WHERE id=${f.scope.artifactId}::uuid`
      )[0].phase,
    ).toBe("held");
    await expect(f.native.publications.resolveBaseline()).rejects.toThrow();
  }, 60000);
  it("rolls back effect_started and grant together when a database delay crosses the grant deadline", async () => {
    const f = await nativeInstalledFixture(db, { bootstrapTtlMs: 2000 });
    await f.native.lifecycle.openNativeBootstrap();
    await f.native.stageArtifact(f.artifact, f.token("artifact", f.artifact), signal());
    await db.$executeRawUnsafe(
      "CREATE FUNCTION native_fixture_grant_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.1); RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER zz_native_fixture_grant_delay BEFORE INSERT ON delivery_native_publication_grants FOR EACH ROW EXECUTE FUNCTION native_fixture_grant_delay()",
    );
    try {
      const body = {
        actionId: f.scope.artifactId,
        ownerId: f.scope.ownerId,
        publisher: f.publisher,
      };
      await expect(
        f.native.publications.grant(body, f.token("grant", body), signal()),
      ).rejects.toThrow();
      expect(
        (
          await db.$queryRaw<
            { phase: string }[]
          >`SELECT phase FROM delivery_release_actions WHERE id=${f.scope.artifactId}::uuid`
        )[0].phase,
      ).toBe("prepared");
      expect(await db.$queryRaw`SELECT id FROM delivery_native_publication_grants`).toEqual([]);
      expect(f.state.writes).toEqual([]);
    } finally {
      await db.$executeRawUnsafe(
        "DROP TRIGGER zz_native_fixture_grant_delay ON delivery_native_publication_grants",
      );
      await db.$executeRawUnsafe("DROP FUNCTION native_fixture_grant_delay()");
    }
  }, 60000);
  it("recovers only durable returned-ID receipt after receipt ACK loss without another provider write", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    f.state.loseReceiptAck = true;
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toHaveLength(3);
    expect(await f.native.step(f.scope.ownerId, f.scope.artifactId, signal())).toBe("observed");
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toHaveLength(3);
  }, 60000);
  it("consumes a grant once even when its response is lost before any provider write", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    f.state.loseGrantAck = true;
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toEqual([]);
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toEqual([]);
  }, 60000);
  it("allows one concurrent grant only and rejects a signed foreign-owner artifact", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    const foreign = { ...f.artifact, ownerId: crypto.randomUUID() };
    await expect(
      f.native.stageArtifact(foreign, f.token("artifact", foreign), signal()),
    ).rejects.toThrow();
    expect(await db.$queryRaw`SELECT id FROM delivery_native_release_artifacts`).toEqual([]);
    await f.native.stageArtifact(f.artifact, f.token("artifact", f.artifact), signal());
    const body = { actionId: f.scope.artifactId, ownerId: f.scope.ownerId, publisher: f.publisher };
    const results = await Promise.allSettled(
      [1, 2].map(() => f.native.publications.grant(body, f.token("grant", body), signal())),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.$queryRaw`SELECT id FROM delivery_native_publication_grants`).toHaveLength(1);
    expect(f.state.writes).toEqual([]);
  }, 60000);
  it("denies a stale target generation and a paused task after issuing the grant", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    await f.native.stageArtifact(f.artifact, f.token("artifact", f.artifact), signal());
    const body = { actionId: f.scope.artifactId, ownerId: f.scope.ownerId, publisher: f.publisher };
    const grant = await f.native.publications.grant(body, f.token("grant", body), signal());
    const reauthorize = { ...body, grantId: grant.id };
    await db.$executeRaw`UPDATE delivery_tasks SET pause_requested=true WHERE id=${f.source.taskId}::uuid`;
    await expect(
      f.native.publications.reauthorize(reauthorize, f.token("reauthorize", reauthorize), signal()),
    ).rejects.toThrow();
    await db.$executeRaw`UPDATE delivery_tasks SET pause_requested=false WHERE id=${f.source.taskId}::uuid`;
    await db.$executeRaw`UPDATE delivery_releases SET phase='held' WHERE id=${f.scope.releaseId}::uuid`;
    await expect(
      f.native.publications.reauthorize(reauthorize, f.token("reauthorize", reauthorize), signal()),
    ).rejects.toThrow();
    // Isolated fixture simulates a stale persisted grant under a different
    // target fence; ordinary SQL transition guard separately forbids this jump.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role=replica");
      await tx.$executeRaw`UPDATE delivery_release_targets SET generation=generation+1 WHERE target_digest=${grant.artifact.targetDigest}`;
    });
    await expect(
      f.native.publications.reauthorize(reauthorize, f.token("reauthorize", reauthorize), signal()),
    ).rejects.toThrow();
    expect(f.state.writes).toEqual([]);
  }, 60000);
  it("requires fresh authority again after durable receipt/readback and ignores secret payloads in public evidence", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    await f.publish();
    const pending = await f.native.publications.pendingReceipt(f.scope.ownerId, f.scope.artifactId);
    expect(pending).not.toBeNull();
    const before = await f.native.readback.verify(pending!.grant, pending!.receipt, signal());
    for (const name of f.config.publicConfig.secretNames)
      f.state.deployments.get(f.state.current)!.env[name].text = `changed-${name}`;
    const after = await f.native.readback.verify(pending!.grant, pending!.receipt, signal());
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("changed-");
    await db.$executeRaw`UPDATE delivery_tasks SET pause_requested=true WHERE id=${f.source.taskId}::uuid`;
    expect(await f.native.publications.record(f.scope.ownerId, pending!.identity, after)).toBe(
      false,
    );
    expect(
      await db.$queryRaw`SELECT action_id FROM delivery_native_publication_receipts`,
    ).toHaveLength(1);
  }, 60000);
  it("durably holds an unverified bootstrap health sample without silently accepting it on a later tick", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    await f.publish();
    await f.native.step(f.scope.ownerId, f.scope.artifactId, signal());
    f.state.unhealthy = true;
    expect(await f.native.observe(f.scope.ownerId, f.scope.releaseId, signal())).toMatchObject({
      phase: "held",
    });
    f.state.unhealthy = false;
    expect(await f.native.observe(f.scope.ownerId, f.scope.releaseId, signal())).toBe("waiting");
    expect(await f.native.planner.advance(f.scope.ownerId, f.scope.releaseId)).toBe("held");
    await expect(f.native.publications.resolveBaseline()).rejects.toThrow();
  }, 60000);
  it("holds current-ID drift during reconciliation and rejects immutable ledger tampering", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    await f.publish();
    let latestReads = 0;
    f.state.onRead = (path) => {
      if (path.endsWith("/deployments/latest") && ++latestReads === 3)
        f.state.current = "external-auto-build";
    };
    expect(await f.native.step(f.scope.ownerId, f.scope.artifactId, signal())).toBe("held");
    expect(
      (
        await db.$queryRaw<
          { phase: string }[]
        >`SELECT phase FROM delivery_release_actions WHERE id=${f.scope.artifactId}::uuid`
      )[0].phase,
    ).toBe("held");
    for (const table of [
      "delivery_native_release_artifacts",
      "delivery_native_publication_grants",
      "delivery_native_publication_receipts",
    ]) {
      await expect(
        db.$executeRawUnsafe(`UPDATE ${table} SET created_at=created_at`),
      ).rejects.toThrow("native_release_history_immutable");
      await expect(db.$executeRawUnsafe(`DELETE FROM ${table}`)).rejects.toThrow(
        "native_release_history_immutable",
      );
    }
    expect(f.state.writes).toHaveLength(3);
  }, 60000);
  it("holds external writer races before deployment POST and during readback; never attributes the automatic deployment", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    f.state.driftBeforePost = true;
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toHaveLength(2);
    expect(f.state.current).toBe("external-auto-deployment");
    expect(await db.$queryRaw`SELECT action_id FROM delivery_native_publication_receipts`).toEqual(
      [],
    );
  }, 60000);
  it("rejects unfinished builder and disabled/method/query/browser-origin ingress before any native effect", async () => {
    const f = await nativeInstalledFixture(db);
    await f.native.lifecycle.openNativeBootstrap();
    f.state.builderRunning = true;
    await expect(f.publish()).rejects.toThrow();
    f.state.builderRunning = false;
    f.state.callerChanged = true;
    await expect(f.publish()).rejects.toThrow();
    f.state.callerChanged = false;
    f.state.builderAttempt = 2;
    await expect(f.publish()).rejects.toThrow();
    expect(f.state.writes).toEqual([]);
    for (const [method, suffix, headers] of [
      ["GET", "", {}],
      ["POST", "?x=1", {}],
      ["POST", "", { origin: "https://example.invalid" }],
    ] as const) {
      const response = await nativeReleaseRoute(
        new Request(`https://controller.example/api/internal/native-release/artifact${suffix}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-hive-release-oidc": "fixture",
            ...headers,
          },
        }),
        "artifact",
        f.native,
      );
      expect(response.status).toBe(400);
    }
    expect(
      (await nativeReleaseRoute(new Request("https://controller.example"), "artifact", null))
        .status,
    ).toBe(404);
    expect(nativeDigest(f.artifact)).toMatch(/^[a-f0-9]{64}$/);
  }, 60000);
});
