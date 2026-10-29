/** Pure observation-only gate. Passing this result never authorizes a merge. */
export interface DeliveryPolicy {
  version: string;
  requiredChecks: string[];
  requireIndependentReview: boolean;
  maxEvidenceAgeMs: number;
}

export interface RevisionEvidence {
  sourceSha: string;
  observedAt: number;
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
    policy.requiredChecks.some((name) => !name.trim()) ||
    new Set(policy.requiredChecks).size !== policy.requiredChecks.length
  ) {
    block("invalid-policy");
  }

  const fresh = (evidence: RevisionEvidence) =>
    evidence.sourceSha === sourceSha &&
    Number.isFinite(evidence.observedAt) &&
    evidence.observedAt <= now &&
    now - evidence.observedAt <= policy.maxEvidenceAgeMs;

  for (const name of policy.requiredChecks) {
    const candidates = input.checks.filter(
      (check) =>
        check.name === name &&
        check.sourceSha === sourceSha &&
        check.verified &&
        input.trustedCheckProducers.includes(check.producer),
    );
    // A later failed or pending rerun supersedes an earlier success. Equal-time
    // conflicting observations fail closed instead of depending on array order.
    const newest = Math.max(...candidates.map((check) => check.observedAt));
    const current = candidates.filter((check) => check.observedAt === newest);
    if (!current.length) block(`check-missing:${name}`);
    else if (current.some((check) => !fresh(check))) block(`check-stale:${name}`);
    else if (current.some((check) => check.status !== "success")) block(`check-not-passed:${name}`);
  }

  if (policy.requireIndependentReview) {
    const candidates = input.reviews.filter(
      (review) =>
        review.sourceSha === sourceSha &&
        review.verified &&
        review.independent &&
        input.trustedReviewProducers.includes(review.producer),
    );
    if (!candidates.length) block("review-missing");
    // One reviewer's later approval cannot erase another reviewer's findings.
    for (const producer of new Set(candidates.map((review) => review.producer))) {
      const producerReviews = candidates.filter((review) => review.producer === producer);
      const newest = Math.max(...producerReviews.map((review) => review.observedAt));
      const current = producerReviews.filter((review) => review.observedAt === newest);
      if (!current.length || current.some((review) => !fresh(review))) block("review-stale");
      else if (
        current.some((review) => review.status !== "completed" || review.unresolvedFindings !== 0)
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
