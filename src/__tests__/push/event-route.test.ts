import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  enqueue: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@hive/db", () => ({
  getDb: () => ({ notificationSource: { findUnique: mocks.source } }),
}));
vi.mock("@/lib/push/event-queue", () => ({ enqueueNotification: mocks.enqueue }));
vi.mock("@/lib/queue/connection", () => ({
  getRedisConnection: () => ({ incr: mocks.incr, expire: mocks.expire }),
}));

import { POST } from "@/app/api/notifications/events/route";

const token = "a".repeat(64);
function request(body: unknown, authorization = `Bearer ${token}`) {
  return new Request("https://hive.test/api/notifications/events", {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.source.mockResolvedValue({
    id: "source-1",
    userId: "owner-1",
    workspaceId: "workspace-1",
    workspaceName: "dev",
  });
  mocks.incr.mockResolvedValue(1);
});
describe("agent event ingress", () => {
  it("requires a scoped callback token", async () => {
    expect((await POST(request({}, ""))).status).toBe(401);
    expect(mocks.source).not.toHaveBeenCalled();
    mocks.source.mockResolvedValue(null);
    expect((await POST(request({}))).status).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("derives the user and workspace from the token, ignoring spoofed targets", async () => {
    const response = await POST(
      request({
        kind: "question",
        agent: "codex",
        eventId: "event-1",
        sessionName: "dev & ops",
        userId: "victim",
        workspaceId: "victim",
      }),
    );
    expect(response.status).toBe(202);
    expect(mocks.source).toHaveBeenCalledWith({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        sourceId: "source-1",
        payload: expect.objectContaining({
          kind: "question",
          url: "/workspaces/workspace-1/terminal?session=dev+%26+ops",
        }),
      }),
      "event-1",
    );
  });
  it("bounds body size and validates event kinds", async () => {
    expect((await POST(request({ text: "x".repeat(5000) }))).status).toBe(413);
    expect(
      (await POST(request({ kind: "unrecognized", agent: "codex", eventId: "one" }))).status,
    ).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("rate limits a compromised or noisy callback", async () => {
    mocks.incr.mockResolvedValue(61);
    expect((await POST(request({ kind: "ready", agent: "claude", eventId: "one" }))).status).toBe(
      429,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
