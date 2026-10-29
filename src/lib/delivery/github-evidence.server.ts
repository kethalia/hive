import { createHash } from "node:crypto";
import {
  type CheckEvidence,
  evaluateDeliveryEligibility,
  type ReviewEvidence,
} from "./eligibility";
import {
  type GitHubEvidencePolicy,
  type GitHubSnapshot,
  type GitHubSourceTarget,
  githubBotReviewProducer,
  githubCheckProducer,
  githubEvidencePolicySchema,
  githubFormalReviewProducer,
  githubSnapshotSchema,
  githubSourceTargetSchema,
} from "./github-contracts";
import { DeliveryConflict } from "./state";

if (typeof window !== "undefined") throw new Error("GitHub evidence is server-only.");
export const GITHUB_SOURCE_MAX_BYTES = 1024 * 1024;
/** Deployment must supply a source-specific authenticated connection. Its
 * implementation must derive owner/workspace from the registry, send an exact
 * repository/PR/head target with controller nonce and verify the signed reply.
 * Do not implement this with manager JSON, a generic fetch URL, or a user token
 * copied into another workspace. There is deliberately no default factory. */
export interface GitHubSourceConnection {
  collect(target: GitHubSourceTarget): Promise<unknown>;
}
export function canonicalGitHubSource(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return JSON.stringify(sorted(value));
}
export const githubSourceDigest = (value: unknown) =>
  createHash("sha256").update(canonicalGitHubSource(value)).digest("hex");
