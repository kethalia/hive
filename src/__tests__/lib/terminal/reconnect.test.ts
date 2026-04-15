// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.stubGlobal("crypto", {
  randomUUID: vi.fn(() => "test-uuid-1234"),
});

describe("getOrCreateReconnectId", () => {
  let getOrCreateReconnectId: typeof import("@/components/workspaces/InteractiveTerminal").getOrCreateReconnectId;

  beforeEach(async () => {
    localStorage.clear();
    vi.useFakeTimers();
    const mod = await import("@/components/workspaces/InteractiveTerminal");
    getOrCreateReconnectId = mod.getOrCreateReconnectId;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("generates new id when localStorage is empty", () => {
    const id = getOrCreateReconnectId("agent-1", "session-1");
    expect(id).toBe("test-uuid-1234");
    const stored = JSON.parse(
      localStorage.getItem("terminal:reconnect:agent-1:session-1")!,
    );
    expect(stored.id).toBe("test-uuid-1234");
    expect(typeof stored.ts).toBe("number");
  });

  it("returns cached value within TTL", () => {
    const now = Date.now();
    localStorage.setItem(
      "terminal:reconnect:agent-1:session-1",
      JSON.stringify({ id: "cached-id", ts: now }),
    );
    const id = getOrCreateReconnectId("agent-1", "session-1");
    expect(id).toBe("cached-id");
  });

  it("generates new value when TTL expired", () => {
    const expired = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(
      "terminal:reconnect:agent-1:session-1",
      JSON.stringify({ id: "old-id", ts: expired }),
    );
    const id = getOrCreateReconnectId("agent-1", "session-1");
    expect(id).toBe("test-uuid-1234");
  });

  it("handles corrupted localStorage gracefully", () => {
    localStorage.setItem(
      "terminal:reconnect:agent-1:session-1",
      "not-json",
    );
    const id = getOrCreateReconnectId("agent-1", "session-1");
    expect(id).toBe("test-uuid-1234");
  });

  it("handles missing fields in stored JSON", () => {
    localStorage.setItem(
      "terminal:reconnect:agent-1:session-1",
      JSON.stringify({ foo: "bar" }),
    );
    const id = getOrCreateReconnectId("agent-1", "session-1");
    expect(id).toBe("test-uuid-1234");
  });

  it("uses different storage keys for different agents/sessions", () => {
    let callCount = 0;
    vi.mocked(crypto.randomUUID)
      .mockImplementationOnce(() => { callCount++; return "uuid-a"; })
      .mockImplementationOnce(() => { callCount++; return "uuid-b"; });

    const id1 = getOrCreateReconnectId("agent-1", "session-1");
    const id2 = getOrCreateReconnectId("agent-2", "session-2");
    expect(id1).toBe("uuid-a");
    expect(id2).toBe("uuid-b");
    expect(callCount).toBe(2);
  });

  it("persists new id with fresh timestamp", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    getOrCreateReconnectId("agent-1", "session-1");
    const stored = JSON.parse(
      localStorage.getItem("terminal:reconnect:agent-1:session-1")!,
    );
    expect(stored.ts).toBe(new Date("2026-01-01T00:00:00Z").getTime());
  });
});
