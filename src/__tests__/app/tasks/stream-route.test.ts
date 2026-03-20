import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/workspace/stream", () => ({
  streamFromWorkspace: vi.fn(),
}));

import { GET } from "@/app/api/tasks/[id]/stream/route";
import { getDb } from "@/lib/db";
import { streamFromWorkspace } from "@/lib/workspace/stream";
import { NextRequest } from "next/server";

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
  return new NextRequest(
    new URL(`http://localhost:3000/api/tasks/${taskId}/stream`),
    { method: "GET" },
  );
}

function makeParams(taskId: string): Promise<{ id: string }> {
  return Promise.resolve({ id: taskId });
}

describe("GET /api/tasks/[id]/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns SSE content-type headers", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any);

    const response = await GET(makeRequest("task-1"), {
      params: makeParams("task-1"),
    });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Connection")).toBe("keep-alive");

    // Consume body to avoid dangling streams
    await readSSEResponse(response);
  });

  it("sends waiting status when no running workspace found", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any);

    const response = await GET(makeRequest("task-1"), {
      params: makeParams("task-1"),
    });

    const body = await readSSEResponse(response);

    expect(body).toContain('event: status\ndata: {"status":"waiting"}');
  });

  it("relays lines from stream as SSE data events", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ws-1",
          taskId: "task-1234-abcd",
          coderWorkspaceId: "coder-ws-1",
          templateType: "worker",
          status: "running",
        }),
      },
    } as any);

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

    const response = await GET(makeRequest("task-1234-abcd"), {
      params: makeParams("task-1234-abcd"),
    });

    const body = await readSSEResponse(response);

    // Should contain connected status, data lines, and ended status
    expect(body).toContain('event: status\ndata: {"status":"connected"}');
    expect(body).toContain("data: Hello from agent\n\n");
    expect(body).toContain("data: Second line\n\n");
    expect(body).toContain('event: status\ndata: {"status":"ended"}');
  });

  it("sends ended status on stream close and kills process", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ws-1",
          taskId: "task-5678-efgh",
          coderWorkspaceId: "coder-ws-1",
          templateType: "worker",
          status: "running",
        }),
      },
    } as any);

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

    const response = await GET(makeRequest("task-5678-efgh"), {
      params: makeParams("task-5678-efgh"),
    });

    const body = await readSSEResponse(response);

    expect(body).toContain('event: status\ndata: {"status":"ended"}');
    expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("calls streamFromWorkspace with correct workspace name and command", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ws-1",
          taskId: "task-abcd-1234-efgh",
          coderWorkspaceId: "coder-ws-1",
          templateType: "worker",
          status: "running",
        }),
      },
    } as any);

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

    const request = makeRequest("task-abcd-1234-efgh");
    const response = await GET(request, { params: makeParams("task-abcd-1234-efgh") });

    // Workspace name should follow hive-worker-{taskId.slice(0,8)} pattern
    expect(mockStreamFromWorkspace).toHaveBeenCalledWith(
      "hive-worker-task-abc",
      "tail -f -n +1 /tmp/hive-agent-output.log",
      request.signal,
    );

    // Consume body to avoid dangling streams
    await readSSEResponse(response);
  });
});
