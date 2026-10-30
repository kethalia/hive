import { Prisma, type PrismaClient } from "@hive/db";
import { canonicalGitHubSource } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import type { ManagerPolicyScope } from "./manager.server";
import {
  type ReleaseCandidate,
  type ReleaseRemoteObservation,
  releaseCandidateRequestSchema,
  releaseCandidateSchema,
  releaseRemoteObservationSchema,
} from "./release-candidate-contracts";
import { repositoryPolicyAdapters, repositoryPolicyStore } from "./repository-policy.server";
import { repositoryGateDescriptors } from "./repository-policy-contracts";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { resolveAttemptSource, resolveTaskSource } from "./source-resolver.server";
import { assertCompletionEvidence, DeliveryConflict, isInformationalStep } from "./state";

type Tx = Prisma.TransactionClient;
type RemoteScope = NonNullable<ReleaseCandidate["pullRequest"]>;
const conflictCode = (error: unknown, fallback: string) =>
  error instanceof DeliveryConflict && /^[a-z][a-z0-9_]{0,99}$/.test(error.code)
    ? error.code
    : fallback;

/** Optional trusted provider seam, NOT an evidence submission API. It receives
 * only controller-derived scope. Implementations must perform fixed bounded
 * read-only requests, honor abort and never use the request's model credentials.
 * This slice installs no remote provider factory. */
export interface ReleaseCandidateObserver {
  observe(scope: RemoteScope, signal: AbortSignal): Promise<unknown>;
}

/** Internal owner-scoped read; its caller must already authenticate that owner.
 * No HTTP route, manager command, write, credential or release capability exists.
 * Row locks used by existing policy validators do not change durable state. */
