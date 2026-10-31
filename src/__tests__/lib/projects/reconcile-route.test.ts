import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("@/lib/projects/task.server", () => ({ reconcileProjectTasks: mock.reconcile }));

import { POST } from "@/app/api/internal/project-tasks/reconcile/route";
import {
  authorizeProjectReconcile,
  PROJECT_RECONCILE_PATH,
} from "@/lib/projects/reconcile-transport";
import { proxy } from "@/proxy";

const secret = "b".repeat(64),
  origin = "https://hive.example";
function request(body = '{"schemaVersion":1}', headers: Record<string, string> = {}, suffix = "") {
  return new Request(origin + PROJECT_RECONCILE_PATH + suffix, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "X-Hive-Reconcile-Deadline": String(Date.now() + 45000),
      ...headers,
    },
    body,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "true");
  vi.stubEnv("HIVE_PROJECT_TASK_RECONCILE_SECRET", secret);
  mock.reconcile.mockResolvedValue({ enabled: true, processed: 1, retry: 0, stale: 0 });
});
afterEach(() => vi.unstubAllEnvs());
describe("private selector-free project wakeup", () => {
  it("checks deployment and private authentication before any intent claim", async () => {
    vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "false");
    expect((await POST(request())).status).toBe(404);
    vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "true");
    for (const header of ["", `Bearer ${"a".repeat(64)}`])
      expect((await POST(request(undefined, { Authorization: header }))).status).toBe(401);
    expect(mock.reconcile).not.toHaveBeenCalled();
  });
  it("rejects browser, query, framework and encoded transport variants in route and middleware", async () => {
    for (const [name, value] of [
      ["Origin", origin],
      ["Cookie", "session=ignored"],
      ["Sec-Fetch-Site", "same-origin"],
      ["Next-Action", "ignored"],
      ["Upgrade", "websocket"],
      ["Content-Encoding", "gzip"],
    ]) {
      const input = request(undefined, { [name]: value });
      expect((await POST(input.clone())).status).toBe(400);
      expect(proxy(new NextRequest(input)).status).toBe(400);
    }
    for (const suffix of ["?", "?x=1"]) {
      expect((await POST(request(undefined, {}, suffix))).status).toBe(400);
      const middlewareRequest = new NextRequest(request(undefined, {}, suffix));
      // NextRequest canonicalizes an empty query away. The outer Worker checks
      // the raw Request first; when present, middleware rejects it as well.
      expect(proxy(middlewareRequest).status).toBe(middlewareRequest.url.includes("?") ? 400 : 200);
    }
    const input = request();
    expect(authorizeProjectReconcile(new Request(input, { method: "PUT" }), process.env)).toBe(400);
    expect(mock.reconcile).not.toHaveBeenCalled();
  });
  it("rejects malformed, oversized or selector-bearing bodies before any claim", async () => {
    for (const body of [
      "{",
      "null",
      "[]",
      "{}",
      '{"schemaVersion":1,"ownerId":"selected"}',
      JSON.stringify({ schemaVersion: 1, padding: "a".repeat(513) }),
    ])
      expect((await POST(request(body))).status).toBe(400);
    expect(mock.reconcile).not.toHaveBeenCalled();
  });
  it("rejects missing, malformed, expired or excessively future authenticated deadlines", async () => {
    for (const deadline of ["", "future", String(Date.now() - 1), String(Date.now() + 50000)])
      expect(
        (await POST(request(undefined, { "X-Hive-Reconcile-Deadline": deadline }))).status,
      ).toBe(400);
    expect(mock.reconcile).not.toHaveBeenCalled();
  });
  it("allows only the fixed authenticated middleware transport and returns aggregate counts", async () => {
    const input = request();
    expect(proxy(new NextRequest(input.clone())).headers.get("x-middleware-next")).toBe("1");
    const response = await POST(input);
    expect(await response.json()).toEqual({ schemaVersion: 1, processed: 1, retry: 0, stale: 0 });
    expect(mock.reconcile).toHaveBeenCalledWith(undefined, 1, { signal: expect.any(AbortSignal) });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("cannot reuse a preview/auth credential and never accepts a late positive after abort", async () => {
    vi.stubEnv("PREVIEW_BEARER", secret);
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv("PREVIEW_BEARER", "");
    const controller = new AbortController();
    mock.reconcile.mockImplementation(async () => {
      controller.abort();
      return { enabled: true, processed: 1, retry: 0, stale: 0 };
    });
    const input = new Request(request(), { signal: controller.signal });
    expect((await POST(input)).status).toBe(408);
  });
});
