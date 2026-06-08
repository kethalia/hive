import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it.each([
    [401, "http-auth"],
    [403, "http-auth"],
    [404, "http-client"],
    [500, "http-server"],
  ] as const)("classifies HTTP %s keepalive failures as %s", async (status, category) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status,
      text: () => Promise.resolve("secret-token /tmp/session ws-abc response body"),
    });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");
    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.status).toBe("failing");
    expect(health.consecutiveFailures).toBe(2);
    expect(health.lastFailureCategory).toBe(category);
    expect(health.lastFailureReason).toBeTruthy();
    expect(health.lastFailureDetail).toBeTruthy();
    expect(health.lastHttpStatus).toBe(status);
    expect(health.lastAttempt).toBeTruthy();
    expect(health.lastAttemptDurationMs).toEqual(expect.any(Number));
    expect(health.lastFailure).toBeTruthy();
    expect(health.activeConnectionCount).toBe(1);
    expect(health).not.toHaveProperty("lastError");
    expect(JSON.stringify(health)).not.toContain("secret-token");
    expect(JSON.stringify(health)).not.toContain("/tmp/session");
  });

  it("classifies manual shutdown as not applicable instead of high keepalive failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve(JSON.stringify({ message: "Workspace shutdown is manual." })),
    });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");
    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.status).toBe("not-applicable");
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastFailureCategory).toBe("manual-shutdown");
    expect(health.lastFailureReason).toBe("manual-shutdown");
    expect(health.lastFailureDetail).toContain("shutdown is manual");
    expect(health.lastHttpStatus).toBe(409);
    expect(health.lastHttpStatusText).toBe("Conflict");
  });

  it("classifies network errors without storing the raw error message", async () => {
    fetchMock.mockRejectedValue(new Error("secret-token /Users/alice/project ws-abc failed"));
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.status).toBe("failing");
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailureCategory).toBe("network");
    expect(JSON.stringify(health)).not.toContain("secret-token");
    expect(JSON.stringify(health)).not.toContain("/Users/alice/project");
    expect(JSON.stringify(health)).not.toContain("ws-abc failed");
  });

  it("classifies abort errors as timeout without storing the raw abort message", async () => {
    fetchMock.mockRejectedValue(
      new DOMException("secret-token aborted /tmp/session", "AbortError"),
    );
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.status).toBe("failing");
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailureCategory).toBe("timeout");
    expect(JSON.stringify(health)).not.toContain("secret-token");
    expect(JSON.stringify(health)).not.toContain("/tmp/session");
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

  it("does not leak session token, Coder URL, workspace ID, raw body, or raw error in logs", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("test-token https://coder.example.com ws-abc /tmp/session body"),
    });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    const logText = [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(logText).toContain("event=ping-failed");
    expect(logText).toContain("failureCategory=http-server");
    expect(logText).not.toContain("test-token");
    expect(logText).not.toContain("https://coder.example.com");
    expect(logText).not.toContain("ws-abc");
    expect(logText).not.toContain("/tmp/session");
    expect(logText).not.toContain("body");

    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it("reports healthy status, last attempt, and active connection count on successful ping", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    registry.addConnection("ws-abc", "conn-1", testMeta);

    await manager.ping("ws-abc");

    const health = manager.getHealth()["ws-abc"];
    expect(health.status).toBe("healthy");
    expect(health.lastAttempt).toBeTruthy();
    expect(health.lastSuccess).toBeTruthy();
    expect(health.lastFailureCategory).toBeNull();
    expect(health.activeConnectionCount).toBe(1);
  });

  it("retains a sanitized recently-disconnected health record without pinging it", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    registry.addConnection("ws-abc", "conn-1", testMeta);
    await manager.ping("ws-abc");
    fetchMock.mockClear();

    registry.removeConnection("ws-abc", "conn-1");
    await (manager as unknown as { pingAll: () => Promise<void> }).pingAll();

    const health = manager.getHealth()["ws-abc"];
    expect(fetchMock).not.toHaveBeenCalled();
    expect(registry.getWorkspaceMeta("ws-abc")).toBeNull();
    expect(health.status).toBe("recently-disconnected");
    expect(health.activeConnectionCount).toBe(0);
    expect(health.lastDisconnectedAt).toBeTruthy();
    expect(JSON.stringify(health)).not.toContain("test-token");
    expect(JSON.stringify(health)).not.toContain("https://coder.example.com");
  });

  it("expires recently-disconnected health records by TTL", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    registry.addConnection("ws-abc", "conn-1", testMeta);
    await manager.ping("ws-abc");
    registry.removeConnection("ws-abc", "conn-1");

    expect(manager.getHealth()["ws-abc"]?.status).toBe("recently-disconnected");

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

    expect(manager.getHealth()["ws-abc"]).toBeUndefined();
  });

  it("bounds recently-disconnected health records", () => {
    for (let i = 0; i < 105; i++) {
      const workspaceId = `ws-${i}`;
      registry.addConnection(workspaceId, `conn-${i}`, testMeta);
      registry.removeConnection(workspaceId, `conn-${i}`);
    }

    const health = manager.getHealth();
    expect(Object.keys(health)).toHaveLength(100);
    expect(health["ws-0"]).toBeUndefined();
    expect(health["ws-104"]?.status).toBe("recently-disconnected");
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
    registry.addConnection("ws-abc", "conn-1", {
      token: "t",
      coderUrl: "https://custom-coder.example.com",
    });

    await manager.ping("ws-abc");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://custom-coder.example.com/api/v2/workspaces/ws-abc/extend");
  });
});
