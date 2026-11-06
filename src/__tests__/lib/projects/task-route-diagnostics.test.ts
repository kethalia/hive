import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@/lib/codex-session/route.server", () => ({
  authorizeSessionOwner: async () => ({ user: { id: "owner" } }),
  boundedSessionJson: async () => ({}),
  sessionError: (code: string, status: number) => Response.json({ error: code }, { status }),
  sessionResponseHeaders: {},
}));
vi.mock("@/lib/projects/task.server", () => ({
  ProjectTaskConflict: class extends Error {},
  startProjectTask: mock.start,
  readProjectTask: vi.fn(),
  retryProjectTask: vi.fn(),
}));

import { projectTaskRoute } from "@/lib/projects/task-route.server";

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
