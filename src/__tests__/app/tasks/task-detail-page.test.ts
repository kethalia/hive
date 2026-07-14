import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  getTask: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));

vi.mock("@/lib/api/tasks", () => ({
  getTask: mocks.getTask,
}));

vi.mock("@/lib/auth/session", () => ({
  getRequestSession: mocks.getRequestSession,
}));

vi.mock("@/app/(dashboard)/tasks/[id]/task-detail", () => ({
  TaskDetail: vi.fn(),
}));

import TaskDetailPage from "@/app/(dashboard)/tasks/[id]/page";

describe("TaskDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("routes malformed task IDs to the recovery page without querying Postgres", async () => {
    await expect(
      TaskDetailPage({ params: Promise.resolve({ id: "not-a-real-task" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getTask).not.toHaveBeenCalled();
  });

  it("routes a missing valid task ID to the recovery page", async () => {
    const taskId = "11111111-2222-3333-4444-555555555555";
    mocks.getTask.mockResolvedValue(null);

    await expect(TaskDetailPage({ params: Promise.resolve({ id: taskId }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );

    expect(mocks.getTask).toHaveBeenCalledWith(taskId, "user-1");
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });
});
