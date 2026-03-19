import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (same pattern as __tests__/lib/api/tasks.test.ts) ──────

vi.mock("uuid", () => ({
  v4: vi.fn(() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
}));

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
const mockTaskLogCreate = vi.fn().mockResolvedValue({ id: "log-1" });

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    task: {
      create: mockTaskCreate,
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    taskLog: {
      create: mockTaskLogCreate,
    },
  })),
}));

// ── Import under test ────────────────────────────────────────────

import { createTask } from "@/lib/api/tasks";

// ── Tests ─────────────────────────────────────────────────────────

describe("createTask attachments handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores attachments when provided", async () => {
    const attachments = [
      { name: "spec.md", data: "YmFzZTY0", type: "text/markdown" },
    ];

    mockTaskCreate.mockResolvedValue({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      prompt: "Fix bug",
      repoUrl: "https://github.com/test/repo",
      status: "queued",
      branch: "hive/aaaaaaaa/fix-bug",
      attachments,
      prUrl: null,
      errorMessage: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });

    const task = await createTask({
      prompt: "Fix bug",
      repoUrl: "https://github.com/test/repo",
      attachments,
    });

    expect(task.attachments).toEqual(attachments);

    // Verify Prisma create was called with attachments
    expect(mockTaskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attachments,
      }),
    });
  });

  it("stores null when attachments not provided", async () => {
    mockTaskCreate.mockResolvedValue({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      prompt: "Fix bug",
      repoUrl: "https://github.com/test/repo",
      status: "queued",
      branch: "hive/aaaaaaaa/fix-bug",
      attachments: null,
      prUrl: null,
      errorMessage: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });

    const task = await createTask({
      prompt: "Fix bug",
      repoUrl: "https://github.com/test/repo",
    });

    expect(task.attachments).toBeNull();

    // Verify Prisma create was NOT passed attachments (undefined omitted)
    const createCall = mockTaskCreate.mock.calls[0][0];
    expect(createCall.data.attachments).toBeUndefined();
  });
});
