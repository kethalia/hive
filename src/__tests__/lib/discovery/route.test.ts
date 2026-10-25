import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/discovery/[resource]/route";

const mocks = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), repos: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: mocks.read,
  listWorkspaceTemplatesAction: mocks.read,
  getWorkspaceAgentAction: mocks.read,
  getWorkspaceSessionsAction: mocks.read,
}));
vi.mock("@/lib/actions/templates", () => ({ listTemplateStatusesAction: mocks.read }));
vi.mock("@/lib/actions/agent-tools", () => ({ inspectAgentToolsAction: mocks.read }));
vi.mock("@/lib/actions/git-clones", () => ({ listGitClonesAction: mocks.repos }));
const get = (resource: string, query = "workspaceId=dev") =>
  GET(new Request(`https://hive.example/api/discovery/${resource}?${query}`), {
    params: Promise.resolve({ resource }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "alice" } });
  mocks.read.mockResolvedValue({ data: [] });
});
describe("authenticated discovery GET", () => {
  it("requires authentication before any workspace read", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await get("workspaces")).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([
    "workspaces",
    "agent",
    "sessions",
    "agent-tools",
    "templates",
    "template-options",
  ])("returns private uncacheable HTTP data for %s", async (resource) => {
    const response = await get(resource);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });
  it("allowlists resources and validates workspace identity", async () => {
    expect((await get("credentials")).status).toBe(404);
    expect((await get("sessions", "")).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([
    ["Not authenticated", 401],
    ["No Coder API token stored for user alice", 401],
    ["Only the workspace owner can manage agent tools and sessions.", 403],
    ["[coder] Request failed: 404 Not Found", 404],
    ["Start this workspace first.", 409],
    ["offline", 503],
  ])("classifies %s as %i", async (serverError, status) => {
    mocks.read.mockResolvedValue({ serverError });
    expect((await get("sessions")).status).toBe(status);
  });
  it("unwraps repository snapshots and passes explicit refresh to the scan", async () => {
    mocks.repos.mockResolvedValue({ data: { ok: true, tree: { nodes: [] } } });
    expect(await (await get("repositories", "workspaceId=dev&refresh=1")).json()).toEqual({
      data: { nodes: [] },
    });
    expect(mocks.repos).toHaveBeenCalledWith({ workspaceId: "dev", refresh: true });
    mocks.repos.mockResolvedValue({ data: { ok: false, message: "scan failed" } });
    expect((await get("repositories")).status).toBe(503);
  });
});