export class ReleaseCandidateResolver {
  private readonly policies: ReturnType<typeof repositoryPolicyAdapters>;
  constructor(
    private readonly db: PrismaClient,
    private readonly store: RepositoryPolicyStore = repositoryPolicyStore(db),
    private readonly observer?: ReleaseCandidateObserver,
  ) {
    this.policies = repositoryPolicyAdapters(store);
  }
  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5000,
          timeout: 10000,
        });
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
  private async load(tx: Tx, ownerId: string, taskId: string) {
    const task = await tx.deliveryTask.findUnique({
      where: { ownerId_id: { ownerId, id: taskId } },
      include: { project: true, steps: { orderBy: { id: "asc" } } },
    });
    if (!task) return null;
    const source = await resolveTaskSource(tx, ownerId, taskId);
    if (source.task.currentSourceRevision)
      await resolveAttemptSource(
        tx,
        ownerId,
        taskId,
        source.task.currentSourceRevision.producingAttemptId,
      );
    let policyError: string | undefined;
    const bound = await this.store.resolveTask(tx, ownerId, taskId).catch((error) => {
      if (!(error instanceof DeliveryConflict)) throw error;
      policyError = conflictCode(error, "repository_policy_unavailable");
      return null;
    });
    const revision = source.task.currentSourceRevision;
    const pullRequest: RemoteScope | null = revision
      ? {
          repositoryId: task.project.providerRepositoryId,
          providerAccountId: task.project.providerAccountId,
          fullName: task.project.fullName,
          providerId: revision.pullRequestId,
          number: revision.pullNumber,
          headSha: source.headSha,
          headBranch: revision.branch,
          baseRef: revision.baseBranch,
        }
      : null;
    return { task, source, bound, policyError, pullRequest };
  }
  async read(raw: unknown): Promise<ReleaseCandidate | null> {
    const input = releaseCandidateRequestSchema.parse(raw);
    const initial = await this.transaction((tx) => this.load(tx, input.ownerId, input.taskId));
    if (!initial) return null;
    let remote: ReleaseRemoteObservation | null = null;
    let remoteError = "remote_release_observer_unavailable";
    if (this.observer && initial.bound && initial.pullRequest) {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("deadline"));
          }, 3000);
        });
        remote = releaseRemoteObservationSchema.parse(
          await Promise.race([
            this.observer.observe(Object.freeze({ ...initial.pullRequest }), abort.signal),
            deadline,
          ]),
        );
      } catch {
        remoteError = "remote_release_observation_unavailable";
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    }
    // Network reads are outside the DB lifetime. Re-read authoritative state and
    // validate evidence afterward; no initial snapshot grants later permission.
    return this.transaction(async (tx) => {
      const current = await this.load(tx, input.ownerId, input.taskId);
      if (!current) return null;
      const { task, source, bound, pullRequest } = current;
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      const blockers: ReleaseCandidate["blockers"] = [];
      const block = (code: string, stepId?: string) => {
        if (!blockers.some((b) => b.code === code && b.stepId === stepId))
          blockers.push({ code, ...(stepId ? { stepId } : {}) });
      };
      block("release_actions_disabled");
      block("owner_approved_cloudflare_cutover_pending");
      if (task.pauseRequested || task.schedulingPaused) block("task_paused");
      if (
        canonicalGitHubSource(initial.source.context ?? null) !==
          canonicalGitHubSource(source.context ?? null) ||
        initial.bound?.binding.bindingDigest !== bound?.binding.bindingDigest ||
        canonicalGitHubSource(initial.pullRequest) !== canonicalGitHubSource(pullRequest)
      )
        block("release_snapshot_changed");
      if (
        input.expectedSource &&
        canonicalGitHubSource(input.expectedSource) !== canonicalGitHubSource(source.context)
      )
        block("source_context_stale");
      if (!source.context) block("accepted_source_missing");
      if (!bound) block(current.policyError ?? "repository_policy_unavailable");
      if (bound && pullRequest?.baseRef !== bound.policy.source.baseBranch)
        block("release_base_policy_mismatch");
      const steps: ReleaseCandidate["steps"] = [];
      for (const step of task.steps) {
        if (isInformationalStep(step)) {
          steps.push({ stepId: step.id, status: "informational", evidenceIds: [] });
          continue;
        }
        if (!["succeeded", "canceled"].includes(step.state)) block("step_not_completed", step.id);
        if (step.state === "canceled") block("step_canceled", step.id);
        const result: ReleaseCandidate["steps"][number] = {
          stepId: step.id,
          status: "blocked",
          evidenceIds: [],
        };
        steps.push(result);
        if (!bound || !source.context || !source.task.managerBinding) continue;
        for (const pending of bound.projection.pendingRequirements.filter(
          (p) => p.stepId === step.id,
        ))
          block(pending.reason, step.id);
        const scope: ManagerPolicyScope = {
          ownerId: input.ownerId,
          taskId: task.id,
          stepId: step.id,
          projectId: task.projectId,
          repositoryId: task.project.providerRepositoryId,
          providerAccountId: task.project.providerAccountId,
          fullName: task.project.fullName,
          sourceSha: source.headSha,
          branch: task.branch,
          managerBindingId: source.task.managerBinding.id,
          checkoutBindingDigest: source.task.managerBinding.bindingDigest,
          stepKind: step.kind,
          criterionIds: step.criterionIds,
          requiredEvidenceKinds: step.requiredEvidenceKinds,
          acceptancePhase: step.acceptancePhase,
          sourceRevisionId: source.context.revisionId,
          sourceVersion: source.context.version,
          sourcePullNumber: pullRequest?.number,
        };
        try {
          const policy = await this.policies.resolveEvidencePolicy(scope, tx);
          if (!policy) throw new DeliveryConflict("repository_policy_unavailable");
          const evidence = await tx.deliveryEvidence.findMany({
            where: {
              ownerId: input.ownerId,
              stepId: step.id,
              sourceSha: source.headSha,
              policyVersion: policy.policy.version,
              producer: { in: [...policy.policy.trustedProducers] },
              invalidatedAt: null,
              status: "passed",
            },
            take: 41,
          });
          if (evidence.length > 40) throw new DeliveryConflict("repository_policy_evidence_limit");
          await policy.authorizeReferences(
            tx,
            evidence.map((e) => e.id),
            true,
          );
          assertCompletionEvidence({
            ownerId: input.ownerId,
            stepId: step.id,
            sourceSha: source.headSha,
            criterionIds: step.criterionIds,
            requiredKinds: step.requiredEvidenceKinds,
            acceptancePhase: step.acceptancePhase,
            policyVersion: policy.policy.version,
            trustedProducers: policy.policy.trustedProducers,
            maxAgeMs: policy.policy.maxAgeMs,
            now: new Date(now),
            evidence,
          });
          result.status = "observed";
          result.evidenceIds = evidence.map((e) => e.id);
        } catch (error) {
          if (!(error instanceof DeliveryConflict)) throw error;
          block(conflictCode(error, "release_evidence_unavailable"), step.id);
        }
      }
      let remoteSummary: ReleaseCandidate["remote"] = null;
      if (!remote || !pullRequest) block(remoteError);
      else {
        if (
          remote.observedAt > now ||
          remote.expiresAt <= now ||
          remote.expiresAt - remote.observedAt > 30000
        )
          block("remote_release_observation_stale");
        if (
          remote.repositoryId !== pullRequest.repositoryId ||
          remote.headRepositoryId !== pullRequest.repositoryId ||
          remote.baseRepositoryId !== pullRequest.repositoryId ||
          remote.pullRequestId !== pullRequest.providerId ||
          remote.pullNumber !== pullRequest.number ||
          remote.headSha !== pullRequest.headSha ||
          remote.baseRef !== pullRequest.baseRef
        )
          block("remote_pull_request_changed");
        if (remote.state !== "open" || remote.draft) block("pull_request_not_ready");
        if (
          remote.rules.repositoryId !== pullRequest.repositoryId ||
          remote.rules.baseRef !== pullRequest.baseRef ||
          !remote.rules.pullRequestRequired ||
          remote.rules.actorCanBypass ||
          (!remote.rules.requireUpToDate && !remote.rules.mergeQueueRequired)
        )
          block("effective_branch_rules_insufficient");
        if (
          bound &&
          repositoryGateDescriptors(bound.policy.evidenceGates)
            .filter((g) => g.kind === "check")
            .some((g) => !remote?.rules.requiredCheckSelectors.includes(g.key))
        )
          block("required_repository_checks_not_enforced");
        const tested = remote.testedMerge;
        if (
          !tested?.succeeded ||
          tested.headSha !== pullRequest.headSha ||
          tested.baseSha !== remote.baseSha ||
          !bound?.policy.evidenceGates.checks.some(
            (check) =>
              check.workflowId === tested.workflowId &&
              check.appId === tested.appId &&
              check.events.includes(tested.event),
          )
        )
          block("current_base_test_evidence_missing");
        remoteSummary = {
          baseSha: remote.baseSha,
          rulesDigest: remote.rules.contentDigest,
          testedMerge: tested,
          observedAt: remote.observedAt,
          expiresAt: remote.expiresAt,
        };
      }
      return releaseCandidateSchema.parse({
        mode: "observation",
        target: "cloudflare_workers_after_owner_cutover",
        eligible: false,
        mergeAuthorized: false,
        deploymentAuthorized: false,
        observedAt: now,
        taskId: task.id,
        taskVersion: task.version,
        source: source.context ?? null,
        policy: bound
          ? {
              versionId: bound.binding.policyVersionId,
              digest: bound.binding.policyDigest,
              bindingDigest: bound.binding.bindingDigest,
            }
          : null,
        pullRequest,
        remote: remoteSummary,
        steps,
        blockers,
      });
    });
  }
}
