import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import { releaseActionIdentitySchema } from "./release-action-journal";
import {
  releaseBuildManifestSchema,
  releaseBuildWorkflowSchema,
  verifyReleaseBuildChallenge,
  verifyReleaseBuildToken,
} from "./release-build-attestation.server";
import type { GitHubBuildRunVerifier } from "./release-build-run.server";
import type { CloudflareReleaseProvider } from "./release-cloudflare-provider.server";

/** Fixed release-build endpoint core. The token is never persisted. Its audience
 * authenticates exact manifest bytes; provider version metadata is fetched with
 * a fixed read-only credential outside the transaction. DB time, current
 * target/source/merge and the independent policy verifier are checked again
 * inside the insertion transaction. No route or trusted workflow is installed. */
export class ReleaseBuildStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly approvedWorkflow: unknown,
    private readonly provider: CloudflareReleaseProvider,
    private readonly authorize: (
      tx: Prisma.TransactionClient,
      identity: ReturnType<typeof releaseActionIdentitySchema.parse>,
    ) => Promise<boolean>,
    private readonly runVerifier: GitHubBuildRunVerifier,
    private readonly fetcher: typeof fetch = fetch,
    private readonly targetDigest?: string,
    private readonly publisherConfigDigest?: string,
  ) {
    if (
      !targetDigest ||
      !publisherConfigDigest ||
      !/^[a-f0-9]{64}$/.test(targetDigest) ||
      !/^[a-f0-9]{64}$/.test(publisherConfigDigest)
    )
      throw new Error("release_build_unavailable");
  }
  private authorityDigest() {
    return githubSourceDigest({
      workflow: releaseBuildWorkflowSchema.parse(this.approvedWorkflow),
      run: this.runVerifier.authority(),
      publisherConfigDigest: this.publisherConfigDigest,
    });
  }
  /** Authenticate the reviewed publishing job before revealing its fixed target.
   * This grants no deployment action and is rechecked at attestation insertion. */
  async challenge(rawChallenge: unknown, token: string, signal: AbortSignal) {
    const now = (
      await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const verified = await verifyReleaseBuildChallenge(
      rawChallenge,
      token,
      this.approvedWorkflow,
      now,
      signal,
      this.fetcher,
    );
    const challenge = verified.challenge;
    if (
      !this.targetDigest ||
      !/^[a-f0-9]{64}$/.test(this.targetDigest) ||
      challenge.targetDigest !== this.targetDigest ||
      !this.publisherConfigDigest ||
      challenge.publisherConfigDigest !== this.publisherConfigDigest
    )
      throw new Error("release_build_unavailable");
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          {
            release_id: string;
            owner_id: string;
            target_digest: string;
            phase: string;
            active_release_id: string | null;
            generation: number;
            action_id: string;
            request: Record<string, unknown>;
            request_digest: string;
            action_generation: number;
            receipt: Record<string, unknown>;
            receipt_digest: string;
            snapshot: Record<string, unknown>;
            snapshot_digest: string;
            now: Date;
          }[]
        >`SELECT r.id AS release_id,r.owner_id,r.target_digest,r.phase,r.snapshot,r.snapshot_digest,t.active_release_id,t.generation,
        a.id AS action_id,a.request,a.request_digest,a.generation AS action_generation,a.receipt,a.receipt_digest,clock_timestamp() AS now
        FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
        JOIN delivery_release_actions a ON a.release_id=r.id AND a.kind='merge' AND a.phase='observed'
        WHERE r.target_digest=${this.targetDigest} AND r.phase='active' AND a.receipt->>'provider'='github'
        AND a.receipt->>'repositoryId'=${challenge.repositoryId} AND a.receipt->>'mergeSha'=${challenge.mergeSha}
        LIMIT 2 FOR UPDATE OF t,r,a`;
        const row = rows[0];
        if (
          rows.length !== 1 ||
          !row ||
          row.phase !== "active" ||
          row.active_release_id !== row.release_id ||
          row.target_digest !== this.targetDigest ||
          githubSourceDigest(row.snapshot) !== row.snapshot_digest ||
          row.snapshot.buildAuthorityDigest !== this.authorityDigest() ||
          row.action_generation !== row.generation ||
          row.now.getTime() >= verified.expiresAt ||
          signal.aborted ||
          githubSourceDigest(row.receipt) !== row.receipt_digest ||
          row.receipt.provider !== "github" ||
          row.receipt.repositoryId !== challenge.repositoryId ||
          row.receipt.mergeSha !== challenge.mergeSha
        )
          throw new Error("release_build_scope_changed");
        const identity = releaseActionIdentitySchema.parse({
          id: row.action_id,
          releaseId: row.release_id,
          kind: "merge",
          targetDigest: row.target_digest,
          request: row.request,
          requestDigest: row.request_digest,
          generation: row.action_generation,
        });
        if (!(await this.authorize(tx, identity))) throw new Error("release_build_scope_changed");
        const finalNow = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0].now.getTime();
        if (signal.aborted || finalNow >= verified.expiresAt)
          throw new Error("release_build_scope_changed");
        return {
          releaseId: row.release_id,
          ownerId: row.owner_id,
          targetDigest: row.target_digest,
          publisherConfigDigest: this.publisherConfigDigest,
          mergeSha: challenge.mergeSha,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
    );
  }
  async submit(rawManifest: unknown, token: string, signal: AbortSignal) {
    const initialNow = (
      await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const verified = await verifyReleaseBuildToken(
      rawManifest,
      token,
      this.approvedWorkflow,
      initialNow,
      signal,
      this.fetcher,
    );
    if (Buffer.byteLength(canonicalGitHubSource(verified.manifest)) > 32768)
      throw new Error("release_build_limit");
    await this.provider.verifyUploaded(verified.manifest, signal);
    if (signal.aborted) throw new Error("release_build_unavailable");
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(
          async (tx) => {
            const manifest = verified.manifest;
            const rows = await tx.$queryRaw<
              {
                release_id: string;
                target_digest: string;
                phase: string;
                active_release_id: string | null;
                generation: number;
                action_id: string;
                request: Record<string, unknown>;
                request_digest: string;
                action_generation: number;
                receipt: Record<string, unknown>;
                receipt_digest: string;
                snapshot: Record<string, unknown>;
                snapshot_digest: string;
                now: Date;
              }[]
            >`SELECT r.id AS release_id,r.target_digest,r.phase,r.snapshot,r.snapshot_digest,t.active_release_id,t.generation,
          a.id AS action_id,a.request,a.request_digest,a.generation AS action_generation,a.receipt,a.receipt_digest,clock_timestamp() AS now
          FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
          JOIN delivery_release_actions a ON a.release_id=r.id AND a.kind='merge' AND a.phase='observed'
          WHERE r.id=${manifest.releaseId}::uuid AND r.owner_id=${manifest.ownerId}::uuid FOR UPDATE OF t,r,a`;
            const row = rows[0];
            if (
              rows.length !== 1 ||
              !row ||
              row.phase !== "active" ||
              row.active_release_id !== manifest.releaseId ||
              row.target_digest !== manifest.targetDigest ||
              githubSourceDigest(row.snapshot) !== row.snapshot_digest ||
              row.snapshot.buildAuthorityDigest !== this.authorityDigest() ||
              row.action_generation !== row.generation ||
              row.now.getTime() >= verified.expiresAt ||
              signal.aborted ||
              githubSourceDigest(row.receipt) !== row.receipt_digest ||
              row.receipt.provider !== "github" ||
              row.receipt.repositoryId !== manifest.repositoryId ||
              row.receipt.mergeSha !== manifest.mergeSha
            )
              throw new Error("release_build_scope_changed");
            const identity = releaseActionIdentitySchema.parse({
              id: row.action_id,
              releaseId: row.release_id,
              kind: "merge",
              targetDigest: row.target_digest,
              request: row.request,
              requestDigest: row.request_digest,
              generation: row.action_generation,
            });
            if (!(await this.authorize(tx, identity)))
              throw new Error("release_build_scope_changed");
            const finalNow = (
              await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
            )[0].now.getTime();
            if (signal.aborted || finalNow >= verified.expiresAt)
              throw new Error("release_build_scope_changed");
            await tx.$executeRaw`INSERT INTO delivery_release_build_attestations(id,owner_id,release_id,manifest,manifest_digest,jti_digest,workflow_sha)
          VALUES (${randomUUID()}::uuid,${manifest.ownerId}::uuid,${manifest.releaseId}::uuid,${canonicalGitHubSource(manifest)}::jsonb,${verified.manifestDigest},${verified.jtiDigest},${verified.workflowSha}) ON CONFLICT DO NOTHING`;
            const existing = await tx.$queryRaw<
              {
                manifest: unknown;
                manifest_digest: string;
                jti_digest: string;
                workflow_sha: string;
              }[]
            >`SELECT manifest,manifest_digest,jti_digest,workflow_sha FROM delivery_release_build_attestations WHERE owner_id=${manifest.ownerId}::uuid AND release_id=${manifest.releaseId}::uuid`;
            if (
              existing.length !== 1 ||
              existing[0].manifest_digest !== verified.manifestDigest ||
              existing[0].jti_digest !== verified.jtiDigest ||
              existing[0].workflow_sha !== verified.workflowSha ||
              canonicalGitHubSource(existing[0].manifest) !== canonicalGitHubSource(manifest)
            )
              throw new Error("release_build_replay_mismatch");
            return { manifestDigest: verified.manifestDigest, releaseId: manifest.releaseId };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
        );
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
  async verifyRun(ownerId: string, releaseId: string, signal: AbortSignal) {
    const initial = await this.db.$queryRaw<
      { id: string; manifest: unknown; manifest_digest: string }[]
    >`SELECT id,manifest,manifest_digest FROM delivery_release_build_attestations WHERE owner_id=${ownerId}::uuid AND release_id=${releaseId}::uuid`;
    if (
      initial.length !== 1 ||
      githubSourceDigest(initial[0].manifest) !== initial[0].manifest_digest
    )
      throw new Error("release_build_unavailable");
    const manifest = releaseBuildManifestSchema.parse(initial[0].manifest);
    const verified = await this.runVerifier.verify(manifest, signal);
    await this.provider.verifyUploaded(manifest, signal);
    if (signal.aborted) throw new Error("release_build_unavailable");
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<
              {
                id: string;
                manifest: unknown;
                manifest_digest: string;
                phase: string;
                target_digest: string;
                snapshot: Record<string, unknown>;
                snapshot_digest: string;
                active_release_id: string | null;
                generation: number;
                action_id: string;
                request: Record<string, unknown>;
                request_digest: string;
                action_generation: number;
                receipt: Record<string, unknown>;
                receipt_digest: string;
              }[]
            >`SELECT b.id,b.manifest,b.manifest_digest,r.phase,r.target_digest,r.snapshot,r.snapshot_digest,t.active_release_id,t.generation,a.id AS action_id,a.request,a.request_digest,a.generation AS action_generation,a.receipt,a.receipt_digest
          FROM delivery_release_build_attestations b JOIN delivery_releases r ON r.id=b.release_id AND r.owner_id=b.owner_id JOIN delivery_release_targets t ON t.target_digest=r.target_digest
          JOIN delivery_release_actions a ON a.release_id=r.id AND a.kind='merge' AND a.phase='observed'
          WHERE b.owner_id=${ownerId}::uuid AND b.release_id=${releaseId}::uuid FOR UPDATE OF t,r,a,b`;
            const row = rows[0];
            if (
              rows.length !== 1 ||
              !row ||
              row.id !== initial[0].id ||
              row.manifest_digest !== initial[0].manifest_digest ||
              canonicalGitHubSource(row.manifest) !== canonicalGitHubSource(manifest) ||
              row.phase !== "active" ||
              row.active_release_id !== releaseId ||
              row.target_digest !== manifest.targetDigest ||
              githubSourceDigest(row.snapshot) !== row.snapshot_digest ||
              row.snapshot.buildAuthorityDigest !== this.authorityDigest() ||
              row.generation !== row.action_generation ||
              signal.aborted ||
              githubSourceDigest(row.receipt) !== row.receipt_digest ||
              row.receipt.provider !== "github" ||
              row.receipt.mergeSha !== manifest.mergeSha ||
              row.receipt.repositoryId !== manifest.repositoryId
            )
              throw new Error("release_build_scope_changed");
            const identity = releaseActionIdentitySchema.parse({
              id: row.action_id,
              releaseId,
              kind: "merge",
              targetDigest: row.target_digest,
              request: row.request,
              requestDigest: row.request_digest,
              generation: row.action_generation,
            });
            if (!(await this.authorize(tx, identity)))
              throw new Error("release_build_scope_changed");
            await tx.$executeRaw`INSERT INTO delivery_release_build_verifications(id,owner_id,attestation_id,evidence,evidence_digest) VALUES (${randomUUID()}::uuid,${ownerId}::uuid,${row.id}::uuid,${canonicalGitHubSource(verified.evidence)}::jsonb,${verified.evidenceDigest}) ON CONFLICT DO NOTHING`;
            const saved = await tx.$queryRaw<
              { evidence: unknown; evidence_digest: string }[]
            >`SELECT evidence,evidence_digest FROM delivery_release_build_verifications WHERE owner_id=${ownerId}::uuid AND attestation_id=${row.id}::uuid`;
            if (
              saved.length !== 1 ||
              saved[0].evidence_digest !== verified.evidenceDigest ||
              canonicalGitHubSource(saved[0].evidence) !== canonicalGitHubSource(verified.evidence)
            )
              throw new Error("release_build_replay_mismatch");
            return {
              releaseId,
              manifestDigest: row.manifest_digest,
              evidenceDigest: verified.evidenceDigest,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
        );
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
}
