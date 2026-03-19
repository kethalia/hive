import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────

// Mock uuid
vi.mock("uuid", () => ({
  v4: vi.fn(() => "11111111-2222-3333-4444-555555555555"),
}));

// Mock IORedis
vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

// Mock the Redis connection module directly
vi.mock("@/lib/queue/connection", () => ({
  getRedisConnection: vi.fn(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

// Mock BullMQ Queue
const mockQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: vi.fn(),
  })),
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// Mock Prisma client
const mockTaskCreate = vi.fn();
const mockTaskFindUnique = vi.fn();
const mockTaskFindMany = vi.fn();
const mockTaskUpdate = vi.fn();
const mockTaskLogCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    task: {
      create: mockTaskCreate,
      findUnique: mockTaskFindUnique,
      findMany: mockTaskFindMany,
      update: mockTaskUpdate,
    },
    taskLog: {
      create: mockTaskLogCreate,
    },
  })),
}));

// ── Imports under test ────────────────────────────────────────────

import { createTask, getTask, listTasks } from "@/lib/api/tasks";

// ── Tests ─────────────────────────────────────────────────────────

describe("Task API functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default return for task creation
    mockTaskCreate.mockResolvedValue({
      id: "11111111-2222-3333-4444-555555555555",
      prompt: "Test prompt",
      repoUrl: "https://github.com/test/repo",
      status: "queued",
      branch: "hive/11111111/test-prompt",
      prUrl: null,
      errorMessage: null,
      attachments: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });
    mockTaskLogCreate.mockResolvedValue({ id: "log-1" });
  });

  describe("createTask()", () => {
    it("persists task to DB and enqueues BullMQ job", async () => {
      const task = await createTask({
        prompt: "Test prompt",
        repoUrl: "https://github.com/test/repo",
      });

      // Verify task shape
      expect(task).toMatchObject({
        id: "11111111-2222-3333-4444-555555555555",
        prompt: "Test prompt",
        repoUrl: "https://github.com/test/repo",
        status: "queued",
      });

      // Verify Prisma create called
      expect(mockTaskCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: "11111111-2222-3333-4444-555555555555",
          prompt: "Test prompt",
          repoUrl: "https://github.com/test/repo",
          status: "queued",
        }),
      });

      // Verify BullMQ job enqueued
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "dispatch",
        expect.objectContaining({
          taskId: "11111111-2222-3333-4444-555555555555",
          repoUrl: "https://github.com/test/repo",
          prompt: "Test prompt",
        }),
        { jobId: "11111111-2222-3333-4444-555555555555" }
      );
    });

    it("generates branch name from task ID and slugified prompt", async () => {
      await createTask({
        prompt: "Fix authentication bug in login",
        repoUrl: "https://github.com/test/repo",
      });

      // Check Prisma create was called with branch matching the pattern
      expect(mockTaskCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          branch: expect.stringMatching(/^hive\/11111111\//),
        }),
      });

      // Check BullMQ job has the branch name
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "dispatch",
        expect.objectContaining({
          branchName: expect.stringMatching(/^hive\/11111111\//),
        }),
        expect.any(Object)
      );
    });
  });

  describe("getTask()", () => {
    it("returns task with workspaces and logs when found", async () => {
      const mockTask = {
        id: "abc-123",
        prompt: "Test",
        repoUrl: "https://github.com/test/repo",
        status: "queued",
        workspaces: [{ id: "ws-1", coderWorkspaceId: "cws-1" }],
        logs: [{ id: "log-1", message: "Created" }],
      };

      mockTaskFindUnique.mockResolvedValue(mockTask);

      const result = await getTask("abc-123");

      expect(result).toMatchObject({
        id: "abc-123",
        workspaces: [{ id: "ws-1" }],
        logs: [{ id: "log-1" }],
      });

      expect(mockTaskFindUnique).toHaveBeenCalledWith({
        where: { id: "abc-123" },
        include: {
          workspaces: true,
          logs: {
            orderBy: { createdAt: "desc" },
            take: 50,
          },
        },
      });
    });

    it("returns null when task not found", async () => {
      mockTaskFindUnique.mockResolvedValue(null);

      const result = await getTask("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("listTasks()", () => {
    it("returns tasks ordered by createdAt desc", async () => {
      const mockTasks = [
        { id: "task-2", createdAt: new Date("2026-01-02") },
        { id: "task-1", createdAt: new Date("2026-01-01") },
      ];

      mockTaskFindMany.mockResolvedValue(mockTasks);

      const result = await listTasks();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("task-2");
      expect(mockTaskFindMany).toHaveBeenCalledWith({
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    });
  });
});
