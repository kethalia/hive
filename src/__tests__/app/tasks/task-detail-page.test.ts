import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  getTask: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
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

import TaskNotFound from "@/app/(dashboard)/tasks/[id]/not-found";
import TaskDetailPage from "@/app/(dashboard)/tasks/[id]/page";

describe("TaskDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("routes malformed task IDs to the recovery page without querying Postgres", async () => {
    const result = await TaskDetailPage({
      params: Promise.resolve({ id: "not-a-real-task" }),
    });

    expect(result.type).toBe(TaskNotFound);
    expect(mocks.getTask).not.toHaveBeenCalled();
  });

  it("routes a missing valid task ID to the recovery page", async () => {
    const taskId = "11111111-2222-3333-4444-555555555555";
    mocks.getTask.mockResolvedValue(null);

    const result = await TaskDetailPage({ params: Promise.resolve({ id: taskId }) });

    expect(mocks.getTask).toHaveBeenCalledWith(taskId, "user-1");
    expect(result.type).toBe(TaskNotFound);
  });
});
