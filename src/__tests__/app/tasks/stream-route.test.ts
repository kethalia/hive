import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/workspace/stream", () => ({
  streamFromWorkspace: vi.fn(),
}));

vi.mock("@/lib/workspace/naming", () => ({
  workerWorkspaceName: vi.fn((taskId: string) => `hive-worker-${taskId.slice(0, 8)}`),
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

const VALID_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("GET /api/tasks/[id]/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("rejects non-UUID task IDs with 400", async () => {
    const response = await GET(makeRequest("not-a-uuid"), {
      params: makeParams("not-a-uuid"),
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toBe("Invalid task ID");
  });

  it("returns SSE content-type headers", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any);

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");

    // Consume body to avoid dangling streams
    await readSSEResponse(response);
  });

  it("sends waiting status when no running workspace found", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any);

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    const body = await readSSEResponse(response);

    expect(body).toContain('event: status\ndata: {"status":"waiting"}');
  });

  it("sends SSE error event when DB lookup fails", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockRejectedValue(new Error("Connection refused")),
      },
    } as any);

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
    });

    const body = await readSSEResponse(response);
    expect(body).toContain("event: error");
    expect(body).toContain("Database lookup failed");
  });

  it("relays lines from stream as SSE data events", async () => {
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ws-1",
          taskId: VALID_UUID,
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
    mockGetDb.mockReturnValue({
      workspace: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ws-1",
          taskId: VALID_UUID,
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

    const response = await GET(makeRequest(VALID_UUID), {
      params: makeParams(VALID_UUID),
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
          taskId: VALID_UUID,
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
