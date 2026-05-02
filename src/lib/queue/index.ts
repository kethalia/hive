/**
 * Worker registry — exports all BullMQ worker factory functions.
 * Import from here to start all workers in a single process.
 */

export { createTemplatePushWorker, getTemplatePushQueue } from "@/lib/templates/push-queue";
export {
  createCouncilAggregatorWorker,
  createCouncilReviewerWorker,
  getCouncilAggregatorQueue,
  getCouncilFlowProducer,
  getCouncilReviewerQueue,
} from "./council-queues";
export { createTaskWorker, getTaskQueue } from "./task-queue";
export {
  createTokenRotationWorker,
  getTokenRotationQueue,
  scheduleTokenRotation,
} from "./token-rotation";
