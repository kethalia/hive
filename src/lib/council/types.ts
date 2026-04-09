/**
 * Types for the multi-agent council review feature.
 *
 * A council is a set of independent reviewer agents that each produce
 * ReviewerFindings for a PR. The aggregator merges them into a
 * CouncilReport which is stored as councilReport on the Task record.
 */

/** A single finding from one council reviewer agent. */
export interface ReviewerFinding {
  /** Path to the file containing the issue. */
  file: string;
  /** 1-based line number where the issue starts. */
  startLine: number;
  /** Severity classification. */
  severity: "critical" | "major" | "minor" | "nit";
  /** Short description of the problem. */
  issue: string;
  /** Suggested fix. */
  fix: string;
  /** Reviewer's reasoning for flagging this finding. */
  reasoning: string;
}

/**
 * A finding merged across multiple reviewers.
 * agreementCount reflects how many reviewers flagged the same issue.
 */
export interface AggregatedFinding extends ReviewerFinding {
  /** Number of reviewers that independently identified this finding. */
  agreementCount: number;
  /** True when a majority of the council flagged this finding. */
  isConsensus: boolean;
}

/** Structured council report stored in the councilReport Json? column. */
export interface CouncilReport {
  /** High-level outcome of the council run. */
  outcome: "complete" | "partial" | "inconclusive";
  /** Number of reviewers requested. */
  councilSize: number;
  /** Number of reviewers that successfully completed their review. */
  reviewersCompleted: number;
  /** All deduplicated findings from the council. */
  findings: AggregatedFinding[];
  /** Subset of findings agreed on by the majority of reviewers. */
  consensusItems: AggregatedFinding[];
  /** URL of the GitHub comment posted by the aggregator, or null if not posted. */
  postedCommentUrl: string | null;
  /** Wall-clock duration of the full council run in milliseconds. */
  durationMs: number;
  /** ISO 8601 timestamp of when the report was generated. */
  timestamp: string;
}

/**
 * Runtime type guard for CouncilReport.
 * Validates the shape of Prisma's councilReport Json? column before rendering.
 */
export function isCouncilReport(value: unknown): value is CouncilReport {
  if (typeof value !== "object" || value === null) return false;
  const validOutcomes = ["complete", "partial", "inconclusive"];
  if (
    !("outcome" in value) ||
    typeof value.outcome !== "string" ||
    !validOutcomes.includes(value.outcome) ||
    !("councilSize" in value) ||
    typeof value.councilSize !== "number" ||
    !("reviewersCompleted" in value) ||
    typeof value.reviewersCompleted !== "number" ||
    !("findings" in value) ||
    !Array.isArray(value.findings) ||
    !("consensusItems" in value) ||
    !Array.isArray(value.consensusItems) ||
    !("durationMs" in value) ||
    typeof value.durationMs !== "number" ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "string"
  ) {
    return false;
  }
  // postedCommentUrl is optional: string | null | undefined
  if (
    "postedCommentUrl" in value &&
    value.postedCommentUrl !== null &&
    typeof value.postedCommentUrl !== "string"
  ) {
    return false;
  }
  // Validate individual finding items to prevent render crashes
  for (const item of value.findings) {
    if (!isValidFinding(item)) return false;
  }
  for (const item of value.consensusItems) {
    if (!isValidFinding(item)) return false;
  }
  return true;
}

/** Validate minimum shape of a finding to prevent render crashes. */
function isValidFinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    "file" in value &&
    typeof value.file === "string" &&
    "startLine" in value &&
    typeof value.startLine === "number" &&
    "severity" in value &&
    typeof value.severity === "string" &&
    "issue" in value &&
    typeof value.issue === "string"
  );
}
