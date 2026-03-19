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

// Mock db — the key part: we need to track individual calls
const mockReturning = vi.fn();
const mockInsertValues = vi.fn().mockReturnValue({
  returning: mockReturning,
});
const mockInsert = vi.fn().mockReturnValue({
  values: mockInsertValues,
});

const mockUpdateSet = vi.fn();
const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
mockUpdateSet.mockReturnValue({ where: mockUpdateSetWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

const mockSelectFrom = vi.fn();
const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

const mockFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
    query: {
      tasks: {
        findFirst: mockFindFirst,
      },
    },
  })),
}));

vi.mock("@/lib/db/schema", () => ({
  tasks: { id: "id" },
  taskLogs: {},
  workspaces: {},
}));

// ── Imports under test ────────────────────────────────────────────

import { createTask, getTask, listTasks } from "@/lib/api/tasks";

// ── Tests ─────────────────────────────────────────────────────────

describe("Task API functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock return values
    mockInsertValues.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([
      {
        id: "11111111-2222-3333-4444-555555555555",
        prompt: "Test prompt",
        repoUrl: "https://github.com/test/repo",
        status: "queued",
        branch: "hive/11111111/test-prompt",
        prUrl: null,
        errorMessage: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ]);
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

      // Verify DB insert called
      expect(mockInsert).toHaveBeenCalled();

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

      // Check the insert was called with a branch matching the pattern
      const insertCall = mockInsert.mock.calls[0];
      expect(insertCall).toBeDefined();

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
      };

      mockFindFirst.mockResolvedValue(mockTask);

      // Mock the select chain for workspaces and logs
      const mockOrderBy = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: "log-1", message: "Created" }]),
      });
      const mockWhere = vi.fn()
        .mockReturnValueOnce(Promise.resolve([{ id: "ws-1", coderWorkspaceId: "cws-1" }]))
        .mockReturnValueOnce({ orderBy: mockOrderBy });
      mockSelectFrom.mockReturnValue({ where: mockWhere });

      const result = await getTask("abc-123");

      expect(result).toMatchObject({
        id: "abc-123",
        workspaces: [{ id: "ws-1" }],
        logs: [{ id: "log-1" }],
      });
    });

    it("returns null when task not found", async () => {
      mockFindFirst.mockResolvedValue(undefined);

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

      const mockLimit = vi.fn().mockResolvedValue(mockTasks);
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
      mockSelectFrom.mockReturnValue({ orderBy: mockOrderBy });

      const result = await listTasks();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("task-2");
      expect(mockSelect).toHaveBeenCalled();
    });
  });
});
