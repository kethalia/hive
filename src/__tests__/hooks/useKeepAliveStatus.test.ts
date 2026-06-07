// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeepAliveStatus } from "@/hooks/useKeepAliveStatus";

describe("useKeepAliveStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.__HIVE_CONFIG__ = { terminalWsUrl: "ws://terminal-proxy.example.test/socket" };
  });

  afterEach(() => {
    cleanup();
    delete window.__HIVE_CONFIG__;
  });

  async function renderLoadedStatus(workspaceId = "workspace-1") {
    const rendered = renderHook(() => useKeepAliveStatus(workspaceId));
    await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
    return rendered;
  }

  it("parses S03 keepalive health fields for the requested workspace", async () => {
    const payload = {
      workspaces: {
        "workspace-1": {
          status: "recently-disconnected",
          consecutiveFailures: 2,
          lastAttempt: "2026-06-07T19:00:00.000Z",
          lastSuccess: "2026-06-07T18:59:00.000Z",
          lastFailure: "2026-06-07T19:01:00.000Z",
          lastFailureCategory: "timeout",
          activeConnectionCount: 0,
          lastDisconnectedAt: "2026-06-07T19:02:00.000Z",
        },
      },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const { result } = await renderLoadedStatus("workspace-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://terminal-proxy.example.test/socket/keepalive/status",
    );
    expect(result.current).toEqual({
      status: "recently-disconnected",
      consecutiveFailures: 2,
      lastAttempt: "2026-06-07T19:00:00.000Z",
      lastSuccess: "2026-06-07T18:59:00.000Z",
      lastFailure: "2026-06-07T19:01:00.000Z",
      lastFailureCategory: "timeout",
      activeConnectionCount: 0,
      lastDisconnectedAt: "2026-06-07T19:02:00.000Z",
      isLoading: false,
    });
  });

  it("returns safe defaults when the requested workspace is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaces: {
            "other-workspace": {
              status: "failing",
              consecutiveFailures: 8,
              lastFailureCategory: "http-server",
            },
          },
        }),
        { status: 200 },
      ),
    );

    const { result } = await renderLoadedStatus("workspace-1");

    expect(result.current).toEqual({
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      activeConnectionCount: 0,
      lastDisconnectedAt: null,
      isLoading: false,
    });
  });

  it("drops unknown statuses, categories, counts, and raw timestamp-like material", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaces: {
            "workspace-1": {
              status: "token=super-secret-status",
              consecutiveFailures: "7",
              lastAttempt: "/home/coder/projects/private-token",
              lastSuccess: "https://proxy.example.test/session?token=secret",
              lastFailure: "Bearer raw-token-value",
              lastFailureCategory: "proxy-url-leak",
              activeConnectionCount: -3,
              lastDisconnectedAt: "workspace-name-with-token",
            },
          },
        }),
        { status: 200 },
      ),
    );

    const { result } = await renderLoadedStatus("workspace-1");

    expect(result.current).toEqual({
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      activeConnectionCount: 0,
      lastDisconnectedAt: null,
      isLoading: false,
    });
  });

  it("returns safe defaults for malformed payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ workspaces: "raw-token-not-a-record" }), { status: 200 }),
    );

    const { result } = await renderLoadedStatus("workspace-1");

    expect(result.current.status).toBe("healthy");
    expect(result.current.consecutiveFailures).toBe(0);
    expect(result.current.lastFailureCategory).toBeNull();
    expect(result.current.activeConnectionCount).toBe(0);
  });

  it("does not read or expose non-OK response bodies", async () => {
    const json = vi.fn(async () => ({ token: "raw-response-body" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, json } as unknown as Response);

    const { result } = await renderLoadedStatus("workspace-1");

    expect(json).not.toHaveBeenCalled();
    expect(result.current).toEqual({
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      activeConnectionCount: 0,
      lastDisconnectedAt: null,
      isLoading: false,
    });
  });

  it("keeps failed fetches non-destructive and secret-free", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("token=secret /home/coder/projects/private raw proxy failure"),
    );

    const { result } = await renderLoadedStatus("workspace-1");

    expect(result.current).toEqual({
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      activeConnectionCount: 0,
      lastDisconnectedAt: null,
      isLoading: false,
    });
  });
});
