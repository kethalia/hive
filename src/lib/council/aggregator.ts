/**
 * Aggregator — groups ReviewerFinding[][] by file+startLine and computes consensus.
 *
 * Pure function: no I/O, no side effects.
 * [council-aggregator] log prefix used by callers for lifecycle visibility.
 */

import type { AggregatedFinding, ReviewerFinding } from "./types.js";

export interface AggregationResult {
  findings: AggregatedFinding[];
  consensusItems: AggregatedFinding[];
}

/**
 * Merge findings from multiple reviewer agents into a deduplicated list.
 *
 * Consensus rule (D013): a finding is consensus when `agreementCount >= 2`.
 *
 * TODO: make consensus threshold configurable based on councilSize
 * (e.g. majority = ceil(councilSize / 2)) once UX requirements are clearer.
 *
 * @param reviewerResults - One entry per reviewer; each entry is that reviewer's
 *   array of ReviewerFindings. May be empty (reviewer failed / returned nothing).
 * @param councilSize - Total number of reviewers requested. Reserved for future
 *   threshold calculation; currently consensus is hardcoded to `>= 2`.
 */
export function aggregateFindings(
  reviewerResults: ReviewerFinding[][],
  _councilSize: number,
): AggregationResult {
  // Map from grouping key → [first occurrence, agreementCount]
  const grouped = new Map<string, { finding: ReviewerFinding; count: number }>();

  for (const reviewerFindings of reviewerResults) {
    // Each reviewer may have flagged zero findings — that is fine.
    for (const finding of reviewerFindings) {
      const key = `${finding.file}:${finding.startLine}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.set(key, { finding, count: 1 });
      }
    }
  }

  const findings: AggregatedFinding[] = Array.from(grouped.values()).map(({ finding, count }) => ({
    ...finding,
    agreementCount: count,
    isConsensus: count >= 2,
  }));

  const consensusItems = findings.filter((f) => f.isConsensus);

  return { findings, consensusItems };
}
