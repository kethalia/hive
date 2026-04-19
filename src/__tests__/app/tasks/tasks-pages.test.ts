import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { createTaskSchema } from "@/lib/actions/tasks";

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
      userId: "user-001",
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
      userId: "user-001",
    });

    expect(task.attachments).toBeNull();

    // Verify Prisma create was NOT passed attachments (undefined omitted)
    const createCall = mockTaskCreate.mock.calls[0][0];
    expect(createCall.data.attachments).toBeUndefined();
  });
});

describe("createTask councilSize handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskCreate.mockResolvedValue({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      prompt: "Fix bug",
      repoUrl: "https://github.com/test/repo",
      status: "queued",
      branch: "hive/aaaaaaaa/fix-bug",
      attachments: null,
      councilSize: 3,
      prUrl: null,
      errorMessage: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });
  });

  it("passes councilSize to prisma create", async () => {
    await createTask({
      prompt: "Fix bug",
      repoUrl: "https://github.com/test/repo",
      userId: "user-001",
      councilSize: 5,
    });

    expect(mockTaskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        councilSize: 5,
      }),
    });
  });

  it("defaults councilSize to 3 when not provided", async () => {
    await createTask({
      prompt: "Fix bug",
      repoUrl: "https://github.com/test/repo",
      userId: "user-001",
    });

    expect(mockTaskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        councilSize: 3,
      }),
    });
  });
});

describe("createTaskSchema councilSize validation", () => {
  const baseInput = {
    prompt: "Fix bug",
    repoUrl: "https://github.com/test/repo",
  };

  it("rejects councilSize below 1", () => {
    const result = createTaskSchema.safeParse({ ...baseInput, councilSize: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects councilSize above 7", () => {
    const result = createTaskSchema.safeParse({ ...baseInput, councilSize: 8 });
    expect(result.success).toBe(false);
  });

  it("accepts councilSize within bounds", () => {
    const result = createTaskSchema.safeParse({ ...baseInput, councilSize: 5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.councilSize).toBe(5);
    }
  });

  it("defaults councilSize to 3 when not supplied", () => {
    const result = createTaskSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.councilSize).toBe(3);
    }
  });
});
