import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CoderClient } from "@/lib/coder/client";
import type { CoderWorkspace } from "@/lib/coder/types";

// ── Helpers ──────────────────────────────────────────────────────

const BASE_URL = "https://coder.example.com";
const TOKEN = "test-session-token";

function makeClient(): CoderClient {
  return new CoderClient({ baseUrl: BASE_URL, sessionToken: TOKEN });
}

function mockWorkspace(overrides: Partial<CoderWorkspace> = {}): CoderWorkspace {
  return {
    id: "ws-123",
    name: "test-workspace",
    template_id: "tmpl-456",
    owner_name: "testuser",
    latest_build: {
      id: "build-789",
      status: "running",
      job: { status: "succeeded", error: "" },
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

// ── Test suite ───────────────────────────────────────────────────

describe("CoderClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Silence console.log from client during tests
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── createWorkspace ────────────────────────────────────────────

  it("createWorkspace sends correct URL, method, headers, and body", async () => {
    const ws = mockWorkspace();
    fetchSpy.mockResolvedValueOnce(jsonResponse(ws));

    const client = makeClient();
    const result = await client.createWorkspace("tmpl-456", "my-ws", {
      task_id: "t1",
      task_prompt: "do stuff",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      `${BASE_URL}/api/v2/organizations/default/members/me/workspaces`
    );
    expect(init.method).toBe("POST");
    expect(init.headers["Coder-Session-Token"]).toBe(TOKEN);
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.name).toBe("my-ws");
    expect(body.template_id).toBe("tmpl-456");
    expect(body.rich_parameter_values).toEqual([
      { name: "task_id", value: "t1" },
      { name: "task_prompt", value: "do stuff" },
    ]);

    expect(result).toEqual(ws);
  });

  // ── getWorkspace ───────────────────────────────────────────────

  it("getWorkspace constructs correct URL and returns workspace", async () => {
    const ws = mockWorkspace({ id: "ws-abc" });
    fetchSpy.mockResolvedValueOnce(jsonResponse(ws));

    const result = await makeClient().getWorkspace("ws-abc");

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v2/workspaces/ws-abc`);
    expect(result).toEqual(ws);
  });

  // ── stopWorkspace ──────────────────────────────────────────────

  it("stopWorkspace calls builds endpoint with transition:stop", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));

    await makeClient().stopWorkspace("ws-stop");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v2/workspaces/ws-stop/builds`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ transition: "stop" });
  });

  // ── deleteWorkspace ────────────────────────────────────────────

  it("deleteWorkspace calls builds endpoint with transition:delete", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));

    await makeClient().deleteWorkspace("ws-del");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v2/workspaces/ws-del/builds`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ transition: "delete" });
  });

  // ── waitForBuild — success ─────────────────────────────────────

  it("waitForBuild resolves when target status is reached", async () => {
    const starting = mockWorkspace({
      latest_build: {
        id: "b1",
        status: "starting",
        job: { status: "running", error: "" },
      },
    });
    const running = mockWorkspace({
      latest_build: {
        id: "b1",
        status: "running",
        job: { status: "succeeded", error: "" },
      },
    });

    // First poll → starting, second poll → running
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(starting))
      .mockResolvedValueOnce(jsonResponse(running));

    const result = await makeClient().waitForBuild("ws-123", "running", {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(result.latest_build.status).toBe("running");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ── waitForBuild — timeout ─────────────────────────────────────

  it("waitForBuild throws on timeout", async () => {
    const starting = mockWorkspace({
      latest_build: {
        id: "b1",
        status: "starting",
        job: { status: "running", error: "" },
      },
    });

    // Return a fresh Response on every call (Response body can only be read once)
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(starting))
    );

    await expect(
      makeClient().waitForBuild("ws-123", "running", {
        intervalMs: 10,
        timeoutMs: 50,
      })
    ).rejects.toThrow(/Timeout waiting for workspace ws-123/);
  });

  // ── waitForBuild — failed status ───────────────────────────────

  it("waitForBuild throws immediately on failed status", async () => {
    const failed = mockWorkspace({
      latest_build: {
        id: "b1",
        status: "failed",
        job: { status: "failed", error: "template init crashed" },
      },
    });

    fetchSpy.mockResolvedValueOnce(jsonResponse(failed));

    await expect(
      makeClient().waitForBuild("ws-123", "running", { intervalMs: 10 })
    ).rejects.toThrow(/build failed: template init crashed/);
  });

  // ── Error handling ─────────────────────────────────────────────

  it("throws descriptive error on non-2xx response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"message":"forbidden"}', {
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    await expect(makeClient().getWorkspace("ws-err")).rejects.toThrow(
      /500 Internal Server Error.*forbidden/
    );
  });

  // ── listWorkspaces ─────────────────────────────────────────────

  it("listWorkspaces calls correct URL with no filters", async () => {
    const response = { workspaces: [mockWorkspace()], count: 1 };
    fetchSpy.mockResolvedValueOnce(jsonResponse(response));

    const result = await makeClient().listWorkspaces();

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v2/workspaces`);
    expect(result.workspaces).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it("listWorkspaces encodes owner and status into query string", async () => {
    const response = { workspaces: [], count: 0 };
    fetchSpy.mockResolvedValueOnce(jsonResponse(response));

    await makeClient().listWorkspaces({ owner: "me", status: "running" });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/v2/workspaces?q=");
    const q = decodeURIComponent(url.split("?q=")[1]);
    expect(q).toContain("owner:me");
    expect(q).toContain("status:running");
  });

  it("listWorkspaces encodes only owner when status omitted", async () => {
    const response = { workspaces: [], count: 0 };
    fetchSpy.mockResolvedValueOnce(jsonResponse(response));

    await makeClient().listWorkspaces({ owner: "testuser" });

    const [url] = fetchSpy.mock.calls[0];
    const q = decodeURIComponent(url.split("?q=")[1]);
    expect(q).toBe("owner:testuser");
    expect(q).not.toContain("status:");
  });

  // ── listTemplates ───────────────────────────────────────────────

  it("listTemplates returns normalized template objects", async () => {
    const apiTemplates = [
      { id: "t1", name: "hive", active_version_id: "v1", updated_at: "2026-04-01T00:00:00Z" },
      { id: "t2", name: "ai-dev", active_version_id: "v2", updated_at: "2026-04-02T00:00:00Z" },
    ];
    fetchSpy.mockResolvedValueOnce(jsonResponse(apiTemplates));

    const result = await makeClient().listTemplates();

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v2/organizations/default/templates`);
    expect(result).toEqual([
      { id: "t1", name: "hive", activeVersionId: "v1", updatedAt: "2026-04-01T00:00:00Z" },
      { id: "t2", name: "ai-dev", activeVersionId: "v2", updatedAt: "2026-04-02T00:00:00Z" },
    ]);
  });

  // ── getTemplateVersion ────────────────────────────────────────

  it("getTemplateVersion returns normalized version with fileId and message", async () => {
    const apiVersion = {
      id: "v1",
      name: "initial",
      message: "first push",
      job: { file_id: "file-abc" },
      created_at: "2026-04-01T00:00:00Z",
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(apiVersion));

    const result = await makeClient().getTemplateVersion("v1");

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v2/templateversions/v1`);
    expect(result).toEqual({
      id: "v1",
      name: "initial",
      fileId: "file-abc",
      createdAt: "2026-04-01T00:00:00Z",
      message: "first push",
    });
  });

  // ── fetchTemplateFiles ────────────────────────────────────────

  it("fetchTemplateFiles returns tar archive as Buffer", async () => {
    const tarContent = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    fetchSpy.mockResolvedValueOnce(
      new Response(tarContent, {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/x-tar" },
      })
    );

    const result = await makeClient().fetchTemplateFiles("file-abc");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v2/files/file-abc`);
    expect(init.headers["Coder-Session-Token"]).toBe(TOKEN);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });

  it("fetchTemplateFiles throws on non-2xx response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("not found", { status: 404, statusText: "Not Found" })
    );

    await expect(makeClient().fetchTemplateFiles("bad-id")).rejects.toThrow(
      /fetchTemplateFiles failed: 404 Not Found/
    );
  });
});
