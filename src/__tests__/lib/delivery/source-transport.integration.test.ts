import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { SourcePublicationTransport } from "@/lib/delivery/source-transport.server";
import { sourceTransportProofPayload } from "@/lib/delivery/source-transport-contracts";
import { nativeFixture } from "./native-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
async function fixture(leaseMs?: number) {
  const f = await nativeFixture(db),
    manager = new DeliveryManagerService(db, { ...f.dependencies, progressionProtocol: 1 });
  await manager.execute(
    f.managerEnvelope({
      operation: "create_task",
      payload: {
        ...f.definition,
        steps: [
          {
            id: f.stepId,
            kind: "implement",
            criterionIds: ["C1"],
            requiredEvidenceKinds: ["check"],
          },
        ],
      },
    }),
  );
  const claim = z
    .object({
      attemptId: z.string(),
      managerBindingId: z.string(),
      leaseGeneration: z.number(),
      version: z.number(),
      nativeSequence: z.number(),
    })
    .parse(
      await manager.execute(
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
      ),
    );
  await f.native.ingest(
    f.sourceEnvelope(
      claim,
      {
        ...f.source,
        kind: "started",
        requestedModel: "gpt-6.1-sol",
        requestedEffort: "low",
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
      1,
    ),
  );
  await f.native.ingest(
    f.sourceEnvelope(claim, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
  );
  if (leaseMs)
    await db.deliveryAttempt.update({
      where: { id: claim.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
  const policy = {
    version: "local-transport-v1",
    authorName: "Hive",
    authorEmail: "codex@kethalia.com",
    baseBranch: "main",
    allowedPrefixes: ["src"],
    maxFiles: 5,
    maxFileBytes: 1024,
    maxBytes: 4096,
  };
  const admission = {
    runtimeId: randomUUID(),
    runtimeGeneration: 1,
    admissionId: randomUUID(),
    admissionGeneration: 1,
    producerDigest: "e".repeat(64),
    checkoutIncarnation: randomUUID(),
    barrierGeneration: 0,
  };
  let open = true,
    policyValue = policy,
    uploads = 0,
    uploadHook = async () => {};
  const stored = new Map<string, Buffer>();
  // Explicit injected authority for protocol tests, not a production guardian proof.
  const service = new SourcePublicationTransport(
    db,
    {
      reauthorize: f.dependencies.reauthorize,
      resolvePolicy: () => policyValue,
      lockProducerAdmission: async () => {
        if (!open) throw new Error("Fixture barrier closed");
        return admission;
      },
    },
    {
      writeAndVerify: async (key, bytes, digest) => {
        uploads++;
        const origin = process.env.HIVE_LOCAL_R2_PROOF_ORIGIN,
          bearer = process.env.HIVE_LOCAL_R2_PROOF_BEARER;
        if (origin) {
          const endpoint = new URL(origin);
          if (
            endpoint.protocol !== "http:" ||
            endpoint.hostname !== "127.0.0.1" ||
            endpoint.origin !== origin ||
            !bearer
          )
            throw new Error("Local R2 fixture only");
          const response = await fetch(origin, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
            body: JSON.stringify({
              operation: "artifact",
              key,
              contentBase64: Buffer.from(bytes).toString("base64"),
              digest,
            }),
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
          });
          if (response.status !== 200) throw new Error("Local R2 proof rejected");
          const readback = (await response.json()) as { contentDigest: string; size: number };
          if (readback.contentDigest !== digest || readback.size !== bytes.length)
            throw new Error("Local R2 proof mismatch");
        }

        const previous = stored.get(key);
        if (previous && !previous.equals(Buffer.from(bytes)))
          throw new Error("Immutable collision");
        stored.set(key, Buffer.from(bytes));
        await uploadHook();
        return { objectKey: key, contentDigest: digest, size: bytes.length };
      },
    },
  );
  const operationId = randomUUID(),
    manifest = {
      files: [
        {
          path: "src/change.ts",
          contentDigest: "c".repeat(64),
          size: 10,
          mode: "100644",
          blobSha: "f".repeat(40),
        },
      ],
      deletions: [],
    };
  function envelope(
    phase: "policy" | "challenge" | "publish",
    extra: Record<string, unknown> = {},
  ) {
    const value = {
      schemaVersion: 1,
      action: "publish_source_revision",
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      taskId: f.taskId,
      stepId: f.stepId,
      attemptId: claim.attemptId,
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
      ...extra,
    };
    return {
      ...value,
      proof: sign(
        null,
        Buffer.from(sourceTransportProofPayload(phase, value)),
        f.keys.privateKey,
      ).toString("base64url"),
    };
  }
  const policyRequest = () => envelope("policy", { requestId: randomUUID(), operationId });
  const challenge = (extra: Record<string, unknown> = {}) =>
    envelope("challenge", {
      requestId: randomUUID(),
      operationId,
      policyDigest: githubSourceDigest(policyValue),
      target: {
        headSha: "b".repeat(40),
        treeSha: "d".repeat(40),
        manifestDigest: githubSourceDigest(manifest),
      },
      manifest,
      ...extra,
    });
  async function prepare() {
    const request = challenge(),
      grant = await service.issue(request);
    const readback = {
      observedAt: new Date().toISOString(),
      providerAccountId: f.project.providerAccountId,
      repositoryId: f.project.providerRepositoryId,
      fullName: f.project.fullName,
      manifest,
      commit: {
        sha: grant.target.headSha,
        treeSha: grant.target.treeSha,
        parentSha: grant.parentSha,
      },
      reference: { name: `refs/heads/${grant.branch}`, sha: grant.target.headSha, type: "commit" },
      pullRequest: {
        id: "900",
        number: 7,
        headRepositoryId: grant.repositoryId,
        baseRepositoryId: grant.repositoryId,
        headRef: grant.branch,
        headSha: grant.target.headSha,
        baseRef: grant.policy.baseBranch,
        state: "open",
        draft: true,
      },
    };
    return {
      request,
      grant,
      readback,
      publish: envelope("publish", { challengeId: grant.id, nonce: grant.nonce, readback }),
    };
  }
  return {
    ...f,
    service,
    policy,
    admission,
    envelope,
    manifest,
    policyRequest,
    challenge,
    prepare,
    stored,
    get uploads() {
      return uploads;
    },
    close: () => {
      open = false;
    },
    changePolicy: () => {
      policyValue = { ...policy, authorName: "Changed" };
    },
    onUpload: (hook: () => Promise<void>) => {
      uploadHook = hook;
    },
  };
}

describe.skipIf(!url)(
  "Source publication signed transport (injected admission; real local PostgreSQL)",
  () => {
    it("reads fixed policy before seal and binds manifest/policy before issuing effects", async () => {
      const f = await fixture(),
        result = await f.service.policy(f.policyRequest());
      expect(result.policy.authorEmail).toBe("codex@kethalia.com");
      expect(result.parentSha).toBe(f.context.revision);
      const request = f.challenge();
      f.changePolicy();
      await expect(f.service.issue(request)).rejects.toMatchObject({
        code: "source_policy_changed",
      });
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "source_publication_grant" },
        }),
      ).toBe(0);
      expect(f.uploads).toBe(0);
    });
    it("rejects protected paths before any grant or upload", async () => {
      const f = await fixture(),
        manifest = { files: [{ ...f.manifest.files[0], path: "src/.git/config" }], deletions: [] };
      await expect(
        f.service.issue(
          f.challenge({
            manifest,
            target: {
              headSha: "b".repeat(40),
              treeSha: "d".repeat(40),
              manifestDigest: githubSourceDigest(manifest),
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "source_path_protected" });
      expect(f.uploads).toBe(0);
    });
    it("retains immutable signed proof and atomically consumes publication; exact lost-ACK replay preserves receipt", async () => {
      const f = await fixture(),
        p = await f.prepare();
      expect(await f.service.issue(p.request)).toEqual(p.grant);
      const first = await f.service.publish(p.publish),
        replay = await f.service.publish(p.publish);
      expect(replay).toMatchObject({ sourceContext: first.sourceContext, replayed: true });
      expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(1);
      const consumed = await db.deliveryEvent.findMany({
        where: { ownerId: f.user.id, type: "source_publication_consumed" },
      });
      expect(consumed).toHaveLength(1);
      expect(consumed[0].payload).toMatchObject({
        size: expect.any(Number),
        proofDigest: expect.any(String),
      });
      const artifact = JSON.parse([...f.stored.values()][0].toString());
      expect(artifact.envelope).toEqual(p.publish);
      expect(artifact.grant.policy.authorName).toBe("Hive");
      const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } });
      expect(task.sourceVersion).toBe(1);
      const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: task.managerBindingId! },
      });
      expect(binding.activeAttemptId).toBeTruthy();
    });
    it("rejects changed signed publication replay without a second receipt", async () => {
      const f = await fixture(),
        p = await f.prepare();
      await f.service.publish(p.publish);
      await expect(
        f.service.publish(
          f.envelope("publish", {
            challengeId: p.grant.id,
            nonce: p.grant.nonce,
            readback: { ...p.readback, observedAt: new Date(Date.now() - 1).toISOString() },
          }),
        ),
      ).rejects.toMatchObject({ code: "source_grant_already_consumed" });
    });
    it("revalidates guardian closure after upload and preserves orphan proof without source/nonce consumption", async () => {
      const f = await fixture(),
        p = await f.prepare();
      f.onUpload(async () => f.close());
      await expect(f.service.publish(p.publish)).rejects.toThrow("Fixture barrier closed");
      expect(f.stored.size).toBe(1);
      expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(0);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "source_publication_consumed" },
        }),
      ).toBe(0);
    });
    it("revalidates nonce revocation after upload and records only one internal revocation", async () => {
      const f = await fixture(),
        p = await f.prepare();
      f.onUpload(async () => {
        await f.service.revoke(f.user.id, p.grant.id, "Owner pause");
      });
      await expect(f.service.publish(p.publish)).rejects.toThrow();
      expect(f.stored.size).toBe(1);
      expect(await f.service.revoke(f.user.id, p.grant.id, "Owner pause")).toEqual({
        revoked: true,
        replayed: true,
      });
      expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(0);
    });
    it("rejects wrong PR branch/account and expired grant before upload", async () => {
      const f = await fixture(),
        p = await f.prepare();
      await expect(
        f.service.publish(
          f.envelope("publish", {
            challengeId: p.grant.id,
            nonce: p.grant.nonce,
            readback: { ...p.readback, providerAccountId: "999" },
          }),
        ),
      ).rejects.toMatchObject({ code: "source_readback_scope_mismatch" });
      const expired = await fixture(500),
        old = await expired.prepare();
      await new Promise((resolve) => setTimeout(resolve, 550));
      await expect(expired.service.publish(old.publish)).rejects.toThrow();
      expect(expired.uploads).toBe(0);
      expect(f.uploads).toBe(0);
    });
    it("serializes concurrent exact grant and publication retries", async () => {
      const f = await fixture(),
        request = f.challenge(),
        grants = await Promise.all([f.service.issue(request), f.service.issue(request)]);
      expect(grants[0]).toEqual(grants[1]);
      // A new operation cannot bypass the already-active physical source attempt.
      const p = { grant: grants[0] };
      const readback = {
        observedAt: new Date().toISOString(),
        providerAccountId: p.grant.providerAccountId,
        repositoryId: p.grant.repositoryId,
        fullName: p.grant.fullName,
        manifest: f.manifest,
        commit: {
          sha: p.grant.target.headSha,
          treeSha: p.grant.target.treeSha,
          parentSha: p.grant.parentSha,
        },
        reference: {
          name: `refs/heads/${p.grant.branch}`,
          sha: p.grant.target.headSha,
          type: "commit",
        },
        pullRequest: {
          id: "901",
          number: 8,
          headRepositoryId: p.grant.repositoryId,
          baseRepositoryId: p.grant.repositoryId,
          headRef: p.grant.branch,
          headSha: p.grant.target.headSha,
          baseRef: p.grant.policy.baseBranch,
          state: "open",
          draft: true,
        },
      };
      const value = f.envelope("publish", {
        challengeId: p.grant.id,
        nonce: p.grant.nonce,
        readback,
      });
      const results = await Promise.all([f.service.publish(value), f.service.publish(value)]);
      expect(results[0].sourceContext).toEqual(results[1].sourceContext);
      expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(1);
    });
    it("rejects cross-phase signatures and changed grant replay without authorizing effects", async () => {
      const f = await fixture(),
        request = f.challenge();
      await expect(f.service.policy(request)).rejects.toThrow();
      const grant = await f.service.issue(request);
      await expect(
        f.service.issue(
          f.challenge({
            requestId: grant.id,
            target: { ...grant.target, headSha: "c".repeat(40) },
          }),
        ),
      ).rejects.toMatchObject({ code: "source_grant_replay_conflict" });
      expect(f.uploads).toBe(0);
    });
    it("revalidates controller policy drift after retained upload without consuming the nonce", async () => {
      const f = await fixture(),
        p = await f.prepare();
      f.onUpload(async () => f.changePolicy());
      await expect(f.service.publish(p.publish)).rejects.toThrow();
      expect(f.stored.size).toBe(1);
      expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(0);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "source_publication_consumed" },
        }),
      ).toBe(0);
    });
    it("pins the first artifact reservation across lost upload ACK and rejects changed bytes", async () => {
      const f = await fixture(),
        p = await f.prepare();
      f.onUpload(async () => {
        throw new Error("Lost upload ACK");
      });
      await expect(f.service.publish(p.publish)).rejects.toThrow("Lost upload ACK");
      const reservations = await db.deliveryEvent.findMany({
        where: { ownerId: f.user.id, type: "source_publication_proof_reserved" },
      });
      expect(reservations).toHaveLength(1);
      expect(reservations[0].payload).toMatchObject({
        verified: false,
        proofDigest: expect.any(String),
        objectKey: expect.any(String),
      });
      await expect(
        f.service.publish(
          f.envelope("publish", {
            challengeId: p.grant.id,
            nonce: p.grant.nonce,
            readback: { ...p.readback, observedAt: new Date(Date.now() - 1).toISOString() },
          }),
        ),
      ).rejects.toMatchObject({ code: "source_proof_replay_conflict" });
      f.onUpload(async () => {});
      const accepted = await f.service.publish(p.publish);
      expect(accepted.executionAuthorized).toBe(false);
      expect(f.stored.size).toBe(1);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "source_publication_consumed" },
        }),
      ).toBe(1);
    });
    it("allows exact consumed receipt replay after original provider-readback freshness without new authority", async () => {
      const f = await fixture(),
        p = await f.prepare();
      const value = f.envelope("publish", {
        challengeId: p.grant.id,
        nonce: p.grant.nonce,
        readback: { ...p.readback, observedAt: new Date(Date.now() - 9000).toISOString() },
      });
      const first = await f.service.publish(value);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const second = await f.service.publish(value);
      expect(second.sourceContext).toEqual(first.sourceContext);
      expect(second.replayed).toBe(true);
      expect(second.executionAuthorized).toBe(false);
    });
  },
);
