import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectionRegistry, KeepAliveManager } from "../src/keepalive.js";

describe("ConnectionRegistry", () => {
  let registry: ConnectionRegistry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  it("tracks a single connection", () => {
    registry.addConnection("ws-1", "conn-a");
    expect(registry.getActiveWorkspaceIds()).toEqual(["ws-1"]);
    expect(registry.getConnectionCount("ws-1")).toBe(1);
  });

  it("tracks multiple connections per workspace", () => {
    registry.addConnection("ws-1", "conn-a");
    registry.addConnection("ws-1", "conn-b");
    expect(registry.getActiveWorkspaceIds()).toEqual(["ws-1"]);
    expect(registry.getConnectionCount("ws-1")).toBe(2);
  });

  it("tracks multiple workspaces", () => {
    registry.addConnection("ws-1", "conn-a");
    registry.addConnection("ws-2", "conn-b");
    expect(registry.getActiveWorkspaceIds()).toHaveLength(2);
    expect(registry.getActiveWorkspaceIds()).toContain("ws-1");
    expect(registry.getActiveWorkspaceIds()).toContain("ws-2");
  });

  it("removes connection and keeps workspace if others remain", () => {
    registry.addConnection("ws-1", "conn-a");
    registry.addConnection("ws-1", "conn-b");
    registry.removeConnection("ws-1", "conn-a");
    expect(registry.getActiveWorkspaceIds()).toEqual(["ws-1"]);
    expect(registry.getConnectionCount("ws-1")).toBe(1);
  });

  it("removes workspace when last connection closes", () => {
    registry.addConnection("ws-1", "conn-a");
    registry.removeConnection("ws-1", "conn-a");
    expect(registry.getActiveWorkspaceIds()).toEqual([]);
    expect(registry.getConnectionCount("ws-1")).toBe(0);
  });

  it("handles removing non-existent connection gracefully", () => {
    registry.removeConnection("ws-1", "conn-a");
    expect(registry.getActiveWorkspaceIds()).toEqual([]);
  });

  it("handles removing non-existent workspace gracefully", () => {
    registry.addConnection("ws-1", "conn-a");
    registry.removeConnection("ws-999", "conn-a");
    expect(registry.getActiveWorkspaceIds()).toEqual(["ws-1"]);
  });

  it("returns 0 connection count for unknown workspace", () => {
    expect(registry.getConnectionCount("ws-unknown")).toBe(0);
  });

  it("handles rapid connect/disconnect without stale entries", () => {
    registry.addConnection("ws-1", "conn-a");
    registry.removeConnection("ws-1", "conn-a");
    registry.addConnection("ws-1", "conn-b");
    registry.removeConnection("ws-1", "conn-b");
    expect(registry.getActiveWorkspaceIds()).toEqual([]);
  });

  it("stores and retrieves connection metadata", () => {
    registry.addConnection("ws-1", "conn-a", { token: "tok-1", coderUrl: "http://coder1" });
    const meta = registry.getWorkspaceMeta("ws-1");
    expect(meta).toEqual({ token: "tok-1", coderUrl: "http://coder1" });
  });

  it("returns first available meta for workspace with multiple connections", () => {
    registry.addConnection("ws-1", "conn-a", { token: "tok-a", coderUrl: "http://coder" });
    registry.addConnection("ws-1", "conn-b", { token: "tok-b", coderUrl: "http://coder" });
    const meta = registry.getWorkspaceMeta("ws-1");
    expect(meta).not.toBeNull();
    expect(meta!.token).toBe("tok-a");
  });

  it("returns null meta for unknown workspace", () => {
    expect(registry.getWorkspaceMeta("ws-unknown")).toBeNull();
  });

  it("cleans up metadata on connection removal", () => {
    registry.addConnection("ws-1", "conn-a", { token: "tok-1", coderUrl: "http://coder" });
    registry.removeConnection("ws-1", "conn-a");
    expect(registry.getWorkspaceMeta("ws-1")).toBeNull();
  });

  it("works with connections that have no metadata", () => {
    registry.addConnection("ws-1", "conn-a");
    expect(registry.getWorkspaceMeta("ws-1")).toBeNull();
  });
});

const testMeta = { token: "test-token", coderUrl: "https://coder.example.com" };

describe("KeepAliveManager", () => {
  let registry: ConnectionRegistry;
  let manager: KeepAliveManager;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ConnectionRegistry();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    manager = new KeepAliveManager(registry, "https://coder.example.com");
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pings active workspaces with correct URL and headers", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://coder.example.com/api/v2/workspaces/ws-abc/extend");
    expect(opts.method).toBe("PUT");
    expect(opts.headers["Coder-Session-Token"]).toBe("test-token");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.deadline).toBeDefined();
  });

  it("resets failure count on successful ping", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("err") });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");
    expect(manager.getHealth()["ws-abc"].consecutiveFailures).toBe(1);

    fetchMock.mockResolvedValue({ ok: true });
    await manager.ping("ws-abc");
    expect(manager.getHealth()["ws-abc"].consecutiveFailures).toBe(0);
    expect(manager.getHealth()["ws-abc"].lastSuccess).toBeTruthy();
  });

  it("increments failure count on HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");
    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.consecutiveFailures).toBe(2);
    expect(health.lastError).toContain("401");
    expect(health.lastFailure).toBeTruthy();
  });

  it("increments failure count on network error", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("fetch failed");
  });

  it("increments failure count on abort (timeout simulation)", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toContain("aborted");
  });

  it("does not ping when no workspaces are active", async () => {
    manager.start();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pings immediately on start and on interval", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(55_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stop clears interval", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    manager.stop();
    await vi.advanceTimersByTimeAsync(110_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getHealth returns empty when no pings happened", () => {
    expect(manager.getHealth()).toEqual({});
  });

  it("does not leak session token in logs", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: true });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    for (const call of [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls]) {
      for (const arg of call) {
        expect(String(arg)).not.toContain("test-token");
      }
    }

    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it("handles 404 (deleted workspace) as failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("not found") });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toContain("404");
  });

  it("strips trailing slashes from coder URL", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const m = new KeepAliveManager(registry, "https://coder.example.com///");
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await m.ping("ws-abc");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://coder.example.com/api/v2/workspaces/ws-abc/extend");
  });

  it("skips ping when no token available for workspace", async () => {
    registry.addConnection("ws-abc", "conn-1");
    await manager.ping("ws-abc");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses per-connection coderUrl over default", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    registry.addConnection("ws-abc", "conn-1", { token: "t", coderUrl: "https://custom-coder.example.com" });

    await manager.ping("ws-abc");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://custom-coder.example.com/api/v2/workspaces/ws-abc/extend");
  });
});