const unique = (values: string[]) => new Set(values).size === values.length;
function checkRunId(url: string, target: GitHubSourceTarget) {
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== "https://api.github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return null;
    const roots = [
      `/repos/${target.fullName}/check-runs/`,
      `/repositories/${target.providerRepositoryId}/check-runs/`,
    ];
    const root = roots.find((value) =>
      parsed.pathname.toLowerCase().startsWith(value.toLowerCase()),
    );
    const id = root ? parsed.pathname.slice(root.length) : "";
    return /^[1-9][0-9]{0,19}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
function assertSnapshot(
  snapshot: GitHubSnapshot,
  target: GitHubSourceTarget,
  policy: GitHubEvidencePolicy,
  now: number,
) {
  const observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(now) || observed > now || now - observed > policy.maxAgeMs)
    throw new DeliveryConflict("github_observation_expired");
  if (
    snapshot.repository.id !== target.providerRepositoryId ||
    snapshot.providerAccountId !== target.providerAccountId ||
    snapshot.repository.fullName.toLowerCase() !== target.fullName.toLowerCase() ||
    snapshot.pullRequest.baseRepositoryId !== target.providerRepositoryId ||
    snapshot.pullRequest.number !== target.pullNumber ||
    snapshot.pullRequest.headSha !== target.expectedHeadSha
  )
    throw new DeliveryConflict("github_source_binding_mismatch");
  if (
    !unique(snapshot.checks.map((x) => x.id)) ||
    !unique(snapshot.workflowRuns.map((x) => x.id)) ||
    !unique(snapshot.workflowRuns.map((x) => `${x.workflowId}/${x.runNumber}`)) ||
    !unique(snapshot.reviews.map((x) => x.id)) ||
    !unique(snapshot.reviewSummaries.map((x) => x.id)) ||
    !unique(snapshot.reviewThreads.map((x) => x.id)) ||
    !unique(snapshot.workflowRuns.flatMap((x) => x.jobs.map((job) => job.id)))
  )
    throw new DeliveryConflict("github_source_ambiguous");
  if (
    !unique(policy.checks.map((x) => `${x.workflowId}/${x.appId}/${x.name}`)) ||
    !unique(policy.formalReviewers.map((x) => x.userId))
  )
    throw new DeliveryConflict("github_policy_ambiguous");
}
function mapChecks(
  snapshot: GitHubSnapshot,
  target: GitHubSourceTarget,
  policy: GitHubEvidencePolicy,
): CheckEvidence[] {
  const observedAt = Date.parse(snapshot.observedAt),
    output: CheckEvidence[] = [];
  for (const required of policy.checks) {
    const producer = githubCheckProducer(
      target.providerRepositoryId,
      required.workflowId,
      required.appId,
    );
    for (const run of snapshot.workflowRuns.filter(
      (run) => run.workflowId === required.workflowId,
    )) {
      const jobs = run.jobs.filter((job) => job.name === required.name);
      let status: CheckEvidence["status"] = "unknown";
      let sourceUpdatedAt = Date.parse(run.updatedAt),
        remoteId = `github:${target.providerRepositoryId}:run:${run.id}:attempt:${run.runAttempt}`;
      const validRun =
        run.headSha === target.expectedHeadSha &&
        required.events.includes(run.event as (typeof required.events)[number]);
      if (validRun && jobs.length === 0 && run.status !== "completed") status = "pending";
      if (validRun && jobs.length === 1) {
        const job = jobs[0],
          id = checkRunId(job.checkRunUrl, target);
        const check = snapshot.checks.find((check) => check.id === id);
        const valid =
          job.runId === run.id &&
          job.runAttempt === run.runAttempt &&
          check &&
          check.checkSuiteId === run.checkSuiteId &&
          check.headSha === target.expectedHeadSha &&
          check.name === required.name &&
          check.appId === required.appId &&
          check.appSlug === required.appSlug;
        remoteId += `:job:${job.id}:check:${id ?? "unknown"}`;
        if (valid) {
          sourceUpdatedAt = Math.max(
            sourceUpdatedAt,
            ...[job.startedAt, job.completedAt, check.startedAt, check.completedAt]
              .filter((x): x is string => x !== null)
              .map(Date.parse),
          );
          if (job.status !== "completed" || check.status !== "completed") status = "pending";
          else if (job.conclusion !== check.conclusion) status = "unknown";
          else if (job.conclusion === "success") status = "success";
          else if (job.conclusion === "skipped" || job.conclusion === "neutral") status = "skipped";
          else if (
            ["failure", "cancelled", "timed_out", "action_required", "stale"].includes(
              job.conclusion ?? "",
            )
          )
            status = "failure";
        }
      }
      if (sourceUpdatedAt > observedAt) status = "unknown";
      output.push({
        producer,
        name: required.name,
        sourceSha: target.expectedHeadSha,
        observedAt,
        sourceUpdatedAt,
        remoteId,
        runSequence: run.runNumber,
        runAttempt: run.runAttempt,
        status,
        verified: true,
      });
    }
  }
  return output;
}
function mapReviews(
  snapshot: GitHubSnapshot,
  target: GitHubSourceTarget,
  policy: GitHubEvidencePolicy,
): ReviewEvidence[] {
  const output: ReviewEvidence[] = [],
    observedAt = Date.parse(snapshot.observedAt);
  const latest = new Map<string, (typeof snapshot.reviews)[number][]>();
  for (const review of snapshot.reviews.filter(
    (review) => review.commitId === target.expectedHeadSha,
  )) {
    const rows = latest.get(review.userId) ?? [];
    const date = Date.parse(review.submittedAt ?? snapshot.pullRequest.updatedAt);
    const maximum = Math.max(
      -Infinity,
      ...rows.map((row) => Date.parse(row.submittedAt ?? snapshot.pullRequest.updatedAt)),
    );
    if (date > maximum) latest.set(review.userId, [review]);
    else if (date === maximum) latest.set(review.userId, [...rows, review]);
  }
  const outstanding =
    snapshot.reviewThreads.filter((thread) => !thread.isResolved).length +
    [...latest.values()].filter((rows) => rows.some((row) => row.state === "CHANGES_REQUESTED"))
      .length;
  if (policy.codexReview) {
    const required = policy.codexReview,
      producer = githubBotReviewProducer(
        target.providerRepositoryId,
        required.userId,
        required.appId,
      );
    const comments = snapshot.reviewSummaries.filter(
      (comment) =>
        comment.userId === required.userId &&
        comment.markerPresent &&
        (!comment.marker ||
          comment.marker.code_review.commit_sha === null ||
          comment.marker.code_review.commit_sha === target.expectedHeadSha),
    );
    const ambiguous = comments.length > 1;
    for (const comment of comments) {
      const state = comment.marker?.code_review;
      const recognized =
        !ambiguous &&
        comment.markerCount === 1 &&
        comment.userType === "Bot" &&
        comment.appId === required.appId &&
        state?.commit_sha === target.expectedHeadSha;
      const complete =
        recognized &&
        state?.status === "completed" &&
        typeof state.has_any_findings === "boolean" &&
        typeof state.has_unresolved_findings === "boolean";
      const status: ReviewEvidence["status"] = complete
        ? "completed"
        : recognized && ["pending", "in_progress", "queued"].includes(state?.status ?? "")
          ? "pending"
          : "unknown";
      output.push({
        producer,
        sourceSha: target.expectedHeadSha,
        observedAt,
        sourceUpdatedAt: Date.parse(comment.updatedAt),
        remoteId: `github:${target.providerRepositoryId}:pr:${snapshot.pullRequest.id}:comment:${comment.id}:${comment.bodyDigest.slice(0, 16)}`,
        runSequence: 0,
        runAttempt: 1,
        status,
        unresolvedFindings: outstanding + (state?.has_unresolved_findings ? 1 : 0),
        independent: comment.userId !== snapshot.pullRequest.authorId,
        verified: true,
      });
    }
  }
  for (const required of policy.formalReviewers) {
    const producer = githubFormalReviewProducer(target.providerRepositoryId, required.userId);
    for (const review of latest.get(required.userId) ?? []) {
      output.push({
        producer,
        sourceSha: target.expectedHeadSha,
        observedAt,
        sourceUpdatedAt: Date.parse(review.submittedAt ?? snapshot.pullRequest.updatedAt),
        remoteId: `github:${target.providerRepositoryId}:pr:${snapshot.pullRequest.id}:review:${review.id}:${review.bodyDigest.slice(0, 16)}`,
        runSequence: 0,
        runAttempt: 1,
        status:
          review.state === "APPROVED" && review.submittedAt !== null ? "completed" : "unknown",
        unresolvedFindings: outstanding,
        independent: review.userId !== snapshot.pullRequest.authorId,
        verified: true,
      });
    }
  }
  return output;
}

