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
export function isCouncilReport(v: unknown): v is CouncilReport {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.outcome === "string" &&
    typeof obj.councilSize === "number" &&
    typeof obj.reviewersCompleted === "number" &&
    Array.isArray(obj.findings) &&
    Array.isArray(obj.consensusItems) &&
    typeof obj.durationMs === "number" &&
    typeof obj.timestamp === "string"
  );
}
