import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import type { GitHubReleaseChangeRisk } from "./release-change-risk.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import type { GitHubReleaseRules } from "./release-github-rules.server";
import { releasePolicySchema } from "./release-policy-contracts";
import {
  releaseTestAttestationSchema,
  releaseTestChallengeRequestSchema,
  releaseTestWorkflowSchema,
  verifyReleaseTestToken,
} from "./release-tested-attestation.server";
import type { GitHubReleaseTestRunVerifier } from "./release-tested-run.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

const nonceHash = (nonce: string) => createHash("sha256").update(nonce, "hex").digest("hex");
export function isReleaseTestControlPath(path: string) {
  return (
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/") ||
    path.startsWith("scripts/release/") ||
    path.startsWith("services/migrate/src/delivery/") ||
    path.startsWith("src/lib/delivery/database-job-") ||
    path.startsWith("src/lib/delivery/release-") ||
    path.startsWith("src/lib/delivery/repository-policy") ||
    path.startsWith("src/lib/delivery/acceptance-") ||
    path.startsWith("src/lib/delivery/manager") ||
    path.startsWith("src/lib/delivery/source-resolver") ||
    path === "src/lib/delivery/state.ts" ||
    path === "src/lib/delivery/contracts.ts" ||
    path === "src/lib/delivery/completion-transaction.server.ts" ||
    path.startsWith("src/app/api/internal/release-") ||
    path === "src/proxy.ts" ||
    /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.[^/]+|[^/]+\.config\.[^/]+|tsconfig[^/]*\.json)$/.test(
      path,
    )
  );
}
type Scope = z.infer<typeof releaseTestChallengeRequestSchema>;
/** Controller-owned nonce issuer. No token is stored. Every challenge and
 * attestation is immutable, scope-bound and single-use in PostgreSQL. */
