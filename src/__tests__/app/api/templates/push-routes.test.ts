import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

vi.mock("@/lib/queue/connection", () => ({
  getRedisConnection: vi.fn(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

const mockAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/templates/push-queue", () => ({
  getTemplatePushQueue: vi.fn(() => ({ add: mockAdd })),
  pushLogPath: vi.fn((jobId: string) => `/tmp/template-push-${jobId}.log`),
}));

vi.mock("@/lib/templates/staleness", () => ({
  KNOWN_TEMPLATES: ["hive", "ai-dev"] as const,
}));

const MOCK_SESSION = {
  user: {
    id: "user-1",
    coderUrl: "https://coder.test",
    coderUserId: "cu-1",
    username: "test",
    email: "test@test.com",
  },
  session: { id: "s-1", sessionId: "sess-1", expiresAt: new Date(Date.now() + 86400000) },
};

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: () => ({ value: "session-cookie" }),
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn().mockResolvedValue(MOCK_SESSION),
}));

// fs mock — configurable per test
const mockExistsSync = vi.fn().mockReturnValue(true);
const mockStatSync = vi.fn().mockReturnValue({ size: 0 });
const mockCreateReadStream = vi.fn();

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
  createWriteStream: vi.fn(),
}));

// Helper to build a mock readable that emits data then ends
function mockReadable(content: string) {
  return new Readable({
    read() {
      this.push(content);
      this.push(null);
    },
  });
}

// ── POST route tests ─────────────────────────────────────────────

describe("POST /api/templates/[name]/push", () => {
  let POST: typeof import("@/app/api/templates/[name]/push/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAdd.mockResolvedValue(undefined);
    const mod = await import("@/app/api/templates/[name]/push/route");
    POST = mod.POST;
  });

  function makeRequest() {
    return new Request("http://localhost/api/templates/hive/push", {
      method: "POST",
    }) as any;
  }

  it("returns 400 for unknown template name", async () => {
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ name: "unknown-template" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Unknown template");
  });

  it("enqueues a job and returns jobId for valid template", async () => {
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ name: "hive" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobId).toBeDefined();
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(0);

    expect(mockAdd).toHaveBeenCalledOnce();
    const [jobName, jobData, opts] = mockAdd.mock.calls[0];
    expect(jobName).toBe("push-hive");
    expect(jobData.templateName).toBe("hive");
    expect(jobData.jobId).toBe(body.jobId);
    expect(jobData.userId).toBe("user-1");
    expect(opts.jobId).toBe(body.jobId);
  });

  it("returns 500 when queue.add fails", async () => {
    mockAdd.mockRejectedValueOnce(new Error("Redis down"));
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ name: "hive" }),
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to enqueue push job");
  });

  it("accepts ai-dev as a valid template", async () => {
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ name: "ai-dev" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobId).toBeDefined();
  });
});

// ── SSE stream route tests ───────────────────────────────────────

describe("GET /api/templates/[name]/push/[jobId]/stream", () => {
  let GET: typeof import("@/app/api/templates/[name]/push/[jobId]/stream/route").GET;

  const VALID_JOB_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 });
    mockCreateReadStream.mockReturnValue(mockReadable(""));

    const mod = await import("@/app/api/templates/[name]/push/[jobId]/stream/route");
    GET = mod.GET;
  });

  function makeRequest(abortController?: AbortController) {
    const ctrl = abortController ?? new AbortController();
    return {
      request: new Request(`http://localhost/api/templates/hive/push/${VALID_JOB_ID}/stream`, {
        signal: ctrl.signal,
      }) as any,
      controller: ctrl,
    };
  }

  it("returns 400 for unknown template name", async () => {
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "bad-template", jobId: VALID_JOB_ID }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid job ID format", async () => {
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "hive", jobId: "not-a-uuid" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns SSE response with correct headers", async () => {
    // File exists, has content with exit sentinel on first poll
    mockStatSync.mockReturnValue({ size: 20 });
    mockCreateReadStream.mockReturnValue(mockReadable("[exit:0]\n"));

    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "hive", jobId: VALID_JOB_ID }),
    });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    // Consume body to let stream finish
    await response.text();
  });

  it("streams log lines as SSE data events and emits success status", async () => {
    const content = "line 1\nline 2\n[exit:0]\n";
    mockStatSync.mockReturnValue({ size: content.length });
    mockCreateReadStream.mockReturnValue(mockReadable(content));

    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "hive", jobId: VALID_JOB_ID }),
    });

    const text = await response.text();
    expect(text).toContain("data: line 1");
    expect(text).toContain("data: line 2");
    expect(text).toContain('event: status\ndata: {"success":true}');
  });

  it("emits failure status on exit:1 sentinel", async () => {
    const content = "error output\n[exit:1]\n";
    mockStatSync.mockReturnValue({ size: content.length });
    mockCreateReadStream.mockReturnValue(mockReadable(content));

    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "hive", jobId: VALID_JOB_ID }),
    });

    const text = await response.text();
    expect(text).toContain("data: error output");
    expect(text).toContain('event: status\ndata: {"success":false}');
  });
});
