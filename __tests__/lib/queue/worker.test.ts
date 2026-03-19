import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────

// Mock IORedis — must be before imports that trigger getRedisConnection
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
const mockTaskLogCreate = vi.fn().mockResolvedValue({});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    task: {
      update: mockTaskUpdate,
    },
    workspace: {
      create: mockWorkspaceCreate,
    },
    taskLog: {
      create: mockTaskLogCreate,
    },
  })),
}));

// ── Imports under test ────────────────────────────────────────────

import { getTaskQueue, createTaskWorker, type TaskJobData } from "@/lib/queue/task-queue";
import type { CoderClient } from "@/lib/coder/client";

// ── Tests ─────────────────────────────────────────────────────────

describe("BullMQ task-dispatch queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getTaskQueue()", () => {
    it("returns a Queue instance that can add jobs", async () => {
      const queue = getTaskQueue();
      const jobData: TaskJobData = {
        taskId: "abc-123",
        repoUrl: "https://github.com/test/repo",
        prompt: "Fix the bug",
        branchName: "hive/abc-123/fix-the-bug",
        params: {},
      };

      await queue.add("dispatch", jobData, { jobId: "abc-123" });

      expect(mockQueueAdd).toHaveBeenCalledWith("dispatch", jobData, {
        jobId: "abc-123",
      });
    });
  });

  describe("createTaskWorker()", () => {
    const mockCoderClient = {
      createWorkspace: vi.fn().mockResolvedValue({
        id: "ws-001",
        name: "hive-worker-abc12345",
        template_id: "tmpl-1",
        owner_name: "me",
        latest_build: { id: "build-1", status: "starting", job: { status: "running", error: "" } },
      }),
    } as unknown as CoderClient;

    it("creates a Worker with configurable concurrency", () => {
      createTaskWorker(mockCoderClient);

      // Worker constructor called with queue name and options
      expect(Worker).toHaveBeenCalledWith(
        "task-dispatch",
        expect.any(Function),
        expect.objectContaining({
          concurrency: 5,
        })
      );
    });

    it("processes job: updates status, creates workspace, records workspace, logs", async () => {
      createTaskWorker(mockCoderClient);

      const processor = (Worker as any).__lastProcessor;
      expect(processor).toBeDefined();

      const fakeJob = {
        id: "job-1",
        data: {
          taskId: "abc12345-6789-0000-0000-000000000000",
          repoUrl: "https://github.com/test/repo",
          prompt: "Fix the bug",
          branchName: "hive/abc12345/fix-the-bug",
          params: {},
        } satisfies TaskJobData,
      };

      await processor(fakeJob);

      // Verify task status updated to 'running'
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: "abc12345-6789-0000-0000-000000000000" },
        data: { status: "running" },
      });

      // Verify workspace created via Coder client
      expect(mockCoderClient.createWorkspace).toHaveBeenCalledWith(
        expect.any(String), // templateId from env
        "hive-worker-abc12345",
        expect.objectContaining({
          task_id: "abc12345-6789-0000-0000-000000000000",
          task_prompt: "Fix the bug",
          repo_url: "https://github.com/test/repo",
          branch_name: "hive/abc12345/fix-the-bug",
        })
      );

      // Verify workspace record created
      expect(mockWorkspaceCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: "abc12345-6789-0000-0000-000000000000",
          coderWorkspaceId: "ws-001",
          templateType: "worker",
          status: "starting",
        }),
      });

      // Verify taskLog created
      expect(mockTaskLogCreate).toHaveBeenCalled();
    });

    it("handles errors: sets task to failed and logs error", async () => {
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

      // Verify task status set to 'running' first, then 'failed' (2 update calls)
      expect(mockTaskUpdate).toHaveBeenCalledTimes(2);
      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: "fail0000-0000-0000-0000-000000000000" },
        data: { status: "failed", errorMessage: "Coder API down" },
      });

      // Verify error logged to taskLogs
      expect(mockTaskLogCreate).toHaveBeenCalled();
    });
  });
});
