/**
 * Integration tests for the council step (step 13) in task-queue.ts.
 *
 * Tests verify that the council block correctly fires FlowProducer when
 * all conditions are met, and is a no-op when they aren't. Council failures
 * must not change task status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Infrastructure mocks (must come before imports) ───────────────

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

vi.mock("@/lib/queue/connection", () => ({
  getRedisConnection: vi.fn(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

// ── BullMQ mock ───────────────────────────────────────────────────

const mockFlowAdd = vi.fn();
const mockQueueEventsClose = vi.fn().mockResolvedValue(undefined);
const mockWaitUntilFinished = vi.fn().mockResolvedValue({ outcome: "complete" });

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    close: vi.fn(),
  })),
  Worker: vi.fn().mockImplementation((name: string, processor: Function, opts: unknown) => {
    (Worker as any).__lastProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
  QueueEvents: vi.fn().mockImplementation(() => ({
    close: mockQueueEventsClose,
  })),
  FlowProducer: vi.fn().mockImplementation(() => ({
    add: mockFlowAdd,
    close: vi.fn(),
  })),
}));

import { Worker, QueueEvents, FlowProducer } from "bullmq";

// ── Prisma mock ───────────────────────────────────────────────────

const mockTaskUpdate = vi.fn().mockResolvedValue({});
const mockTaskFindUnique = vi.fn().mockResolvedValue({ councilSize: 3 });
const mockWorkspaceCreate = vi.fn().mockResolvedValue({});
const mockWorkspaceUpdate = vi.fn().mockResolvedValue({});
const mockTaskLogCreate = vi.fn().mockResolvedValue({});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    task: {
      update: mockTaskUpdate,
      findUnique: mockTaskFindUnique,
    },
    workspace: {
      create: mockWorkspaceCreate,
      update: mockWorkspaceUpdate,
    },
    taskLog: {
      create: mockTaskLogCreate,
    },
  })),
}));

// ── Blueprint mocks ───────────────────────────────────────────────

const mockRunBlueprint = vi.fn();
vi.mock("@/lib/blueprint/runner", () => ({
  runBlueprint: (...args: unknown[]) => mockRunBlueprint(...args),
}));

vi.mock("@/lib/blueprint/steps/hydrate", () => ({
  createHydrateStep: vi.fn(() => ({ name: "hydrate-context", execute: vi.fn() })),
}));
vi.mock("@/lib/blueprint/steps/rules", () => ({
  createRulesStep: vi.fn(() => ({ name: "scoped-rules", execute: vi.fn() })),
}));
vi.mock("@/lib/blueprint/steps/tools", () => ({
  createToolsStep: vi.fn(() => ({ name: "tool-selection", execute: vi.fn() })),
}));
vi.mock("@/lib/blueprint/steps/agent", () => ({
  createAgentStep: vi.fn(() => ({ name: "agent-execution", execute: vi.fn() })),
}));
vi.mock("@/lib/blueprint/steps/lint", () => ({
  createLintStep: vi.fn(() => ({ name: "lint", execute: vi.fn() })),
}));
vi.mock("@/lib/blueprint/steps/commit-push", () => ({
  createCommitPushStep: vi.fn(() => ({ name: "commit-push", execute: vi.fn() })),
}));
vi.mock("@/lib/blueprint/steps/ci", () => ({
  createCIStep: vi.fn(() => ({ name: "ci-feedback", execute: vi.fn() })),
}));
vi.mock("@/lib/blueprint/steps/pr", () => ({
  createPRStep: vi.fn(() => ({ name: "pr-create", execute: vi.fn() })),
}));
vi.mock("@/lib/workspace/cleanup", () => ({
  cleanupWorkspace: vi.fn(),
}));
vi.mock("@/lib/blueprint/verifier", () => ({
  createVerifierBlueprint: vi.fn(() => [
    { name: "verify-detect", execute: vi.fn() },
  ]),
}));

// ── council-queues mock ───────────────────────────────────────────

const mockGetCouncilFlowProducer = vi.fn(() => ({
  add: mockFlowAdd,
  close: vi.fn(),
}));

vi.mock("@/lib/queue/council-queues", () => ({
  getCouncilFlowProducer: () => mockGetCouncilFlowProducer(),
  getCouncilReviewerQueue: vi.fn(),
  getCouncilAggregatorQueue: vi.fn(),
  createCouncilReviewerWorker: vi.fn(),
  createCouncilAggregatorWorker: vi.fn(),
}));

// ── Imports under test ────────────────────────────────────────────

import { createTaskWorker, type TaskJobData } from "@/lib/queue/task-queue";
import type { CoderClient } from "@/lib/coder/client";

// ── Helpers ───────────────────────────────────────────────────────

function makeMockCoderClient(): CoderClient {
  return {
    createWorkspace: vi.fn().mockResolvedValue({
      id: "ws-001",
      name: "hive-worker-task001",
      template_id: "tmpl-1",
      owner_name: "me",
      latest_build: { id: "b1", status: "starting", job: { status: "running", error: "" } },
    }),
    waitForBuild: vi.fn().mockResolvedValue({}),
    getWorkspaceAgentName: vi.fn().mockResolvedValue("hive-worker-task001.main"),
    stopWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
  } as unknown as CoderClient;
}

const fakeJobData: TaskJobData = {
  taskId: "task001-aaaa-bbbb-cccc-000000000001",
  repoUrl: "https://github.com/test/repo",
  prompt: "Fix the bug",
  branchName: "hive/task001/fix",
  params: {},
};

/** Blueprint result where the agent sets ctx.prUrl */
function makeBlueprintResult(prUrl?: string) {
  return {
    success: true,
    steps: [
      { name: "hydrate-context", status: "success", message: "ok", durationMs: 10 },
      { name: "scoped-rules", status: "success", message: "ok", durationMs: 5 },
      { name: "tool-selection", status: "success", message: "ok", durationMs: 3 },
      { name: "agent-execution", status: "success", message: "changes made", durationMs: 100 },
      { name: "lint", status: "success", message: "ok", durationMs: 10 },
      { name: "commit-push", status: "success", message: "pushed", durationMs: 20 },
      { name: "ci-feedback", status: "success", message: "CI passed", durationMs: 300 },
      { name: "pr-create", status: "success", message: prUrl ?? "", durationMs: 50 },
    ],
    totalDurationMs: 498,
    // Store so processor can read ctx.prUrl
    _prUrl: prUrl,
  };
}

