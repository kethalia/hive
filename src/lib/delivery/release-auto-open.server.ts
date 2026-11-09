import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { verifyReleaseEvidence } from "./release-evidence.server";
import type { ReleaseAuthorityFacts } from "./release-facts.server";
import type { ReleaseLifecycle } from "./release-lifecycle.server";
import { releasePolicySchema } from "./release-policy-contracts";
import type { GitHubReleaseSourceDiscovery } from "./release-source-discovery.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

/** Finds exact-source eligible tasks within enrolled policy; it never accepts
 * task-selected target, branch, merge method, baseline or evidence. The journal
 * target lock arbitrates concurrent opener instances. */
export class ReleaseAutoOpener {
  constructor(
    private readonly db: PrismaClient,
    private readonly targetDigest: string,
    private readonly authorityConfigDigest: string,
    private readonly store: RepositoryPolicyStore,
    private readonly policies: () => unknown,
    private readonly discovery: GitHubReleaseSourceDiscovery,
    private readonly facts: ReleaseAuthorityFacts,
    private readonly lifecycle: ReleaseLifecycle,
  ) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(targetDigest);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(authorityConfigDigest);
  }
  async tick(signal: AbortSignal) {
    if (signal.aborted) return "aborted" as const;
    const policies = z
      .array(releasePolicySchema)
      .max(32)
      .parse(this.policies())
      .filter(
        (p) =>
          p.targetDigest === this.targetDigest &&
          p.authorityConfigDigest === this.authorityConfigDigest &&
          p.actions.includes("merge"),
      );
    if (!policies.length) return "idle" as const;
    const rows = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO delivery_release_scheduler_cursors(target_digest) VALUES (${this.targetDigest}) ON CONFLICT DO NOTHING`;
      const cursor = (
        await tx.$queryRaw<
          { opener_cursor: string }[]
        >`SELECT opener_cursor FROM delivery_release_scheduler_cursors WHERE target_digest=${this.targetDigest} FOR UPDATE`
      )[0];
      const rows = await tx.$queryRaw<
        {
          id: string;
          owner_id: string;
          repository_id: string;
          provider_account_id: string;
          pull_request_id: string;
          pull_number: number;
          head_sha: string;
          base_branch: string;
        }[]
      >`SELECT t.id,t.owner_id,s.repository_id,s.provider_account_id,s.pull_request_id,s.pull_number,s.head_sha,s.base_branch FROM delivery_tasks t JOIN delivery_source_revisions s ON s.id=t.source_revision_id AND s.owner_id=t.owner_id AND s.task_id=t.id WHERE t.id>${cursor.opener_cursor}::uuid AND NOT t.pause_requested AND NOT t.scheduling_paused AND NOT EXISTS (SELECT 1 FROM delivery_release_targets x WHERE x.target_digest=${this.targetDigest} AND x.active_release_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM delivery_releases r WHERE r.source_revision_id=s.id AND r.target_digest=${this.targetDigest}) ORDER BY t.id LIMIT 8`;
      const next = rows.length ? rows[rows.length - 1].id : "00000000-0000-0000-0000-000000000000";
      await tx.$executeRaw`UPDATE delivery_release_scheduler_cursors SET opener_cursor=${next}::uuid,updated_at=clock_timestamp() WHERE target_digest=${this.targetDigest}`;
      return rows;
    });
    if (!rows.length) return "idle" as const;
    for (const row of rows) {
      if (signal.aborted) return "aborted" as const;
      const now = Date.now(),
        matching = policies.filter(
          (p) =>
            p.ownerId === row.owner_id &&
            p.repositoryId === row.repository_id &&
            p.providerAccountId === row.provider_account_id &&
            p.validFrom <= now &&
            p.expiresAt > now,
        );
      if (matching.length !== 1) continue;
      try {
        const eligible = await this.db.$transaction((tx) =>
          verifyReleaseEvidence(tx, this.store, {
            ownerId: row.owner_id,
            taskId: row.id,
            sourceSha: row.head_sha,
            milestone: "implementation_preview",
          }),
        );
        if (!eligible) continue;
        const request = await this.discovery.read(
          {
            repositoryId: row.repository_id,
            pullRequestId: row.pull_request_id,
            pullNumber: row.pull_number,
            headSha: row.head_sha,
            baseRef: row.base_branch,
          },
          signal,
        );
        const fact = await this.facts.capture(
          {
            ownerId: row.owner_id,
            taskId: row.id,
            policyVersionId: matching[0].versionId,
            request,
          },
          signal,
        );
        if (signal.aborted) return "aborted" as const;
        await this.lifecycle.open({
          id: randomUUID(),
          ownerId: row.owner_id,
          taskId: row.id,
          policyVersionId: matching[0].versionId,
          riskAttestationDigest: fact.riskAttestationDigest,
          baselines: fact.baselines,
          riskClass: fact.riskClass,
        });
        return "opened" as const;
      } catch {
        /* Incomplete or stale evidence holds; move to next task. */
      }
    }
    return "idle" as const;
  }
}
