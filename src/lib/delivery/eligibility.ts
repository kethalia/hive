/** Pure observation-only gate. Passing this result never authorizes a merge. */
export interface DeliveryPolicy {
  version: string;
  requiredChecks: { name: string; producer: string }[];
  requireIndependentReview: boolean;
  maxEvidenceAgeMs: number;
}

export interface RevisionEvidence {
  sourceSha: string;
  observedAt: number;
  /** Authoritative remote update time; never webhook arrival or fetch time. */
  sourceUpdatedAt: number;
  remoteId: string;
  /** Trusted adapter sequence within the exact workflow/reviewer identity. */
  runSequence: number;
  runAttempt: number;
}

export interface CheckEvidence extends RevisionEvidence {
  name: string;
  producer: string;
  status: "pending" | "success" | "failure" | "skipped" | "unknown";
  /** Set by an authenticated adapter, never by the task result submitter. */
  verified: boolean;
}

export interface ReviewEvidence extends RevisionEvidence {
  producer: string;
  status: "pending" | "completed" | "unknown";
  unresolvedFindings: number;
  independent: boolean;
  verified: boolean;
}

export interface EligibilityInput {
  sourceSha: string;
  now: number;
  paused: boolean;
  policy: DeliveryPolicy;
  checks: CheckEvidence[];
  reviews: ReviewEvidence[];
  /** Configured by trusted integration configuration, not the manager. */
  trustedCheckProducers: string[];
  trustedReviewProducers: string[];
}

export interface EligibilityResult {
  mode: "observation";
  eligible: boolean;
  sourceSha: string;
  policyVersion: string;
  blockers: string[];
}

const SHA = /^[a-f0-9]{40}$/;

export function evaluateDeliveryEligibility(input: EligibilityInput): EligibilityResult {
  const blockers: string[] = [];
  const { policy, sourceSha, now } = input;
  const block = (reason: string) => blockers.push(reason);
  if (!SHA.test(sourceSha)) block("invalid-source-revision");
  if (input.paused) block("delivery-paused");
  if (
    !policy.version.trim() ||
    !Number.isFinite(now) ||
    !Number.isFinite(policy.maxEvidenceAgeMs) ||
    policy.maxEvidenceAgeMs <= 0 ||
    policy.requiredChecks.length === 0 ||
    policy.requiredChecks.some((check) => !check.name.trim() || !check.producer.trim()) ||
    new Set(policy.requiredChecks.map((check) => `${check.producer}:${check.name}`)).size !==
      policy.requiredChecks.length
  ) {
    block("invalid-policy");
  }

  const fresh = (evidence: RevisionEvidence) =>
    evidence.sourceSha === sourceSha &&
    Boolean(evidence.remoteId.trim()) &&
    Number.isSafeInteger(evidence.runSequence) &&
    evidence.runSequence >= 0 &&
    Number.isSafeInteger(evidence.runAttempt) &&
    evidence.runAttempt >= 1 &&
    Number.isFinite(evidence.sourceUpdatedAt) &&
    evidence.sourceUpdatedAt <= evidence.observedAt &&
    Number.isFinite(evidence.observedAt) &&
    evidence.observedAt <= now &&
    now - evidence.observedAt <= policy.maxEvidenceAgeMs;

  function currentRun<T extends RevisionEvidence>(candidates: T[]): T[] {
    const sequence = Math.max(...candidates.map((item) => item.runSequence));
    const run = candidates.filter((item) => item.runSequence === sequence);
    const attempt = Math.max(...run.map((item) => item.runAttempt));
    const rerun = run.filter((item) => item.runAttempt === attempt);
    const updated = Math.max(...rerun.map((item) => item.sourceUpdatedAt));
    const observations = new Map<string, T>();
    for (const item of rerun.filter((item) => item.sourceUpdatedAt === updated)) {
      const key = JSON.stringify(
        Object.entries(item)
          .filter(([key]) => key !== "observedAt")
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const previous = observations.get(key);
      if (!previous || item.observedAt > previous.observedAt) observations.set(key, item);
    }
    return [...observations.values()];
  }

  for (const { name, producer } of policy.requiredChecks) {
    const candidates = input.checks.filter(
      (check) =>
        check.name === name &&
        check.producer === producer &&
        check.sourceSha === sourceSha &&
        check.verified &&
        input.trustedCheckProducers.includes(check.producer),
    );
    // A later failed or pending rerun supersedes an earlier success. Equal-time
    // conflicting observations fail closed instead of depending on array order.
    const current = currentRun(candidates);
    if (!current.length) block(`check-missing:${name}`);
    else if (current.some((check) => !fresh(check))) block(`check-stale:${name}`);
    else if (current.some((check) => check.status !== "success")) block(`check-not-passed:${name}`);
  }

  if (policy.requireIndependentReview) {
    const candidates = input.reviews.filter(
      (review) =>
        review.sourceSha === sourceSha &&
        review.verified &&
        input.trustedReviewProducers.includes(review.producer),
    );
    if (!candidates.length) block("review-missing");
    // One reviewer's later approval cannot erase another reviewer's findings.
    for (const producer of new Set(candidates.map((review) => review.producer))) {
      const producerReviews = candidates.filter((review) => review.producer === producer);
      const current = currentRun(producerReviews);
      if (!current.length || current.some((review) => !fresh(review))) block("review-stale");
      else if (
        current.some(
          (review) =>
            !review.independent || review.status !== "completed" || review.unresolvedFindings !== 0,
        )
      )
        block("review-not-passed");
    }
  }

  return {
    mode: "observation",
    eligible: blockers.length === 0,
    sourceSha,
    policyVersion: policy.version,
    blockers,
  };
}
