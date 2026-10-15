import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_TEMPLATES } from "@/lib/templates/staleness";

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
const mockGetState = vi.fn().mockResolvedValue("active");
const mockGetJob = vi.fn().mockResolvedValue({
  data: { userId: "user-1", templateName: "ai-dev-k8s" },
  getState: mockGetState,
});

vi.mock("@/lib/templates/push-queue", () => ({
  getTemplatePushQueue: vi.fn(() => ({ add: mockAdd, getJob: mockGetJob })),
  pushLogPath: vi.fn((jobId: string) => `/tmp/template-push-${jobId}.log`),
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
  getRequestSession: vi.fn().mockResolvedValue(MOCK_SESSION),
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
    return new Request("http://localhost/api/templates/ai-dev-k8s/push", {
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

  it.each(KNOWN_TEMPLATES)("enqueues a push job for the %s template", async (templateName) => {
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ name: templateName }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobId).toBeDefined();
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(0);

    expect(mockAdd).toHaveBeenCalledOnce();
    const [jobName, jobData, opts] = mockAdd.mock.calls[0];
    expect(jobName).toBe(`push-${templateName}`);
    expect(jobData.templateName).toBe(templateName);
    expect(jobData.jobId).toBe(body.jobId);
    expect(jobData.userId).toBe("user-1");
    expect(opts.jobId).toBe(body.jobId);
  });

  it("returns 500 when queue.add fails", async () => {
    mockAdd.mockRejectedValueOnce(new Error("Redis down"));
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ name: "ai-dev-k8s" }),
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to enqueue push job");
  });
});

// ── SSE stream route tests ───────────────────────────────────────

