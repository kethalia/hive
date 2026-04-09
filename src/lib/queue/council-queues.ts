import { FlowProducer, Queue, Worker } from "bullmq";
import {
  COUNCIL_AGGREGATOR_QUEUE,
  COUNCIL_JOB_TIMEOUT_MS,
  COUNCIL_REVIEWER_QUEUE,
} from "@/lib/constants";
import { getRedisConnection } from "./connection";
import { createCouncilReviewerProcessor } from "@/lib/council/reviewer-processor";
import { createCouncilAggregatorProcessor } from "@/lib/council/aggregator-processor";
import type { CoderClient } from "@/lib/coder/client";

// ── Job data interfaces ────────────────────────────────────────────

/** Data required by a council reviewer job. */
export interface CouncilReviewerJobData {
  taskId: string;
  reviewerIndex: number;
  prUrl: string;
  repoUrl: string;
  branchName: string;
}

/** Data required by a council aggregator job. */
export interface CouncilAggregatorJobData {
  taskId: string;
  councilSize: number;
  prUrl: string;
}

// ── Lazy singletons ────────────────────────────────────────────────

let reviewerQueue: Queue<CouncilReviewerJobData> | null = null;
let aggregatorQueue: Queue<CouncilAggregatorJobData> | null = null;
let flowProducer: FlowProducer | null = null;

/** Returns the shared council reviewer Queue singleton. */
export function getCouncilReviewerQueue(): Queue<CouncilReviewerJobData> {
  if (!reviewerQueue) {
    reviewerQueue = new Queue<CouncilReviewerJobData>(COUNCIL_REVIEWER_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return reviewerQueue;
}

/** Returns the shared council aggregator Queue singleton. */
export function getCouncilAggregatorQueue(): Queue<CouncilAggregatorJobData> {
  if (!aggregatorQueue) {
    aggregatorQueue = new Queue<CouncilAggregatorJobData>(COUNCIL_AGGREGATOR_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return aggregatorQueue;
}

/**
 * Returns the shared FlowProducer singleton.
 * Used to add reviewer children + aggregator parent as an atomic flow.
 */
export function getCouncilFlowProducer(): FlowProducer {
  if (!flowProducer) {
    flowProducer = new FlowProducer({
      connection: getRedisConnection(),
    });
  }
  return flowProducer;
}

// ── Worker factories ───────────────────────────────────────────────

/**
 * Creates a council reviewer Worker.
 * Each worker instance processes jobs from the council-reviewer queue.
 * Concurrency 5 — up to five simultaneous reviewer agents per process.
 *
 * @param coderClient - Authenticated Coder API client passed to the processor.
 */
export function createCouncilReviewerWorker(coderClient: CoderClient): Worker<CouncilReviewerJobData> {
  return new Worker<CouncilReviewerJobData>(
    COUNCIL_REVIEWER_QUEUE,
    createCouncilReviewerProcessor(coderClient),
    {
      connection: getRedisConnection(),
      concurrency: 5,
      lockDuration: COUNCIL_JOB_TIMEOUT_MS,
    }
  );
}

/**
 * Creates a council aggregator Worker.
 * Each worker instance processes jobs from the council-aggregator queue.
 * Concurrency 3 — aggregation is heavier, fewer concurrent runs.
 */
export function createCouncilAggregatorWorker(): Worker<CouncilAggregatorJobData> {
  return new Worker<CouncilAggregatorJobData>(
    COUNCIL_AGGREGATOR_QUEUE,
    createCouncilAggregatorProcessor(),
    {
      connection: getRedisConnection(),
      concurrency: 3,
      lockDuration: COUNCIL_JOB_TIMEOUT_MS,
    }
  );
}
