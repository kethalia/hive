import type { PrismaClient } from "@hive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accept = vi.hoisted(() => vi.fn());
vi.mock("@/lib/push/agent-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/push/agent-events")>()),
  acceptAgentEvent: accept,
}));

import { AgentEventError } from "@/lib/push/agent-events";
import { agentEventsRoute } from "@/lib/push/agent-events-route";

const database = vi.fn(() => ({}) as PrismaClient);
const route = agentEventsRoute({ enabled: () => true, database });
const event = { eventId: "unit_1", kind: "ready", agent: "claude" };
function request(body: string = JSON.stringify(event), token = "a".repeat(64)) {
  return new Request("https://hive.invalid/api/notifications/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
}
beforeEach(() => {
  database.mockClear();
  accept.mockReset().mockResolvedValue({ accepted: true });
});
describe("portable callback HTTP boundary", () => {
  it("default-off flag and invalid token/method never access the database", async () => {
    expect((await agentEventsRoute({ enabled: () => false, database })(request())).status).toBe(
      404,
    );
    expect((await route(request("{}", "bad"))).status).toBe(401);
    expect((await route(new Request("https://hive.invalid/api/notifications/events"))).status).toBe(
      405,
    );
    expect(database).not.toHaveBeenCalled();
  });
  it("bounds streamed bytes, invalid JSON and unsupported event types before database admission", async () => {
    expect((await route(request("x".repeat(4097)))).status).toBe(413);
    expect((await route(request("{"))).status).toBe(400);
    expect((await route(request(JSON.stringify({ ...event, kind: "delivery" })))).status).toBe(400);
    expect(database).not.toHaveBeenCalled();
  });
  it("hashes callback credentials, strips spoofed target fields and acknowledges committed acceptance", async () => {
    const response = await route(
      request(JSON.stringify({ ...event, userId: "spoof", workspaceId: "spoof" })),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    const [, hash, value] = accept.mock.calls[0];
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe("a".repeat(64));
    expect(value).toEqual({ ...event, sessionName: "", projectName: "" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("returns bounded reason labels and never provider/credential exception content", async () => {
    for (const [code, status] of [
      ["unauthorized", 401],
      ["event_conflict", 409],
      ["rate_limited", 429],
      ["backlog", 429],
    ] as const) {
      accept.mockRejectedValueOnce(new AgentEventError(code));
      expect((await route(request())).status).toBe(status);
    }
    accept.mockRejectedValueOnce(new Error("private-credential"));
    const response = await route(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-credential");
  });
});
