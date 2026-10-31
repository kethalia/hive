import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  session: vi.fn(),
  discover: vi.fn(),
  framework: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: () => ({
    run: (work: () => unknown) => work(),
    close: mock.close,
  }),
}));
vi.mock("../../../.open-next/cloudflare/hive-portable-actions.mjs", () => ({
  default: { schemaVersion: 1, actions: {} },
}));
vi.mock("../../../.open-next/worker.js", () => ({ default: { fetch: mock.framework } }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.session }));
vi.mock("@/lib/projects/workspace", () => ({
  discoverWorkspaceProjects: mock.discover,
  ProjectDiscoveryError: class extends Error {},
}));

import { GET } from "@/app/api/projects/route";
import worker from "../../../deploy/cloudflare/app/worker";

const origin = "https://hive.example",
  bearer = "a".repeat(64);
let tasks: Promise<unknown>[];
const context = {
  waitUntil: (task: Promise<unknown>) => {
    tasks.push(task);
  },
  passThroughOnException() {},
};
const env = () => ({
  PREVIEW_BEARER: bearer,
  HIVE_PREVIEW_ORIGIN: origin,
  HIVE_PROJECT_DISCOVERY_ENABLED: "true",
  HIVE_CODEX_GATEWAY_ENABLED: "true",
});
const request = (
  path = "/api/projects?workspaceId=10000000-0000-4000-8000-000000000001",
  method = "GET",
) => new Request(origin + path, { method, headers: { Authorization: `Bearer ${bearer}` } });
beforeEach(() => {
  vi.clearAllMocks();
  tasks = [];
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  mock.session.mockResolvedValue({ user: { id: "owner", coderUserId: "coder-owner" } });
  mock.discover.mockResolvedValue({ repositories: [] });
  mock.close.mockResolvedValue(undefined);
  mock.framework.mockImplementation(async (r: Request) =>
    new URL(r.url).pathname === "/api/projects" ? GET(r) : new Response(null, { status: 404 }),
  );
});
afterEach(async () => {
  await Promise.allSettled(tasks);
  vi.unstubAllEnvs();
});
async function dispatch(r: Request, e = env()) {
  const response = await worker.fetch(r, e, context);
  const value = await response.text();
  return { status: response.status, value };
}
describe("explicit portable terminal and discovery dispatch", () => {
  it("fixed discovery GET requires both flags and still executes real route authorization/query validation", async () => {
    expect((await dispatch(request())).status).toBe(200);
    expect(mock.discover).toHaveBeenCalledOnce();
    expect((await dispatch(request("/api/projects?workspaceId=x&unexpected=y"))).status).toBe(400);
    expect(mock.discover).toHaveBeenCalledOnce();
    mock.session.mockResolvedValue(null);
    expect((await dispatch(request())).status).toBe(401);
  });
  it("flag-off or mutation stays rejected before framework/transport", async () => {
    for (const e of [
      { ...env(), HIVE_PROJECT_DISCOVERY_ENABLED: "false" },
      { ...env(), HIVE_CODEX_GATEWAY_ENABLED: "false" },
    ])
      expect((await dispatch(request(), e)).status).toBe(503);
    expect((await dispatch(request("/api/projects", "POST"))).status).toBe(503);
    expect(mock.framework).not.toHaveBeenCalled();
    expect(mock.discover).not.toHaveBeenCalled();
  });
  it("new generic attachment and ticket routes stay default off with no Node fallback", async () => {
    expect((await dispatch(request("/ws"))).status).toBe(404);
    expect((await dispatch(request("/api/auth/terminal-ticket", "POST"))).status).toBe(503);
    expect(mock.framework).not.toHaveBeenCalled();
  });
  it("paste admits only the fixed POST behind its own explicit flag", async () => {
    const path = "/api/workspaces/10000000-0000-4000-8000-000000000001/terminal/paste-assets";
    expect((await dispatch(request(path, "POST"))).status).toBe(503);
    const enabled = { ...env(), HIVE_TERMINAL_PASTE_ENABLED: "true" };
    expect((await dispatch(request(path, "POST"), enabled)).status).toBe(404);
    expect(mock.framework).toHaveBeenCalledOnce();
    expect((await dispatch(request(path, "GET"), enabled)).status).toBe(503);
    expect((await dispatch(request(`${path}/extra`, "POST"), enabled)).status).toBe(503);
    expect(
      (await dispatch(request(path.replace("terminal/paste-assets", "voice"), "POST"), enabled))
        .status,
    ).toBe(503);
    expect(mock.framework).toHaveBeenCalledOnce();
  });
});
