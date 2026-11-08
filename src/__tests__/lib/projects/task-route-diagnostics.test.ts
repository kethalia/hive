import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ start: vi.fn(), retry: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/codex-session/route.server", () => ({
  authorizeSessionOwner: mock.auth,
  boundedSessionJson: async () => ({}),
  sessionError: (code: string, status: number) => Response.json({ error: code }, { status }),
  sessionResponseHeaders: {},
}));
vi.mock("@/lib/projects/task.server", () => ({
  ProjectTaskConflict: class extends Error {},
  startProjectTask: mock.start,
  readProjectTask: vi.fn(),
  retryProjectTask: mock.retry,
}));

import { projectTaskRoute } from "@/lib/projects/task-route.server";

beforeEach(() => {
  mock.auth.mockResolvedValue({ user: { id: "owner" } });
  mock.retry.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("logs only the fixed stage, category and response status when start fails", async () => {
  vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "true");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.start.mockImplementation(async (_user, _project, _body, stage) => {
    stage("policy_enrollment");
    throw new Error("private token and arbitrary request contents");
  });
  const response = await projectTaskRoute("start")(
    new Request("https://fixture.invalid/api/projects/id/tasks/start", { method: "POST" }),
    { params: Promise.resolve({ projectId: "id" }) },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "task_unavailable" });
  expect(log).toHaveBeenCalledExactlyOnceWith("project_task_start_failed", {
    stage: "policy_enrollment",
    category: "internal",
    statusCode: 503,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private token");
});

it("returns an authenticated recovery stage without exposing the underlying failure", async () => {
  vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "true");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.retry.mockImplementation(async (_user, _project, _body, stage) => {
    stage("recovery_continuity");
    throw new Error("private token and arbitrary request contents");
  });
  const response = await projectTaskRoute("retry")(
    new Request("https://fixture.invalid/api/projects/id/tasks/retry", { method: "POST" }),
    { params: Promise.resolve({ projectId: "id" }) },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "task_unavailable",
    failureStage: "recovery_continuity",
  });
  expect(log).toHaveBeenCalledExactlyOnceWith("project_task_retry_failed", {
    stage: "recovery_continuity",
    category: "internal",
    statusCode: 503,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private token");
});

it("does not run recovery or expose its stages before owner authorization", async () => {
  vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "true");
  mock.auth.mockResolvedValue(Response.json({ error: "not_authenticated" }, { status: 401 }));
  const response = await projectTaskRoute("retry")(
    new Request("https://fixture.invalid/api/projects/id/tasks/retry", { method: "POST" }),
    { params: Promise.resolve({ projectId: "id" }) },
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "not_authenticated" });
  expect(mock.retry).not.toHaveBeenCalled();
});