/** Only entry is an independently configured authenticated fetch, never a public
 * ingest(snapshot) operation that a manager can self-authorize. */
export class GitHubEvidenceAdapter {
  constructor(
    private readonly source: GitHubSourceConnection,
    private readonly clock = () => Date.now(),
  ) {}
  async observe(targetInput: unknown, policyInput: unknown, paused = false) {
    const target = githubSourceTargetSchema.parse(targetInput),
      policy = githubEvidencePolicySchema.parse(policyInput);
    const raw = await this.source.collect(target);
    if (Buffer.byteLength(JSON.stringify(raw)) > GITHUB_SOURCE_MAX_BYTES)
      throw new DeliveryConflict("github_source_too_large");
    const snapshot = githubSnapshotSchema.parse(raw),
      now = this.clock();
    assertSnapshot(snapshot, target, policy, now);
    const checks = mapChecks(snapshot, target, policy),
      reviews = mapReviews(snapshot, target, policy);
    const checkProducers = policy.checks.map((check) =>
      githubCheckProducer(target.providerRepositoryId, check.workflowId, check.appId),
    );
    const reviewProducers = [
      ...(policy.codexReview
        ? [
            githubBotReviewProducer(
              target.providerRepositoryId,
              policy.codexReview.userId,
              policy.codexReview.appId,
            ),
          ]
        : []),
      ...policy.formalReviewers.map((review) =>
        githubFormalReviewProducer(target.providerRepositoryId, review.userId),
      ),
    ];
    const eligibility = evaluateDeliveryEligibility({
      sourceSha: target.expectedHeadSha,
      now,
      paused,
      policy: {
        version: policy.version,
        requiredChecks: policy.checks.map((check, index) => ({
          name: check.name,
          producer: checkProducers[index],
        })),
        requireIndependentReview: true,
        maxEvidenceAgeMs: policy.maxAgeMs,
      },
      checks,
      reviews,
      trustedCheckProducers: checkProducers,
      trustedReviewProducers: reviewProducers,
    });
    const blockers = [...eligibility.blockers];
    for (const producer of reviewProducers)
      if (!reviews.some((review) => review.producer === producer))
        blockers.push(`review-producer-missing:${producer}`);
    if (snapshot.pullRequest.state !== "open") blockers.push("pull-not-open");
    if (snapshot.pullRequest.draft) blockers.push("pull-draft");
    return {
      snapshot,
      target,
      policy,
      checks,
      reviews,
      checkProducers,
      reviewProducers,
      contentDigest: githubSourceDigest(snapshot),
      eligibility: { ...eligibility, eligible: blockers.length === 0, blockers },
    };
  }
}
