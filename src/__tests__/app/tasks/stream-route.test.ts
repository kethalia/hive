import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSession = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: vi.fn(() => ({ value: "valid-session" })) })),
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: (...args: unknown[]) => mockSession(...args),
}));
vi.mock("@hive/db", () => ({
  getDb: vi.fn(),
}));
vi.mock("@/lib/workspace/stream", () => ({
  streamFromWorkspace: vi.fn(),
}));
vi.mock("@/lib/workspace/naming", () => ({
  workerWorkspaceName: vi.fn((taskId: string) => `hive-worker-${taskId.slice(0, 8)}`),
}));

import { getDb } from "@hive/db";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/tasks/[id]/stream/route";
import { streamFromWorkspace } from "@/lib/workspace/stream";

const mockGetDb = vi.mocked(getDb);
const mockStreamFromWorkspace = vi.mocked(streamFromWorkspace);

/** Read all text from a Response with SSE body */
async function readSSEResponse(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function makeRequest(taskId: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/tasks/${taskId}/stream`), {
    method: "GET",
  });
}

function makeParams(taskId: string): Promise<{ id: string }> {
  return Promise.resolve({ id: taskId });
}

function mockDb({
  task = { id: VALID_UUID },
  workspace = null,
}: {
  task?: { id: string } | null | Error;
  workspace?: unknown | Error;
} = {}) {
  const taskFindFirst = vi.fn();
  if (task instanceof Error) {
    taskFindFirst.mockRejectedValue(task);
  } else {
    taskFindFirst.mockResolvedValue(task);
  }

  const workspaceFindFirst = vi.fn();
  if (workspace instanceof Error) {
    workspaceFindFirst.mockRejectedValue(workspace);
  } else {
    workspaceFindFirst.mockResolvedValue(workspace);
  }

  mockGetDb.mockReturnValue({
    task: { findFirst: taskFindFirst },
    workspace: { findFirst: workspaceFindFirst },
  } as any);

  return { taskFindFirst, workspaceFindFirst };
}

const VALID_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const runningWorkspace = {
  id: "ws-1",
  taskId: VALID_UUID,
  coderWorkspaceId: "coder-ws-1",
  templateType: "worker",
  status: "running",
};

describe("GET /api/tasks/[id]/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockSession.mockResolvedValue({
      user: {
        id: "user-1",
        coderUrl: "https://coder.example.com",
        coderUserId: "coder-uid",
        username: "testuser",
        email: "test@example.com",
      },
      session: {
        id: "s-1",
        sessionId: "valid-session",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  it("rejects non-UUID task IDs with 400", async () => {
    const response = await GET(makeRequest("not-a-uuid"), {
      params: makeParams("not-a-uuid"),
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toBe("Invalid task ID");
  });

  it("rejects cross-user or missing tasks with 404 before looking up workspace", async () => {
    const { taskFindFirst, workspaceFindFirst } = mockDb({ task: null });

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(taskFindFirst).toHaveBeenCalledWith({
      where: { id: VALID_UUID, userId: "user-1" },
      select: { id: true },
    });
    expect(workspaceFindFirst).not.toHaveBeenCalled();
    expect(mockStreamFromWorkspace).not.toHaveBeenCalled();
  });

  it("returns SSE content-type headers", async () => {
    mockDb();

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");

    // Consume body to avoid dangling streams
    await readSSEResponse(response);
  });

  it("sends waiting status when no running workspace found", async () => {
    mockDb();

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    const body = await readSSEResponse(response);

    expect(body).toContain('event: status\ndata: {"status":"waiting"}');
  });

  it("sends SSE error event when DB lookup fails", async () => {
    mockDb({ workspace: new Error("Connection refused") });

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    const body = await readSSEResponse(response);
    expect(body).toContain("event: error");
    expect(body).toContain("Database lookup failed");
  });

  it("relays lines from stream as SSE data events", async () => {
    mockDb({ workspace: runningWorkspace });

    // Create a mock readable stream that emits lines then closes
    const mockReadable = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("Hello from agent");
        controller.enqueue("Second line");
        controller.close();
      },
    });

    const mockProcess = { killed: false, kill: vi.fn() };
    mockStreamFromWorkspace.mockReturnValue({
      stdout: mockReadable,
      process: mockProcess as any,
    });

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    const body = await readSSEResponse(response);

    // Should contain connected status, data lines, and ended status
    expect(body).toContain('event: status\ndata: {"status":"connected"}');
    expect(body).toContain("data: Hello from agent\n\n");
    expect(body).toContain("data: Second line\n\n");
    expect(body).toContain('event: status\ndata: {"status":"ended"}');
  });

  it("sends ended status on stream close and kills process", async () => {
    mockDb({ workspace: runningWorkspace });

    // Stream that immediately closes
    const mockReadable = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });

    const mockProcess = { killed: false, kill: vi.fn() };
    mockStreamFromWorkspace.mockReturnValue({
      stdout: mockReadable,
      process: mockProcess as any,
    });

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    const body = await readSSEResponse(response);

    expect(body).toContain('event: status\ndata: {"status":"ended"}');
    expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("calls streamFromWorkspace with correct workspace name and command", async () => {
    mockDb({ workspace: runningWorkspace });

    const mockReadable = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });

    const mockProcess = { killed: false, kill: vi.fn() };
    mockStreamFromWorkspace.mockReturnValue({
      stdout: mockReadable,
      process: mockProcess as any,
    });

    const request = makeRequest(VALID_UUID);
    const response = await GET(request, { params: makeParams(VALID_UUID) });

    // Workspace name should follow hive-worker-{taskId.slice(0,8)} pattern
    expect(mockStreamFromWorkspace).toHaveBeenCalledWith(
      `hive-worker-${VALID_UUID.slice(0, 8)}`,
      "tail -f -n +1 /tmp/hive-agent-output.log",
      request.signal,
    );

    // Consume body to avoid dangling streams
    await readSSEResponse(response);
  });
});
