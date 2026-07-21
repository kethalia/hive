import { describe, expect, it, vi } from "vitest";
import { TerminalSessionEventStore } from "../src/session-events.js";

function recordEvent(
  store: TerminalSessionEventStore,
  workspaceId: string,
  sessionName: string,
  bytes: number,
) {
  return store.record({
    workspaceId,
    connectionId: `${workspaceId}-connection`,
    sessionName,
    sessionKind: sessionName.startsWith("git-") ? "git" : "terminal",
    type: "upstream_output",
    details: { bytes, frames: 1 },
  });
}

describe("TerminalSessionEventStore", () => {
  it("returns only events for workspaces authorized to the current user", () => {
    const store = new TerminalSessionEventStore();
    recordEvent(store, "workspace-a", "terminal-a", 10);
    recordEvent(store, "workspace-b", "git-b", 20);

    const payload = store.list({ authorizedWorkspaceIds: new Set(["workspace-a"]) });

    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      workspaceId: "workspace-a",
      sessionName: "terminal-a",
      details: { bytes: 10, frames: 1 },
    });
    expect(JSON.stringify(payload)).not.toContain("workspace-b");
  });

  it("supports incremental reads without replaying old events", () => {
    const store = new TerminalSessionEventStore();
    const first = recordEvent(store, "workspace-a", "terminal-a", 10);
    const second = recordEvent(store, "workspace-a", "terminal-a", 20);

    const payload = store.list({
      authorizedWorkspaceIds: new Set(["workspace-a"]),
      afterId: first.id,
    });

    expect(payload.events).toEqual([second]);
  });

  it("retains a bounded history under sustained terminal output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T08:00:00.000Z"));
    const store = new TerminalSessionEventStore();
    for (let index = 0; index < 4_200; index += 1) {
      recordEvent(store, "workspace-a", "terminal-a", index);
    }

    const payload = store.list({
      authorizedWorkspaceIds: new Set(["workspace-a"]),
      limit: 1_000,
    });

    expect(payload.events).toHaveLength(1_000);
    expect(payload.events[0]?.id).toBe(3_201);
    expect(payload.events.at(-1)?.id).toBe(4_200);
    expect(payload.generatedAt).toBe("2026-07-21T08:00:00.000Z");
    vi.useRealTimers();
  });
});
