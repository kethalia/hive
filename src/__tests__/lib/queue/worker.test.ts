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

// Mock BullMQ Queue and Worker
const mockQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });
const mockWorkerOn = vi.fn();

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: vi.fn(),
  })),
  Worker: vi.fn().mockImplementation((name: string, processor: Function, opts: unknown) => {
    // Store the processor so we can invoke it in tests
    (Worker as any).__lastProcessor = processor;
    (Worker as any).__lastOpts = opts;
    return {
      on: mockWorkerOn,
      close: vi.fn(),
    };
  }),
}));
// Capture the Worker import for accessing __lastProcessor
import { Worker } from "bullmq";

// Mock Prisma client
const mockTaskUpdate = vi.fn().mockResolvedValue({});
const mockWorkspaceCreate = vi.fn().mockResolvedValue({});
const mockWorkspaceUpdate = vi.fn().mockResolvedValue({});
const mockTaskLogCreate = vi.fn().mockResolvedValue({});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    task: {
      update: mockTaskUpdate,
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

// Mock runBlueprint
const mockRunBlueprint = vi.fn();
vi.mock("@/lib/blueprint/runner", () => ({
  runBlueprint: (...args: unknown[]) => mockRunBlueprint(...args),
}));
// Mock step factories (they just need to return objects)
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

// Mock cleanupWorkspace
const mockCleanupWorkspace = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/workspace/cleanup", () => ({
  cleanupWorkspace: (...args: unknown[]) => mockCleanupWorkspace(...args),
}));

// Mock verifier blueprint
const mockCreateVerifierBlueprint = vi.fn(() => [
  { name: "verify-clone", execute: vi.fn() },
  { name: "verify-detect", execute: vi.fn() },
  { name: "verify-execute", execute: vi.fn() },
  { name: "verify-report", execute: vi.fn() },
]);
vi.mock("@/lib/blueprint/verifier", () => ({
  createVerifierBlueprint: (...args: unknown[]) => mockCreateVerifierBlueprint(...args),
}));
// ── Imports under test ────────────────────────────────────────────

import { getTaskQueue, createTaskWorker, type TaskJobData } from "@/lib/queue/task-queue";
import type { CoderClient } from "@/lib/coder/client";
import { createCIStep } from "@/lib/blueprint/steps/ci";

// ── Helpers ───────────────────────────────────────────────────────