/** Returns the processor function captured by the Worker mock. */
function getProcessor() {
  return (Worker as any).__lastProcessor as (job: { id: string; data: TaskJobData }) => Promise<void>;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("Task-queue council step (step 13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default env — verifier and council templates both set
    process.env.CODER_VERIFIER_TEMPLATE_ID = "tmpl-verifier";
    process.env.CODER_COUNCIL_TEMPLATE_ID = "tmpl-council";

    // Default db: councilSize=3, no-op task update
    mockTaskFindUnique.mockResolvedValue({ councilSize: 3 });
    mockTaskUpdate.mockResolvedValue({});

    // Default FlowProducer: returns a flow with a job that resolves
    mockFlowAdd.mockResolvedValue({
      job: {
        waitUntilFinished: mockWaitUntilFinished,
      },
    });
    mockWaitUntilFinished.mockResolvedValue({ outcome: "complete" });
    mockQueueEventsClose.mockResolvedValue(undefined);

    // Default: verifier blueprint also returns success (no prUrl) so it doesn't
    // interfere; overridden per test when needed
    let callCount = 0;
    mockRunBlueprint.mockImplementation(async (_steps: any[], ctx: any) => {
      callCount++;
      if (callCount === 1) {
        // Worker blueprint — sets prUrl so council can fire
        ctx.prUrl = "https://github.com/test/repo/pull/1";
        return makeBlueprintResult(ctx.prUrl);
      }
      // Verifier blueprint
      ctx.verificationReport = JSON.stringify({
        strategy: "test-suite",
        outcome: "pass",
        logs: "ok",
        durationMs: 100,
        timestamp: new Date().toISOString(),
      });
      return {
        success: true,
        steps: [{ name: "verify-detect", status: "success", message: "ok", durationMs: 10 }],
        totalDurationMs: 10,
      };
    });
  });

  afterEach(() => {
    delete process.env.CODER_COUNCIL_TEMPLATE_ID;
  });

  // ── Happy path ────────────────────────────────────────────────────

  it("fires FlowProducer.add() with 1 parent + N children when prUrl and councilSize > 0", async () => {
    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await processor({ id: "job-1", data: fakeJobData });

    expect(mockFlowAdd).toHaveBeenCalledOnce();
    const flowCall = mockFlowAdd.mock.calls[0][0];

    // Parent (aggregator) shape
    expect(flowCall).toMatchObject({
      name: expect.stringContaining("aggregator"),
      queueName: "council-aggregator",
      data: expect.objectContaining({
        taskId: fakeJobData.taskId,
        councilSize: 3,
        prUrl: "https://github.com/test/repo/pull/1",
      }),
    });

    // Children array: 3 reviewers
    expect(flowCall.children).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(flowCall.children[i]).toMatchObject({
        queueName: "council-reviewer",
        data: expect.objectContaining({
          taskId: fakeJobData.taskId,
          reviewerIndex: i,
          prUrl: "https://github.com/test/repo/pull/1",
          repoUrl: fakeJobData.repoUrl,
          branchName: fakeJobData.branchName,
        }),
        opts: expect.objectContaining({ failParentOnFailure: false }),
      });
    }
  });

  it("creates a QueueEvents and closes it after waiting", async () => {
    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await processor({ id: "job-2", data: fakeJobData });

    expect(QueueEvents).toHaveBeenCalledWith(
      "council-aggregator",
      expect.objectContaining({ connection: expect.anything() }),
    );
    expect(mockQueueEventsClose).toHaveBeenCalledOnce();
  });

  // ── No-op guards ──────────────────────────────────────────────────

  it("is a no-op when prUrl is null (blueprint did not create a PR)", async () => {
    // Override: worker blueprint does NOT set prUrl
    mockRunBlueprint.mockImplementation(async (_steps: any[], _ctx: any) => ({
      success: true,
      steps: [{ name: "agent-execution", status: "success", message: "no changes", durationMs: 10 }],
      totalDurationMs: 10,
    }));

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await processor({ id: "job-3", data: fakeJobData });

    expect(mockFlowAdd).not.toHaveBeenCalled();
  });

  it("is a no-op when CODER_COUNCIL_TEMPLATE_ID is not set", async () => {
    delete process.env.CODER_COUNCIL_TEMPLATE_ID;

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await processor({ id: "job-4", data: fakeJobData });

    expect(mockFlowAdd).not.toHaveBeenCalled();
  });

  it("is a no-op when councilSize is 0", async () => {
    mockTaskFindUnique.mockResolvedValue({ councilSize: 0 });

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await processor({ id: "job-5", data: fakeJobData });

    expect(mockFlowAdd).not.toHaveBeenCalled();
  });

  it("is a no-op when councilSize is null", async () => {
    mockTaskFindUnique.mockResolvedValue({ councilSize: null });

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await processor({ id: "job-6", data: fakeJobData });

    expect(mockFlowAdd).not.toHaveBeenCalled();
  });

  // ── Failure tolerance (D015) ──────────────────────────────────────

  it("council FlowProducer.add() failure does not change task status — stays done", async () => {
    mockFlowAdd.mockRejectedValue(new Error("Redis connection refused"));

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    // Should not throw
    await expect(processor({ id: "job-7", data: fakeJobData })).resolves.not.toThrow();

    // Task must not have been set to 'failed' after the council block
    const statusCalls = mockTaskUpdate.mock.calls.map((c) => c[0].data?.status).filter(Boolean);
    expect(statusCalls).not.toContain("failed");
    // The last status update should be "done"
    const doneCall = mockTaskUpdate.mock.calls.find((c) => c[0].data?.status === "done");
    expect(doneCall).toBeDefined();
  });

  it("council waitUntilFinished() rejection does not change task status", async () => {
    mockWaitUntilFinished.mockRejectedValue(new Error("Timeout waiting for aggregator"));

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await expect(processor({ id: "job-8", data: fakeJobData })).resolves.not.toThrow();

    const statusCalls = mockTaskUpdate.mock.calls.map((c) => c[0].data?.status).filter(Boolean);
    expect(statusCalls).not.toContain("failed");
  });

  it("council db.task.findUnique() failure does not affect task status", async () => {
    mockTaskFindUnique.mockRejectedValue(new Error("DB connection lost"));

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await expect(processor({ id: "job-9", data: fakeJobData })).resolves.not.toThrow();

    expect(mockFlowAdd).not.toHaveBeenCalled();
    const statusCalls = mockTaskUpdate.mock.calls.map((c) => c[0].data?.status).filter(Boolean);
    expect(statusCalls).not.toContain("failed");
  });

  it("QueueEvents.close() is called even when waitUntilFinished rejects", async () => {
    mockWaitUntilFinished.mockRejectedValue(new Error("Timeout"));

    const client = makeMockCoderClient();
    createTaskWorker(client);
    const processor = getProcessor();

    await processor({ id: "job-10", data: fakeJobData });

    expect(mockQueueEventsClose).toHaveBeenCalledOnce();
  });
});