export class ReleaseTestStore {
  private readonly workflow: z.infer<typeof releaseTestWorkflowSchema>;
  constructor(
    private readonly db: PrismaClient,
    workflow: unknown,
    private readonly run: GitHubReleaseTestRunVerifier,
    private readonly repository: RepositoryPolicyStore,
    private readonly policies: () => unknown,
    private readonly targetDigest: string,
    private readonly authorityDigest: string,
    private readonly rules: GitHubReleaseRules,
    private readonly risk: GitHubReleaseChangeRisk,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.workflow = releaseTestWorkflowSchema.parse(workflow);
    if (!/^[a-f0-9]{64}$/.test(targetDigest) || !/^[a-f0-9]{64}$/.test(authorityDigest))
      throw Error("release_test_unavailable");
  }
  private async scope(tx: Prisma.TransactionClient, input: Scope) {
    const now = (
      await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const candidates = z
      .array(releasePolicySchema)
      .max(32)
      .parse(this.policies())
      .filter(
        (p) =>
          p.repositoryId === input.repositoryId &&
          p.targetDigest === this.targetDigest &&
          p.authorityConfigDigest === this.authorityDigest &&
          p.actions.includes("merge") &&
          p.validFrom <= now &&
          p.expiresAt > now,
      );
    if (candidates.length !== 1) throw Error("release_test_scope");
    const rows = await tx.deliveryTask.findMany({
      where: {
        ownerId: candidates[0].ownerId,
        currentSourceRevision: {
          is: {
            repositoryId: input.repositoryId,
            pullNumber: input.pullNumber,
            headSha: input.headSha,
          },
        },
      },
      select: { id: true, ownerId: true },
      take: 2,
    });
    if (rows.length !== 1) throw Error("release_test_scope");
    const bound = await this.repository.resolveTask(tx, rows[0].ownerId, rows[0].id),
      source = bound?.task.currentSourceRevision;
    if (
      !bound ||
      !source ||
      source.headSha !== input.headSha ||
      source.repositoryId !== input.repositoryId
    )
      throw Error("release_test_scope");
    if (candidates[0].providerAccountId !== source.providerAccountId)
      throw Error("release_test_scope");
    return {
      ownerId: rows[0].ownerId,
      taskId: rows[0].id,
      policyDigest: githubSourceDigest(candidates[0]),
      checksDigest: githubSourceDigest(bound.policy.evidenceGates),
      bindingDigest: bound.binding.bindingDigest,
      source,
      gates: bound.policy.evidenceGates,
    };
  }
  private async provider(
    input: Scope,
    s: Awaited<ReturnType<ReleaseTestStore["scope"]>>,
    complete: boolean,
    signal: AbortSignal,
  ) {
    const request = {
      repositoryId: input.repositoryId,
      pullRequestId: s.source.pullRequestId,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      baseRef: s.source.baseBranch,
      rulesDigest: "0".repeat(64),
      method: "squash" as const,
    };
    const first = await this.rules.inspect(request, signal);
    const requestWithRules = { ...request, rulesDigest: first.digest };
    const [tested, , risk] = await Promise.all([
      complete
        ? this.rules.verifyTested(requestWithRules, s.gates, signal)
        : this.rules.inspectMerge(requestWithRules, s.gates, signal),
      this.run.verify(input, complete, signal),
      this.risk.inspect(requestWithRules, signal),
    ]);
    // Candidate changes may include ordinary tests, but not the trusted
    // authority and execution controls; renames must pass on both sides.
    if (
      risk.evidence.files.some(
        (f) =>
          isReleaseTestControlPath(f.filename) ||
          ("previousFilename" in f &&
            !!f.previousFilename &&
            isReleaseTestControlPath(f.previousFilename)),
      )
    )
      throw Error("release_test_control_changed");
    if (
      tested.mergeSha !== input.mergeSha ||
      tested.treeSha !== input.treeSha ||
      tested.rulesDigest !== first.digest ||
      signal.aborted
    )
      throw Error("release_test_scope");
  }
  async challenge(raw: unknown, token: string, signal: AbortSignal) {
    const input = releaseTestChallengeRequestSchema.parse(raw);
    const now = (
      await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const verified = await verifyReleaseTestToken(
      input,
      token,
      this.workflow,
      now,
      signal,
      this.fetcher,
    );
    const scope = await this.db.$transaction((tx) => this.scope(tx, input));
    await this.provider(input, scope, false, signal);
    const nonce = randomBytes(32).toString("hex"),
      id = randomUUID();
    await this.db.$transaction(
      async (tx) => {
        const current = await this.scope(tx, input),
          now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
        if (
          current.bindingDigest !== scope.bindingDigest ||
          current.policyDigest !== scope.policyDigest ||
          current.checksDigest !== scope.checksDigest ||
          signal.aborted ||
          now.getTime() >= verified.expiresAt
        )
          throw Error("release_test_scope");
        const expiry = new Date(Math.min(now.getTime() + 120000, verified.expiresAt));
        await tx.$executeRaw`INSERT INTO delivery_release_test_challenges(id,owner_id,task_id,request,request_digest,nonce_digest,challenge_jti_digest,policy_digest,checks_digest,expires_at) VALUES (${id}::uuid,${scope.ownerId}::uuid,${scope.taskId}::uuid,${canonicalGitHubSource(input)}::jsonb,${githubSourceDigest(input)},${nonceHash(nonce)},${verified.jtiDigest},${scope.policyDigest},${scope.checksDigest},${expiry})`;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return {
      challengeId: id,
      nonce,
      policyDigest: scope.policyDigest,
      checksDigest: scope.checksDigest,
    };
  }
  async submit(raw: unknown, token: string, signal: AbortSignal) {
    const input = releaseTestAttestationSchema.parse(raw);
    const now = (
      await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const verified = await verifyReleaseTestToken(
      input,
      token,
      this.workflow,
      now,
      signal,
      this.fetcher,
    );
    const { challengeId, nonce, policyDigest, checksDigest, purpose: _purpose, ...rest } = input;
    const request = releaseTestChallengeRequestSchema.parse({
      ...rest,
      purpose: "release_test_challenge",
    });
    const scope = await this.db.$transaction((tx) => this.scope(tx, request));
    await this.provider(request, scope, false, signal);
    const workflowDigest = githubSourceDigest({
      workflow: this.workflow,
      run: this.run.authority(),
    });
    await this.db.$transaction(
      async (tx) => {
        const current = await this.scope(tx, request);
        const rows = await tx.$queryRaw<
          {
            owner_id: string;
            task_id: string;
            request: unknown;
            request_digest: string;
            nonce_digest: string;
            challenge_jti_digest: string;
            policy_digest: string;
            checks_digest: string;
            expires_at: Date;
            now: Date;
          }[]
        >`SELECT owner_id,task_id,request,request_digest,nonce_digest,challenge_jti_digest,policy_digest,checks_digest,expires_at,clock_timestamp() AS now FROM delivery_release_test_challenges WHERE id=${challengeId}::uuid FOR UPDATE`;
        const row = rows[0];
        if (
          !row ||
          row.owner_id !== scope.ownerId ||
          row.task_id !== scope.taskId ||
          row.request_digest !== githubSourceDigest(request) ||
          canonicalGitHubSource(row.request) !== canonicalGitHubSource(request) ||
          row.nonce_digest !== nonceHash(nonce) ||
          row.challenge_jti_digest === verified.jtiDigest ||
          row.policy_digest !== policyDigest ||
          row.checks_digest !== checksDigest ||
          current.bindingDigest !== scope.bindingDigest ||
          current.policyDigest !== policyDigest ||
          current.checksDigest !== checksDigest ||
          row.expires_at.getTime() <= row.now.getTime() ||
          verified.expiresAt <= row.now.getTime() ||
          signal.aborted
        )
          throw Error("release_test_scope");
        const expiry = new Date(row.now.getTime() + 10 * 60 * 1000);
        await tx.$executeRaw`INSERT INTO delivery_release_test_attestations(id,owner_id,task_id,challenge_id,payload,payload_digest,attestation_jti_digest,workflow_digest,expires_at) VALUES (${randomUUID()}::uuid,${scope.ownerId}::uuid,${scope.taskId}::uuid,${challengeId}::uuid,${canonicalGitHubSource(input)}::jsonb,${githubSourceDigest(input)},${verified.jtiDigest},${workflowDigest},${expiry})`;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { accepted: true };
  }

  async verifyFresh(ownerId: string, taskId: string, rawRequest: unknown, signal: AbortSignal) {
    const request = githubReleaseRequestSchema.parse(rawRequest);
    const rows = await this.db.$queryRaw<
      { payload: unknown; payload_digest: string; workflow_digest: string }[]
    >`SELECT payload,payload_digest,workflow_digest FROM delivery_release_test_attestations WHERE owner_id=${ownerId}::uuid AND task_id=${taskId}::uuid AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 16`;
    const workflowDigest = githubSourceDigest({
      workflow: this.workflow,
      run: this.run.authority(),
    });
    for (const row of rows) {
      const parsed = releaseTestAttestationSchema.safeParse(row.payload);
      if (
        !parsed.success ||
        githubSourceDigest(row.payload) !== row.payload_digest ||
        row.workflow_digest !== workflowDigest
      )
        continue;
      const payload = parsed.data;
      if (
        payload.repositoryId !== request.repositoryId ||
        payload.pullNumber !== request.pullNumber ||
        payload.headSha !== request.headSha ||
        payload.baseSha !== request.baseSha
      )
        continue;
      const {
        challengeId: _id,
        nonce: _nonce,
        policyDigest,
        checksDigest,
        purpose: _purpose,
        ...rest
      } = payload;
      const source = releaseTestChallengeRequestSchema.parse({
        ...rest,
        purpose: "release_test_challenge",
      });
      const scope = await this.db.$transaction((tx) => this.scope(tx, source));
      if (
        scope.ownerId !== ownerId ||
        scope.taskId !== taskId ||
        scope.source.pullRequestId !== request.pullRequestId ||
        scope.source.baseBranch !== request.baseRef ||
        scope.policyDigest !== policyDigest ||
        scope.checksDigest !== checksDigest
      )
        continue;
      await this.provider(source, scope, true, signal);
      return row.payload_digest;
    }
    throw Error("release_test_attestation_unavailable");
  }
}

export async function verifyReleaseTestReceipt(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; taskId: string; digest: string; request: unknown },
) {
  const request = githubReleaseRequestSchema.parse(input.request);
  const rows = await tx.$queryRaw<
    { payload: unknown; expires_at: Date; now: Date }[]
  >`SELECT payload,expires_at,clock_timestamp() AS now FROM delivery_release_test_attestations WHERE owner_id=${input.ownerId}::uuid AND task_id=${input.taskId}::uuid AND payload_digest=${input.digest} FOR SHARE`;
  if (
    rows.length !== 1 ||
    rows[0].expires_at.getTime() <= rows[0].now.getTime() ||
    githubSourceDigest(rows[0].payload) !== input.digest
  )
    return false;
  const parsed = releaseTestAttestationSchema.safeParse(rows[0].payload);
  return (
    parsed.success &&
    parsed.data.repositoryId === request.repositoryId &&
    parsed.data.pullNumber === request.pullNumber &&
    parsed.data.headSha === request.headSha &&
    parsed.data.baseSha === request.baseSha
  );
}
