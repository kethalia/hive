import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      status: "ready",
      disconnect: vi.fn(),
      quit: vi.fn(),
    })),
  };
});

// Mock the Redis connection module directly
vi.mock("@/lib/queue/connection", () => ({
  getRedisConnection: vi.fn(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

// Mock BullMQ Queue, Worker, and FlowProducer
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation((name: string, opts: unknown) => ({
    name,
    opts,
    add: vi.fn(),
    close: vi.fn(),
  })),
  Worker: vi.fn().mockImplementation((name: string, processor: Function, opts: unknown) => ({
    name,
    processor,
    opts,
    on: vi.fn(),
    close: vi.fn(),
  })),
  FlowProducer: vi.fn().mockImplementation((opts: unknown) => ({
    opts,
    add: vi.fn(),
    close: vi.fn(),
  })),
}));

// Mock processor factories so council-queues.ts doesn't pull in real deps
vi.mock("@/lib/council/reviewer-processor", () => ({
  createCouncilReviewerProcessor: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/council/aggregator-processor", () => ({
  createCouncilAggregatorProcessor: vi.fn(() => vi.fn()),
}));

import { Queue, Worker, FlowProducer } from "bullmq";
import {
  getCouncilReviewerQueue,
  getCouncilAggregatorQueue,
  getCouncilFlowProducer,
  createCouncilReviewerWorker,
  createCouncilAggregatorWorker,
} from "@/lib/queue/council-queues";
import type { CoderClient } from "@/lib/coder/client";

// ── Tests ─────────────────────────────────────────────────────────

describe("council queue infrastructure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Queue singletons ──────────────────────────────────────────────

  describe("getCouncilReviewerQueue()", () => {
    it("returns a Queue constructed with name 'council-reviewer' and connection option", () => {
      const queue = getCouncilReviewerQueue();

      expect(Queue).toHaveBeenCalledWith(
        "council-reviewer",
        expect.objectContaining({ connection: expect.anything() }),
      );
      expect(queue).toBeDefined();
    });

    it("is a singleton — calling twice returns the same instance", () => {
      const first = getCouncilReviewerQueue();
      const second = getCouncilReviewerQueue();

      expect(first).toBe(second);
    });
  });

  describe("getCouncilAggregatorQueue()", () => {
    it("returns a Queue constructed with name 'council-aggregator' and connection option", () => {
      const queue = getCouncilAggregatorQueue();

      expect(Queue).toHaveBeenCalledWith(
        "council-aggregator",
        expect.objectContaining({ connection: expect.anything() }),
      );
      expect(queue).toBeDefined();
    });

    it("is a singleton — calling twice returns the same instance", () => {
      const first = getCouncilAggregatorQueue();
      const second = getCouncilAggregatorQueue();

      expect(first).toBe(second);
    });
  });

  describe("getCouncilFlowProducer()", () => {
    it("returns a FlowProducer constructed with connection option", () => {
      const producer = getCouncilFlowProducer();

      expect(FlowProducer).toHaveBeenCalledWith(
        expect.objectContaining({ connection: expect.anything() }),
      );
      expect(producer).toBeDefined();
    });

    it("is a singleton — calling twice returns the same instance", () => {
      const first = getCouncilFlowProducer();
      const second = getCouncilFlowProducer();

      expect(first).toBe(second);
    });
  });

  // ── Worker factories ──────────────────────────────────────────────

  describe("createCouncilReviewerWorker()", () => {
    it("creates a Worker with queue name 'council-reviewer' and connection option", () => {
      const mockClient = {} as unknown as CoderClient;
      const worker = createCouncilReviewerWorker(mockClient);

      expect(Worker).toHaveBeenCalledWith(
        "council-reviewer",
        expect.any(Function),
        expect.objectContaining({ connection: expect.anything() }),
      );
      expect(worker).toBeDefined();
    });
  });

  describe("createCouncilAggregatorWorker()", () => {
    it("creates a Worker with queue name 'council-aggregator' and connection option", () => {
      const worker = createCouncilAggregatorWorker();

      expect(Worker).toHaveBeenCalledWith(
        "council-aggregator",
        expect.any(Function),
        expect.objectContaining({ connection: expect.anything() }),
      );
      expect(worker).toBeDefined();
    });
  });
});