describe("GET /api/templates/[name]/push/[jobId]/stream", () => {
  let GET: typeof import("@/app/api/templates/[name]/push/[jobId]/stream/route").GET;

  const VALID_JOB_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetState.mockResolvedValue("active");
    mockGetJob.mockResolvedValue({
      data: { userId: "user-1", templateName: "ai-dev-k8s" },
      getState: mockGetState,
    });
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 });
    mockCreateReadStream.mockReturnValue(mockReadable(""));

    const mod = await import("@/app/api/templates/[name]/push/[jobId]/stream/route");
    GET = mod.GET;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRequest(abortController?: AbortController) {
    const ctrl = abortController ?? new AbortController();
    return {
      request: new Request(
        `http://localhost/api/templates/ai-dev-k8s/push/${VALID_JOB_ID}/stream`,
        {
          signal: ctrl.signal,
        },
      ) as any,
      controller: ctrl,
    };
  }

  it("keeps a queued stream open beyond 30s, then streams the real result after the job starts", async () => {
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
    mockGetState.mockResolvedValue("waiting");
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    let ended = false;
    const body = response.text().then((text) => {
      ended = true;
      return text;
    });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(ended).toBe(false);

    mockGetState.mockResolvedValue("active");
    const content = "worker started\n[exit:0]\n";
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: content.length });
    mockCreateReadStream.mockImplementation(() => mockReadable(content));
    await vi.advanceTimersByTimeAsync(500);
    const text = await body;
    expect(text).toContain(": waiting for template push");
    expect(text).toContain("data: worker started");
    expect(text).toContain('event: status\ndata: {"success":true}');
    expect(text).not.toContain('"success":false');
  });

  it("keeps active pushes pending beyond 120s without new output and uses queue completion", async () => {
    vi.useFakeTimers();
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    let ended = false;
    const body = response.text().then((text) => {
      ended = true;
      return text;
    });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(ended).toBe(false);
    mockGetState.mockResolvedValue("completed");
    await vi.advanceTimersByTimeAsync(2500);
    expect(await body).toContain('event: status\ndata: {"success":true}');
  });

  it.each([
    true,
    false,
  ])("drains final diagnostics before closing a %s queue result", async (success) => {
    vi.useFakeTimers();
    mockGetState.mockResolvedValue(success ? "completed" : "failed");
    const initial = "starting push\n";
    const final = `final diagnostic\n[exit:${success ? 0 : 1}]\n`;
    mockStatSync.mockReturnValue({ size: initial.length });
    mockCreateReadStream.mockImplementationOnce(() => mockReadable(initial));
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    let ended = false;
    const body = response.text().then((text) => {
      ended = true;
      return text;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);
    mockStatSync.mockReturnValue({ size: initial.length + final.length });
    mockCreateReadStream.mockImplementationOnce(() => mockReadable(final));
    await vi.advanceTimersByTimeAsync(500);
    const text = await body;
    expect(text).toContain("data: final diagnostic");
    expect(text.indexOf("data: final diagnostic")).toBeLessThan(text.indexOf("event: status"));
    expect(text).toContain(`"success":${success}`);
  });

  it("bounds local log draining when no exit sentinel is ever written", async () => {
    vi.useFakeTimers();
    mockGetState.mockResolvedValue("completed");
    const partial = "last unterminated diagnostic";
    mockStatSync.mockReturnValue({ size: partial.length });
    mockCreateReadStream.mockImplementationOnce(() => mockReadable(partial));
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    let ended = false;
    const body = response.text().then((text) => {
      ended = true;
      return text;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const text = await body;
    expect(text).toContain("data: last unterminated diagnostic");
    expect(text).toContain('"success":true');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back immediately if the completed job's local log is unreadable", async () => {
    vi.useFakeTimers();
    mockGetState.mockResolvedValue("completed");
    mockStatSync.mockImplementationOnce(() => {
      throw new Error("unreadable");
    });
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    expect(await response.text()).toContain('"success":true');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "completed",
    "failed",
    "unknown",
  ])("ends without waiting for a log when the queue job is %s", async (state) => {
    mockExistsSync.mockReturnValue(false);
    mockGetState.mockResolvedValue(state);
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    const text = await response.text();
    expect(text).toContain(`"success":${state === "completed"}`);
    if (state !== "completed") {
      expect(text).toContain(
        state === "failed" ? "Template push failed" : "Push job no longer exists",
      );
    }
  });

  it("retries transient queue lookup failures without reporting the push as failed", async () => {
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
    mockGetState
      .mockRejectedValueOnce(new Error("Redis disconnected"))
      .mockResolvedValue("completed");
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    const body = response.text();
    await vi.advanceTimersByTimeAsync(500);
    const text = await body;
    expect(text).toContain('"success":true');
    expect(text).not.toContain('"success":false');
  });

  it("stops queue polling when the client cancels the stream", async () => {
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
    mockGetState.mockResolvedValue("waiting");
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    await response.body?.cancel();
    await vi.advanceTimersByTimeAsync(500);
    const calls = mockGetState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockGetState).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops queued streams when the request is aborted without reporting failure", async () => {
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
    mockGetState.mockResolvedValue("waiting");
    const { request, controller } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    const body = response.text();
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    expect(await body).not.toContain("event: status");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a controlled error if the initial queue lookup fails", async () => {
    mockGetJob.mockRejectedValueOnce(new Error("Redis down"));
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Push queue unavailable");
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { userId: "another-user", templateName: "ai-dev-k8s" },
    { userId: "user-1", templateName: "game-dev" },
  ])("rejects missing or mismatched jobs before reading any logs: %j", async (data) => {
    mockGetJob.mockResolvedValue(data ? { data, getState: mockGetState } : undefined);
    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });
    expect(response.status).toBe(404);
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

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
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: "not-a-uuid" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns SSE response with correct headers", async () => {
    // File exists, has content with exit sentinel on first poll
    mockStatSync.mockReturnValue({ size: 20 });
    mockCreateReadStream.mockReturnValue(mockReadable("[exit:0]\n"));

    const { request } = makeRequest();
    const response = await GET(request, {
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
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
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
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
      params: Promise.resolve({ name: "ai-dev-k8s", jobId: VALID_JOB_ID }),
    });

    const text = await response.text();
    expect(text).toContain("data: error output");
    expect(text).toContain('event: status\ndata: {"success":false}');
  });
});
