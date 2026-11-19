import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/workspaces/[workspaceId]/build-logs/route";

const mocks = vi.hoisted(() => ({ session: vi.fn(), workspace: vi.fn(), logs: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: async () => ({
    getWorkspace: mocks.workspace,
    getWorkspaceBuildLogs: mocks.logs,
  }),
}));
const id = "11111111-1111-4111-8111-111111111111";
const read = (query = "") =>
  GET(new Request(`https://hive.example/api/workspaces/${id}/build-logs${query}`), {
    params: Promise.resolve({ workspaceId: id }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "hive-user", coderUserId: "owner" } });
  mocks.workspace.mockResolvedValue({
    id,
    owner_id: "owner",
    latest_build: { id: "build", status: "starting", job: { status: "running", error: "" } },
  });
  mocks.logs.mockResolvedValue([
    {
      id: 18,
      stage: "Starting",
      output: "Provisioning",
      created_at: "2026-11-19T20:00:00Z",
      other: "internal",
    },
  ]);
});
it("requires a session and workspace ownership before accessing build output", async () => {
  mocks.session.mockResolvedValueOnce(null);
  expect((await read()).status).toBe(401);
  expect(mocks.workspace).not.toHaveBeenCalled();
  mocks.workspace.mockResolvedValueOnce({ owner_id: "someone-else" });
  expect((await read()).status).toBe(403);
  expect(mocks.logs).not.toHaveBeenCalled();
});
it.each([
  ["build", 17],
  ["previous-build", 0],
])("reads only the current build and resets stale cursors (%s)", async (build, after) => {
  const response = await read(`?build=${build}&after=17`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(mocks.logs).toHaveBeenCalledWith("build", after);
  const data = await response.json();
  expect(data.logs[0].output).toBe("Provisioning");
  expect(data.logs[0]).not.toHaveProperty("other");
});
