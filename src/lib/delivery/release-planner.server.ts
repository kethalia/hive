import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { githubSourceDigest } from "./github-evidence.server";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import { releaseBuildManifestSchema } from "./release-build-attestation.server";
import { cloudflareReleaseRequestSchema } from "./release-cloudflare-provider.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import type { ReleaseLifecycle } from "./release-lifecycle.server";

/** Derives the next journal intent only from persisted facts and receipts. The
 * lifecycle independently reauthorizes under locks, including pause, enrollment,
 * source and stage readiness; concurrent planners cannot create duplicate work. */
export class ReleasePlanner {
  constructor(
    private readonly db: PrismaClient,
    private readonly targetDigest: string,
    private readonly lifecycle: ReleaseLifecycle,
  ) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(targetDigest);
  }
  async advance(ownerId: string, releaseId: string) {
    z.string().uuid().parse(ownerId);
    z.string().uuid().parse(releaseId);
    const rows = await this.db.$queryRaw<
      { phase: string; snapshot: unknown; snapshot_digest: string; task_id: string }[]
    >`SELECT r.phase,r.snapshot,r.snapshot_digest,r.task_id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND r.target_digest=${this.targetDigest} AND t.active_release_id=r.id`;
    if (rows.length !== 1 || githubSourceDigest(rows[0].snapshot) !== rows[0].snapshot_digest)
      return "held" as const;
    const release = rows[0],
      snapshot = z
        .object({
          riskAttestationDigest: z.string().regex(/^[a-f0-9]{64}$/),
          baselines: releaseBaselinesSchema,
        })
        .passthrough()
        .parse(release.snapshot);
    const actions = await this.db.$queryRaw<
      {
        id: string;
        kind: string;
        phase: string;
        request: Record<string, unknown>;
        request_digest: string;
        receipt: Record<string, unknown> | null;
        receipt_digest: string | null;
      }[]
    >`SELECT id,kind,phase,request,request_digest,receipt,receipt_digest FROM delivery_release_actions WHERE release_id=${releaseId}::uuid ORDER BY created_at,id`;
    if (
      actions.some(
        (a) =>
          githubSourceDigest(a.request) !== a.request_digest ||
          (a.phase === "observed" &&
            (!a.receipt || githubSourceDigest(a.receipt) !== a.receipt_digest)),
      )
    )
      return "held" as const;
    if (actions.some((a) => ["prepared", "effect_started", "held"].includes(a.phase)))
      return "waiting" as const;
    const completed = actions.filter((a) => a.phase === "observed");
    if (release.phase === "held") {
      const promote = completed.filter((a) => a.kind === "promote"),
        recovered = completed.filter((a) => a.kind === "recover");
      const next = promote.find(
        (a) => !recovered.some((r) => r.request.component === a.request.component),
      );
      if (!next?.receipt) return "waiting" as const;
      const prior = cloudflareReleaseRequestSchema.parse(next.request),
        receipt = z.object({ deploymentId: z.string().uuid() }).passthrough().parse(next.receipt);
      const request = {
        component: prior.component,
        expectedDeploymentId: receipt.deploymentId,
        expectedVersionId: prior.versionId,
        versionId: prior.expectedVersionId,
        mergedSha: prior.baselineSourceSha,
        artifactDigest: prior.baselineArtifactDigest,
        configDigest: prior.baselineConfigDigest,
        baselineSourceSha: prior.mergedSha,
        baselineArtifactDigest: prior.artifactDigest,
        baselineConfigDigest: prior.configDigest,
      };
      await this.lifecycle.prepare(ownerId, {
        id: randomUUID(),
        releaseId,
        kind: "recover",
        request,
      });
      return "prepared" as const;
    }
    if (release.phase !== "active") return "waiting" as const;
    const merge = completed.find((a) => a.kind === "merge");
    if (!merge) {
      const facts = await this.db.$queryRaw<
        { payload: unknown }[]
      >`SELECT payload FROM delivery_release_authority_facts WHERE owner_id=${ownerId}::uuid AND task_id=${release.task_id}::uuid AND payload_digest=${snapshot.riskAttestationDigest}`;
      if (
        facts.length !== 1 ||
        githubSourceDigest(facts[0].payload) !== snapshot.riskAttestationDigest
      )
        return "held" as const;
      const fact = z
        .object({ request: githubReleaseRequestSchema })
        .passthrough()
        .parse(facts[0].payload);
      await this.lifecycle.prepare(ownerId, {
        id: randomUUID(),
        releaseId,
        kind: "merge",
        request: fact.request,
      });
      return "prepared" as const;
    }
    const builds = await this.db.$queryRaw<
      { manifest: unknown; manifest_digest: string }[]
    >`SELECT b.manifest,b.manifest_digest FROM delivery_release_build_attestations b JOIN delivery_release_build_verifications v ON v.attestation_id=b.id AND v.owner_id=b.owner_id WHERE b.owner_id=${ownerId}::uuid AND b.release_id=${releaseId}::uuid`;
    if (builds.length !== 1 || githubSourceDigest(builds[0].manifest) !== builds[0].manifest_digest)
      return "waiting" as const;
    const build = releaseBuildManifestSchema.parse(builds[0].manifest);
    const promoted = completed.filter((a) => a.kind === "promote"),
      component = (["app", "auth"] as const).find(
        (c) => !promoted.some((a) => a.request.component === c),
      );
    if (!component) return "waiting" as const;
    const baseline = snapshot.baselines[component],
      built = build[component];
    const request = {
      component,
      expectedDeploymentId: baseline.deploymentId,
      expectedVersionId: baseline.versionId,
      versionId: built.versionId,
      mergedSha: build.mergeSha,
      artifactDigest: built.artifactDigest,
      configDigest: built.configDigest,
      baselineSourceSha: baseline.sourceSha,
      baselineArtifactDigest: baseline.artifactDigest,
      baselineConfigDigest: baseline.configDigest,
    };
    await this.lifecycle.prepare(ownerId, {
      id: randomUUID(),
      releaseId,
      kind: "promote",
      request,
    });
    return "prepared" as const;
  }
}
