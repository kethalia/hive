/**
 * BullMQ processor for council aggregator jobs.
 *
 * Collects child reviewer job results via job.getChildrenValues(), aggregates
 * findings, formats a PR comment, posts it, persists the CouncilReport to DB,
 * and returns the report.
 *
 * Log prefix: [council-aggregator]
 */

import type { Job } from "bullmq";
import type { CouncilAggregatorJobData } from "@/lib/queue/council-queues";
import type { CouncilReport, ReviewerFinding } from "@/lib/council/types";
import { aggregateFindings } from "@/lib/council/aggregator";
import { formatCouncilComment } from "@/lib/council/formatter";
import { postPRComment } from "@/lib/council/comment";
import { getDb } from "@/lib/db";

/**
 * Returns a BullMQ processor function for council aggregator jobs.
 */
export function createCouncilAggregatorProcessor(): (
  job: Job<CouncilAggregatorJobData>,
) => Promise<CouncilReport> {
  return async (job: Job<CouncilAggregatorJobData>): Promise<CouncilReport> => {
    const startMs = Date.now();
    const { taskId, councilSize, prUrl } = job.data;

    console.log(
      `[council-aggregator] job=${job.id} taskId=${taskId} councilSize=${councilSize} start`,
    );

    // 1. Collect child job results; failed children return undefined/null
    const childrenValues: Record<string, unknown> = await job.getChildrenValues();

    // 2. Separate valid reviewer results from failed ones
    //    Validate each child's findings array to prevent shape mismatches
    //    from silently corrupting downstream aggregation.
    const validResults: ReviewerFinding[][] = [];
    for (const [childKey, value] of Object.entries(childrenValues)) {
      if (Array.isArray(value) && value.every(isValidReviewerFinding)) {
        validResults.push(value as ReviewerFinding[]);
      } else if (Array.isArray(value)) {
        console.warn(
          `[council-aggregator] job=${job.id} child=${childKey} returned malformed findings — skipped`,
        );
      }
      // null / undefined / non-array → reviewer failed, counted as not completed
    }

    // Log warning if child count doesn't match expected council size
    const childCount = Object.keys(childrenValues).length;
    if (childCount !== councilSize) {
      console.warn(
        `[council-aggregator] job=${job.id} expected ${councilSize} children but got ${childCount}`,
      );
    }

    const reviewersCompleted = validResults.length;
    const totalChildren = Object.keys(childrenValues).length;
    const reviewersFailed = totalChildren - reviewersCompleted;

    // 3. Determine outcome
    let outcome: CouncilReport["outcome"];
    if (reviewersFailed === 0 && reviewersCompleted > 0) {
      outcome = "complete";
    } else if (reviewersCompleted === 0) {
      outcome = "inconclusive";
    } else {
      outcome = "partial";
    }

    console.log(
      `[council-aggregator] job=${job.id} taskId=${taskId} outcome=${outcome} reviewersCompleted=${reviewersCompleted} reviewersFailed=${reviewersFailed}`,
    );

    // 4. Aggregate findings
    const { findings, consensusItems } = aggregateFindings(validResults, councilSize);

    console.log(
      `[council-aggregator] job=${job.id} taskId=${taskId} findings=${findings.length} consensusItems=${consensusItems.length}`,
    );

    // 5. Build partial CouncilReport (without postedCommentUrl and timing yet)
    const reportWithoutUrl: Omit<CouncilReport, "postedCommentUrl" | "durationMs" | "timestamp"> = {
      outcome,
      councilSize,
      reviewersCompleted,
      findings,
      consensusItems,
    };

    // 6. Format comment and post to PR
    const partialReport: CouncilReport = {
      ...reportWithoutUrl,
      postedCommentUrl: null,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };
    const commentBody = formatCouncilComment(partialReport);
    const postedCommentUrl = await postPRComment(prUrl, commentBody);

    if (postedCommentUrl) {
      console.log(
        `[council-aggregator] job=${job.id} taskId=${taskId} comment posted: ${postedCommentUrl}`,
      );
    } else {
      console.log(
        `[council-aggregator] job=${job.id} taskId=${taskId} comment post failed or skipped`,
      );
    }

    // 7. Build final CouncilReport with timing
    const durationMs = Date.now() - startMs;
    const report: CouncilReport = {
      outcome,
      councilSize,
      reviewersCompleted,
      findings,
      consensusItems,
      postedCommentUrl,
      durationMs,
      timestamp: new Date().toISOString(),
    };

    // 8. Persist to DB — on error, log and re-throw so the job fails and is visible
    const db = getDb();
    try {
      await db.task.update({
        where: { id: taskId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { councilReport: report as any },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[council-aggregator] job=${job.id} taskId=${taskId} DB persist failed: ${msg}`,
      );
      throw err;
    }

    console.log(
      `[council-aggregator] job=${job.id} taskId=${taskId} complete durationMs=${durationMs}`,
    );

    return report;
  };
}

/** Validate minimum shape of a ReviewerFinding from child job output. */
function isValidReviewerFinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    "file" in value &&
    typeof value.file === "string" &&
    "startLine" in value &&
    typeof value.startLine === "number" &&
    "severity" in value &&
    typeof value.severity === "string" &&
    "issue" in value &&
    typeof value.issue === "string" &&
    "fix" in value &&
    typeof value.fix === "string" &&
    "reasoning" in value &&
    typeof value.reasoning === "string"
  );
}