function makeMockCoderClient(overrides?: Partial<Record<string, any>>) {
  const createWorkspaceMock = vi.fn().mockResolvedValue({
    id: "ws-001",
    name: "hive-worker-abc12345",
    template_id: "tmpl-1",
    owner_name: "me",
    latest_build: { id: "build-1", status: "starting", job: { status: "running", error: "" } },
  });

  return {
    createWorkspace: createWorkspaceMock,
    waitForBuild: vi.fn().mockResolvedValue({
      id: "ws-001",
      name: "hive-worker-abc12345",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded", error: "" } },
    }),
    getWorkspaceAgentName: vi.fn().mockResolvedValue("hive-worker-abc12345.main"),
    stopWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CoderClient;
}

const fakeJobData: TaskJobData = {
  taskId: "abc12345-6789-0000-0000-000000000000",
  repoUrl: "https://github.com/test/repo",
  prompt: "Fix the bug",
  branchName: "hive/abc12345/fix-the-bug",
  params: {},
};

/** Build the 8-step success result the worker expects. */
function makeSuccessResult(overrides?: { prUrl?: string }) {
  return {
    success: true,
    steps: [
      { name: "hydrate-context", status: "success", message: "ok", durationMs: 100 },
      { name: "scoped-rules", status: "success", message: "ok", durationMs: 50 },
      { name: "tool-selection", status: "success", message: "ok", durationMs: 30 },
      { name: "agent-execution", status: "success", message: "Changes made", durationMs: 5000 },
      { name: "lint", status: "success", message: "Lint passed", durationMs: 200 },
      { name: "commit-push", status: "success", message: "Pushed abc1234", durationMs: 300 },
      { name: "ci-feedback", status: "success", message: "CI passed on round 1", durationMs: 15000 },
      { name: "pr-create", status: "success", message: "https://github.com/test/repo/pull/42", durationMs: 400 },
    ],
    totalDurationMs: 21080,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("BullMQ task-dispatch queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Set verifier template ID so verifier path is exercised
    process.env.CODER_VERIFIER_TEMPLATE_ID = "tmpl-verifier";
  });

  describe("getTaskQueue()", () => {
    it("returns a Queue instance that can add jobs", async () => {
      const queue = getTaskQueue();

      await queue.add("dispatch", fakeJobData, { jobId: "abc-123" });

      expect(mockQueueAdd).toHaveBeenCalledWith("dispatch", fakeJobData, {
        jobId: "abc-123",
      });
    });
  });

  describe("createTaskWorker()", () => {
    it("creates a Worker with 90-minute lock duration", () => {
      const client = makeMockCoderClient();
      createTaskWorker(client);

      expect(Worker).toHaveBeenCalledWith(
        "task-dispatch",
        expect.any(Function),
        expect.objectContaining({
          concurrency: 5,
          lockDuration: 90 * 60 * 1_000,
        }),
      );
    });

    it("full success flow: 8-step pipeline with prUrl and branch persisted", async () => {
      // Set up createWorkspace to return different IDs for worker vs verifier
      const createWsMock = vi.fn()
        .mockResolvedValueOnce({
          id: "ws-001", name: "hive-worker-abc12345",
          template_id: "tmpl-1", owner_name: "me",
          latest_build: { id: "build-1", status: "starting", job: { status: "running", error: "" } },
        })
        .mockResolvedValueOnce({
          id: "ws-verifier-001", name: "hive-verifier-abc12345",
          template_id: "tmpl-v", owner_name: "me",
          latest_build: { id: "build-v1", status: "starting", job: { status: "running", error: "" } },
        });
      const client = makeMockCoderClient({ createWorkspace: createWsMock });

      // Worker blueprint sets prUrl; verifier blueprint sets verificationReport
      let runBlueprintCallCount = 0;
      mockRunBlueprint.mockImplementation(async (steps: any[], ctx: any) => {
        runBlueprintCallCount++;
        if (runBlueprintCallCount === 1) {
          // Worker blueprint
          ctx.prUrl = "https://github.com/test/repo/pull/42";
          return makeSuccessResult();
        }
        // Verifier blueprint
        ctx.verificationReport = JSON.stringify({
          strategy: "test-suite",
          outcome: "pass",
          logs: "All tests passed",
          durationMs: 5000,
          timestamp: "2025-01-01T00:00:00.000Z",
        });
        return {
          success: true,
          steps: [
            { name: "verify-clone", status: "success", message: "ok", durationMs: 100 },
            { name: "verify-detect", status: "success", message: "ok", durationMs: 50 },
            { name: "verify-execute", status: "success", message: "ok", durationMs: 5000 },
            { name: "verify-report", status: "success", message: "ok", durationMs: 10 },
          ],
          totalDurationMs: 5160,
        };
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      const fakeJob = { id: "job-1", data: fakeJobData };

      await processor(fakeJob);

      // 1. Task set to running
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: { status: "running" },
      });

      // 2. Workspace created via Coder
      expect(client.createWorkspace).toHaveBeenCalledWith(
        expect.any(String),
        "hive-worker-abc12345",
        expect.objectContaining({
          task_id: fakeJobData.taskId,
          repo_url: fakeJobData.repoUrl,
        }),
      );

      // 3. Workspace recorded in DB
      expect(mockWorkspaceCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: fakeJobData.taskId,
          coderWorkspaceId: "ws-001",
          status: "starting",
        }),
      });

      // 4. waitForBuild called with 5-min timeout
      expect(client.waitForBuild).toHaveBeenCalledWith("ws-001", "running", {
        timeoutMs: 300_000,
      });

      // 5. Workspace status updated to running
      expect(mockWorkspaceUpdate).toHaveBeenCalledWith({
        where: { coderWorkspaceId: "ws-001" },
        data: { status: "running" },
      });

      // 6. Agent name resolved
      expect(client.getWorkspaceAgentName).toHaveBeenCalledWith("ws-001");

      // 7. Blueprint ran with 8 steps in correct order
      expect(mockRunBlueprint).toHaveBeenCalledWith(
        [
          expect.objectContaining({ name: "hydrate-context" }),
          expect.objectContaining({ name: "scoped-rules" }),
          expect.objectContaining({ name: "tool-selection" }),
          expect.objectContaining({ name: "agent-execution" }),
          expect.objectContaining({ name: "lint" }),
          expect.objectContaining({ name: "commit-push" }),
          expect.objectContaining({ name: "ci-feedback" }),
          expect.objectContaining({ name: "pr-create" }),
        ],
        expect.objectContaining({
          taskId: fakeJobData.taskId,
          workspaceName: "hive-worker-abc12345.main",
          repoUrl: fakeJobData.repoUrl,
          prompt: fakeJobData.prompt,
        }),
      );

      // 8. Task set to verifying first, then done after verifier
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "verifying",
          prUrl: "https://github.com/test/repo/pull/42",
          branch: fakeJobData.branchName,
        },
      });

      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "done",
          verificationReport: expect.objectContaining({
            strategy: "test-suite",
            outcome: "pass",
          }),
        },
      });

      // 9. Verifier blueprint was invoked with 4 steps
      expect(mockRunBlueprint).toHaveBeenCalledTimes(2);
      expect(mockRunBlueprint).toHaveBeenCalledWith(
        [
          expect.objectContaining({ name: "verify-clone" }),
          expect.objectContaining({ name: "verify-detect" }),
          expect.objectContaining({ name: "verify-execute" }),
          expect.objectContaining({ name: "verify-report" }),
        ],
        expect.objectContaining({
          taskId: fakeJobData.taskId,
          branchName: fakeJobData.branchName,
        }),
      );

      // 10. Step outcomes logged (8 worker steps)
      const stepLogCalls = mockTaskLogCreate.mock.calls.filter(
        (c: any) => c[0]?.data?.message?.startsWith('Blueprint step'),
      );
      expect(stepLogCalls.length).toBe(8);
    });

    it("CI step receives injected dependencies", async () => {
      const client = makeMockCoderClient();
      // No prUrl → no verifier triggered
      mockRunBlueprint.mockResolvedValue(makeSuccessResult());

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-1", data: fakeJobData });

      // createCIStep should have been called with the factory deps
      expect(createCIStep).toHaveBeenCalledWith({
        createAgentStep: expect.any(Function),
        createLintStep: expect.any(Function),
        createCommitPushStep: expect.any(Function),
      });
    });

    it("cleanup is called after successful blueprint", async () => {
      const client = makeMockCoderClient();
      // No prUrl → no verifier triggered, only worker cleanup
      mockRunBlueprint.mockResolvedValue(makeSuccessResult());

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-1", data: fakeJobData });

      expect(mockCleanupWorkspace).toHaveBeenCalledWith(
        client,
        "ws-001",
        expect.any(Number),
        expect.anything(),
      );
    });

    it("cleanup is called after failed blueprint", async () => {
      const client = makeMockCoderClient();
      mockRunBlueprint.mockResolvedValue({
        success: false,
        steps: [
          { name: "hydrate-context", status: "success", message: "ok", durationMs: 100 },
          { name: "scoped-rules", status: "success", message: "ok", durationMs: 50 },
          { name: "tool-selection", status: "success", message: "ok", durationMs: 30 },
          { name: "agent-execution", status: "failure", message: "Pi exited with code 1: rate limit", durationMs: 2000 },
          { name: "lint", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "commit-push", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "ci-feedback", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "pr-create", status: "skipped", message: "skipped", durationMs: 0 },
        ],
        totalDurationMs: 2180,
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-3", data: fakeJobData });

      // Task set to failed
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "failed",
          errorMessage: expect.stringContaining('agent-execution'),
        },
      });

      // Cleanup still called
      expect(mockCleanupWorkspace).toHaveBeenCalledWith(
        client,
        "ws-001",
        expect.any(Number),
        expect.anything(),
      );
    });

    it("cleanup is called even when an exception is thrown", async () => {
      const client = makeMockCoderClient();
      // Fail after workspace creation so coderWorkspaceId is set
      client.waitForBuild = vi.fn().mockRejectedValue(new Error("build timeout"));

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;

      await expect(
        processor({ id: "job-err", data: fakeJobData }),
      ).rejects.toThrow("build timeout");

      // Cleanup called with workspace ID from createWorkspace
      expect(mockCleanupWorkspace).toHaveBeenCalledWith(
        client,
        "ws-001",
        expect.any(Number),
        expect.anything(),
      );
    });

    it("blueprint failure → task status 'failed' with step name in errorMessage", async () => {
      const client = makeMockCoderClient();
      mockRunBlueprint.mockResolvedValue({
        success: false,
        steps: [
          { name: "hydrate-context", status: "success", message: "ok", durationMs: 100 },
          { name: "scoped-rules", status: "success", message: "ok", durationMs: 50 },
          { name: "tool-selection", status: "success", message: "ok", durationMs: 30 },
          { name: "agent-execution", status: "failure", message: "Pi exited with code 1: rate limit", durationMs: 2000 },
          { name: "lint", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "commit-push", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "ci-feedback", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "pr-create", status: "skipped", message: "skipped", durationMs: 0 },
        ],
        totalDurationMs: 2180,
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      const fakeJob = { id: "job-3", data: fakeJobData };

      await processor(fakeJob);

      // Task set to failed with descriptive error
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "failed",
          errorMessage: expect.stringContaining('agent-execution'),
        },
      });

      // Error message includes the step name and Pi's error
      const failCall = mockTaskUpdate.mock.calls.find(
        (c: any) => c[0]?.data?.status === "failed"
      );
      expect(failCall).toBeDefined();
      expect(failCall![0].data.errorMessage).toContain("rate limit");
    });

    it("workspace creation error → task status 'failed' and error re-thrown", async () => {
      const failingClient = {
        createWorkspace: vi.fn().mockRejectedValue(new Error("Coder API down")),
      } as unknown as CoderClient;

      createTaskWorker(failingClient);
      const processor = (Worker as any).__lastProcessor;

      const fakeJob = {
        id: "job-2",
        data: {
          taskId: "fail0000-0000-0000-0000-000000000000",
          repoUrl: "https://github.com/test/repo",
          prompt: "Will fail",
          branchName: "hive/fail0000/will-fail",
          params: {},
        } satisfies TaskJobData,
      };

      await expect(processor(fakeJob)).rejects.toThrow("Coder API down");

      // Task set to running first, then failed
      expect(mockTaskUpdate).toHaveBeenCalledTimes(2);
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: "fail0000-0000-0000-0000-000000000000" },
        data: { status: "failed", errorMessage: "Coder API down" },
      });

      // Error logged to taskLogs
      expect(mockTaskLogCreate).toHaveBeenCalled();

      // Cleanup NOT called (no workspace ID was captured)
      expect(mockCleanupWorkspace).not.toHaveBeenCalled();
    });

    // ── Verifier integration tests ────────────────────────────────

    it("worker failure (blueprint fails) → verifier NOT triggered → task failed", async () => {
      const client = makeMockCoderClient();
      mockRunBlueprint.mockResolvedValue({
        success: false,
        steps: [
          { name: "hydrate-context", status: "success", message: "ok", durationMs: 100 },
          { name: "scoped-rules", status: "success", message: "ok", durationMs: 50 },
          { name: "tool-selection", status: "success", message: "ok", durationMs: 30 },
          { name: "agent-execution", status: "failure", message: "Pi exited with code 1: rate limit", durationMs: 2000 },
          { name: "lint", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "commit-push", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "ci-feedback", status: "skipped", message: "skipped", durationMs: 0 },
          { name: "pr-create", status: "skipped", message: "skipped", durationMs: 0 },
        ],
        totalDurationMs: 2180,
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-no-verifier", data: fakeJobData });

      // Task set to failed
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "failed",
          errorMessage: expect.stringContaining("agent-execution"),
        },
      });

      // Verifier blueprint never called — only 1 runBlueprint call
      expect(mockRunBlueprint).toHaveBeenCalledTimes(1);
      expect(mockCreateVerifierBlueprint).not.toHaveBeenCalled();

      // Only worker workspace created
      expect(client.createWorkspace).toHaveBeenCalledTimes(1);
    });

    it("verifier failure → task still set to done with inconclusive report", async () => {
      const createWsMock = vi.fn()
        .mockResolvedValueOnce({
          id: "ws-001", name: "hive-worker-abc12345",
          template_id: "tmpl-1", owner_name: "me",
          latest_build: { id: "build-1", status: "starting", job: { status: "running", error: "" } },
        })
        .mockResolvedValueOnce({
          id: "ws-verifier-001", name: "hive-verifier-abc12345",
          template_id: "tmpl-v", owner_name: "me",
          latest_build: { id: "build-v1", status: "starting", job: { status: "running", error: "" } },
        });
      const client = makeMockCoderClient({ createWorkspace: createWsMock });

      let callCount = 0;
      mockRunBlueprint.mockImplementation(async (steps: any[], ctx: any) => {
        callCount++;
        if (callCount === 1) {
          ctx.prUrl = "https://github.com/test/repo/pull/42";
          return makeSuccessResult();
        }
        // Verifier blueprint throws
        throw new Error("Verifier workspace crashed");
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-verifier-fail", data: fakeJobData });

      // Task set to verifying first
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "verifying",
          prUrl: "https://github.com/test/repo/pull/42",
          branch: fakeJobData.branchName,
        },
      });

      // Then set to done with inconclusive report (NOT failed)
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "done",
          verificationReport: expect.objectContaining({
            strategy: "none",
            outcome: "inconclusive",
            logs: "Verifier workspace crashed",
          }),
        },
      });

      // Task NOT set to failed
      const failCall = mockTaskUpdate.mock.calls.find(
        (c: any) => c[0]?.data?.status === "failed"
      );
      expect(failCall).toBeUndefined();
    });

    it("both worker and verifier workspaces cleaned up in finally block", async () => {
      const createWsMock = vi.fn()
        .mockResolvedValueOnce({
          id: "ws-001", name: "hive-worker-abc12345",
          template_id: "tmpl-1", owner_name: "me",
          latest_build: { id: "build-1", status: "starting", job: { status: "running", error: "" } },
        })
        .mockResolvedValueOnce({
          id: "ws-verifier-001", name: "hive-verifier-abc12345",
          template_id: "tmpl-v", owner_name: "me",
          latest_build: { id: "build-v1", status: "starting", job: { status: "running", error: "" } },
        });
      const client = makeMockCoderClient({ createWorkspace: createWsMock });

      let callCount = 0;
      mockRunBlueprint.mockImplementation(async (steps: any[], ctx: any) => {
        callCount++;
        if (callCount === 1) {
          ctx.prUrl = "https://github.com/test/repo/pull/42";
          return makeSuccessResult();
        }
        ctx.verificationReport = JSON.stringify({
          strategy: "test-suite", outcome: "pass",
          logs: "ok", durationMs: 100, timestamp: "2025-01-01T00:00:00.000Z",
        });
        return { success: true, steps: [], totalDurationMs: 100 };
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-both-cleanup", data: fakeJobData });

      // Both workspaces cleaned up
      expect(mockCleanupWorkspace).toHaveBeenCalledTimes(2);
      expect(mockCleanupWorkspace).toHaveBeenCalledWith(
        client, "ws-001", expect.any(Number), expect.anything(),
      );
      expect(mockCleanupWorkspace).toHaveBeenCalledWith(
        client, "ws-verifier-001", expect.any(Number), expect.anything(),
      );
    });

    it("verifier blueprint returns success:false → task done with inconclusive report", async () => {
      const createWsMock = vi.fn()
        .mockResolvedValueOnce({
          id: "ws-001", name: "hive-worker-abc12345",
          template_id: "tmpl-1", owner_name: "me",
          latest_build: { id: "build-1", status: "starting", job: { status: "running", error: "" } },
        })
        .mockResolvedValueOnce({
          id: "ws-verifier-001", name: "hive-verifier-abc12345",
          template_id: "tmpl-v", owner_name: "me",
          latest_build: { id: "build-v1", status: "starting", job: { status: "running", error: "" } },
        });
      const client = makeMockCoderClient({ createWorkspace: createWsMock });

      let callCount = 0;
      mockRunBlueprint.mockImplementation(async (steps: any[], ctx: any) => {
        callCount++;
        if (callCount === 1) {
          ctx.prUrl = "https://github.com/test/repo/pull/42";
          return makeSuccessResult();
        }
        // Verifier blueprint returns failure (does NOT throw)
        return {
          success: false,
          steps: [
            { name: "verify-clone", status: "success", message: "ok", durationMs: 100 },
            { name: "verify-detect", status: "success", message: "ok", durationMs: 50 },
            { name: "verify-execute", status: "failure", message: "npm test failed", durationMs: 5000 },
            { name: "verify-report", status: "skipped", message: "skipped", durationMs: 0 },
          ],
          totalDurationMs: 5150,
        };
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-verifier-step-fail", data: fakeJobData });

      // Task should be done with inconclusive report (not failed)
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "done",
          verificationReport: expect.objectContaining({
            outcome: "inconclusive",
            logs: "Verifier blueprint reported step failure",
          }),
        },
      });

      // Task NOT set to failed
      const failCall = mockTaskUpdate.mock.calls.find(
        (c: any) => c[0]?.data?.status === "failed"
      );
      expect(failCall).toBeUndefined();
    });

    it("missing CODER_VERIFIER_TEMPLATE_ID → verification skipped with inconclusive report", async () => {
      // Unset the verifier template ID
      delete process.env.CODER_VERIFIER_TEMPLATE_ID;

      const client = makeMockCoderClient();

      let callCount = 0;
      mockRunBlueprint.mockImplementation(async (steps: any[], ctx: any) => {
        callCount++;
        ctx.prUrl = "https://github.com/test/repo/pull/42";
        return makeSuccessResult();
      });

      createTaskWorker(client);
      const processor = (Worker as any).__lastProcessor;
      await processor({ id: "job-no-template", data: fakeJobData });

      // Verifier should NOT be triggered
      expect(mockRunBlueprint).toHaveBeenCalledTimes(1);
      expect(mockCreateVerifierBlueprint).not.toHaveBeenCalled();

      // Task set to done with inconclusive report mentioning missing env var
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: fakeJobData.taskId },
        data: {
          status: "done",
          verificationReport: expect.objectContaining({
            outcome: "inconclusive",
            logs: expect.stringContaining("CODER_VERIFIER_TEMPLATE_ID"),
          }),
        },
      });

      // Only one workspace created (worker, not verifier)
      expect(client.createWorkspace).toHaveBeenCalledTimes(1);
    });
  });
});
