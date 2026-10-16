import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  enqueue: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@hive/db", () => ({
  getDb: () => ({ notificationSource: { findFirst: mocks.source } }),
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
      where: {
        OR: [
          { tokenHash: createHash("sha256").update(token).digest("hex") },
          { pendingTokenHash: createHash("sha256").update(token).digest("hex") },
        ],
      },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        sourceId: "source-1",
        payload: expect.objectContaining({
          kind: "question",
          title: "Question waiting",
          url: "/workspaces/workspace-1/terminal?session=dev+%26+ops&notification=event-1",
        }),
      }),
      "event-1",
    );
  });
  it("puts the project first while retaining the opaque session only in the deep link", async () => {
    const sessionName = `git-clone-${"a".repeat(32)}`;
    expect(
      (
        await POST(
          request({
            kind: "ready",
            agent: "codex",
            eventId: "ready-1",
            sessionName,
            projectName: "codex-creative-studio",
          }),
        )
      ).status,
    ).toBe(202);
    const { payload } = mocks.enqueue.mock.calls[0][0];
    expect(payload.title).toBe("Agent ready");
    expect(payload.body).toBe("Codex has finished its turn in codex-creative-studio on dev.");
    expect(payload.body).not.toContain(sessionName);
    expect(payload.url).toBe(
      `/workspaces/workspace-1/terminal?session=${sessionName}&notification=ready-1`,
    );
  });
  it("keeps custom session names alongside the project for Claude Code", async () => {
    await POST(
      request({
        kind: "question",
        agent: "claude",
        eventId: "question-1",
        projectName: "hive",
        sessionName: "release-fix",
      }),
    );
    expect(mocks.enqueue.mock.calls[0][0].payload.body).toBe(
      "Claude Code has a question for you in hive (release-fix) on dev.",
    );
  });
  it("does not repeat a session named after its project", async () => {
    await POST(
      request({
        kind: "ready",
        agent: "codex",
        eventId: "same",
        projectName: "hive",
        sessionName: "hive",
      }),
    );
    expect(mocks.enqueue.mock.calls[0][0].payload.body).toBe(
      "Codex has finished its turn in hive on dev.",
    );
  });
  it("accepts older senders without exposing clone hashes", async () => {
    await POST(
      request({
        kind: "ready",
        agent: "codex",
        eventId: "legacy-1",
        sessionName: `git-clone-${"b".repeat(32)}`,
      }),
    );
    expect(mocks.enqueue.mock.calls[0][0].payload.body).toBe("Codex has finished its turn on dev.");
    await POST(
      request({ kind: "ready", agent: "codex", eventId: "legacy-2", sessionName: "build" }),
    );
    expect(mocks.enqueue.mock.calls[1][0].payload.body).toBe(
      "Codex has finished its turn in build on dev.",
    );
  });
  it("normalizes display whitespace and bounds project labels", async () => {
    await POST(
      request({
        kind: "ready",
        agent: "codex",
        eventId: "spacing",
        projectName: "  creative\nstudio  ",
        sessionName: " feature\twork ",
      }),
    );
    expect(mocks.enqueue.mock.calls[0][0].payload.body).toBe(
      "Codex has finished its turn in creative studio (feature work) on dev.",
    );
    expect(
      (
        await POST(
          request({ kind: "ready", agent: "codex", eventId: "long", projectName: "a".repeat(201) }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["question", "has a question for you"],
    ["approval", "is waiting for your approval"],
    ["ready", "has finished its turn"],
    ["failure", "stopped because of an error"],
  ])("writes %s alerts as a sentence", async (kind, message) => {
    await POST(request({ kind, agent: "claude", eventId: "message", projectName: "hive" }));
    expect(mocks.enqueue.mock.calls[0][0].payload.body).toBe(
      `Claude Code ${message} in hive on dev.`,
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
