import { describe, expect, it } from "vitest";
import { summarizeWorkspacePaneRecovery } from "@/lib/workspaces/workspace-pane-recovery";

describe("summarizeWorkspacePaneRecovery", () => {
  it("summarizes mixed terminal and Git pane recovery with sanitized deterministic fields", () => {
    const status = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["terminal:api", "git:hive"],
      panes: {
        "terminal:api": {
          boardPaneKey: "terminal:api",
          kind: "terminal",
          connectionState: "disconnected",
          recoveryState: {
            phase: "recovering",
            retryCount: 2,
            lastCloseCategory: "transient",
            lastReasonCategory: "upstream-error",
            lastRecoveryAction: "schedule-reconnect",
          },
        },
        "git:hive": {
          boardPaneKey: "git:hive",
          kind: "git",
          connectionState: "connected",
          gitRefreshState: {
            status: "failed",
            failureCategory: "malformed-identity",
          },
        },
      },
    });

    expect(status).toEqual({
      paneCount: 2,
      unhealthyPaneCount: 2,
      severity: "warning",
      phase: "recovering",
      categories: ["git-refresh:malformed-identity", "terminal:upstream-error"],
      message: "Workspace panes are recovering. 2 of 2 visible panes need attention.",
      dataAttributes: {
        "data-workspace-recovery-status": "unhealthy",
        "data-workspace-recovery-pane-count": "2",
        "data-workspace-recovery-unhealthy-pane-count": "2",
        "data-workspace-recovery-severity": "warning",
        "data-workspace-recovery-phase": "recovering",
        "data-workspace-recovery-categories":
          "git-refresh:malformed-identity terminal:upstream-error",
      },
    });
  });

  it("returns no aggregate when visible panes are connected and keepalive is healthy", () => {
    expect(
      summarizeWorkspacePaneRecovery({
        visibleBoardPaneKeys: ["terminal:api", "git:hive"],
        panes: [
          {
            boardPaneKey: "terminal:api",
            connectionState: "connected",
            recoveryState: { phase: "connected", lastRefreshAction: "refresh-succeeded" },
          },
          {
            boardPaneKey: "git:hive",
            connectionState: "connected",
            gitRefreshState: { status: "succeeded" },
          },
        ],
        keepalive: { status: "healthy", consecutiveFailures: 0, lastFailureCategory: null },
      }),
    ).toBeNull();
  });

  it("prunes stale hidden pane keys before counting or surfacing categories", () => {
    const status = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["terminal:visible"],
      panes: {
        "terminal:visible": {
          boardPaneKey: "terminal:visible",
          connectionState: "connected",
          recoveryState: { phase: "connected" },
        },
        "terminal:hidden-secret-session": {
          boardPaneKey: "terminal:hidden-secret-session",
          connectionState: "failed",
          recoveryState: {
            phase: "final-failure",
            failureCategory: "permission-denied",
          },
        },
      },
    });

    expect(status).toBeNull();
  });

  it("consumes keepalive status and categories without requiring unhealthy panes", () => {
    const status = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["terminal:api", "git:hive"],
      panes: [
        { boardPaneKey: "terminal:api", connectionState: "connected" },
        { boardPaneKey: "git:hive", connectionState: "connected" },
      ],
      keepalive: {
        status: "failing",
        consecutiveFailures: 2,
        lastFailureCategory: "http-server",
        activeConnectionCount: 2,
      },
    });

    expect(status).toMatchObject({
      paneCount: 2,
      unhealthyPaneCount: 0,
      severity: "warning",
      phase: "degraded",
      categories: ["keepalive:http-server"],
      message: "Workspace keepalive needs attention.",
    });
    expect(status?.dataAttributes["data-workspace-recovery-categories"]).toBe(
      "keepalive:http-server",
    );
  });

  it("treats recently disconnected and high consecutive keepalive failures as unhealthy", () => {
    const recentlyDisconnected = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["terminal:api"],
      panes: [{ boardPaneKey: "terminal:api", connectionState: "connected" }],
      keepalive: { status: "recently-disconnected", consecutiveFailures: 0 },
    });
    const highFailures = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["terminal:api"],
      panes: [{ boardPaneKey: "terminal:api", connectionState: "connected" }],
      keepalive: { status: "healthy", consecutiveFailures: 3, lastFailureCategory: "network" },
    });

    expect(recentlyDisconnected?.categories).toEqual(["keepalive:recently-disconnected"]);
    expect(recentlyDisconnected?.severity).toBe("warning");
    expect(highFailures?.categories).toEqual(["keepalive:high-failures"]);
    expect(highFailures?.severity).toBe("critical");
  });

  it("ignores malformed recovery fields unless connection state is explicitly unhealthy", () => {
    const malformedHealthy = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["terminal:api"],
      panes: [
        {
          boardPaneKey: "terminal:api",
          connectionState: "connected",
          recoveryState: {
            phase: "raw phase with /home/coder/projects/kethalia/hive and token=abc",
            lastCloseCategory: "https://coder.example.test/raw?token=abc",
            lastReasonCategory: "proxy error /tmp/socket secret terminal payload",
            failureCategory: "clone-proof-raw-secret",
          },
        },
      ],
    });
    const malformedUnhealthy = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["terminal:api"],
      panes: [
        {
          boardPaneKey: "terminal:api",
          connectionState: "failed",
          recoveryState: {
            phase: "not-a-phase",
            lastCloseCategory: "https://coder.example.test/raw?token=abc",
            lastReasonCategory: "proxy error /tmp/socket secret terminal payload",
            failureCategory: "clone-proof-raw-secret",
          },
        },
      ],
    });

    expect(malformedHealthy).toBeNull();
    expect(malformedUnhealthy).toMatchObject({
      severity: "critical",
      phase: "failed",
      categories: ["terminal:unknown"],
    });
  });

  it("ignores unsupported keepalive status values", () => {
    expect(
      summarizeWorkspacePaneRecovery({
        visibleBoardPaneKeys: ["terminal:api"],
        panes: [{ boardPaneKey: "terminal:api", connectionState: "connected" }],
        keepalive: {
          status: "raw-error https://coder.example.test?token=abc",
          consecutiveFailures: 0,
          lastFailureCategory: "secret-proxy-payload",
        },
      }),
    ).toBeNull();
  });

  it("returns no aggregate when there are no visible pane keys", () => {
    expect(
      summarizeWorkspacePaneRecovery({
        visibleBoardPaneKeys: [],
        panes: {
          hidden: {
            boardPaneKey: "hidden",
            connectionState: "workspace-offline",
            recoveryState: { phase: "workspace-offline" },
          },
        },
        keepalive: { status: "failing", consecutiveFailures: 4, lastFailureCategory: "network" },
      }),
    ).toBeNull();
  });

  it("redacts clone proofs, absolute paths, full URLs, raw proxy errors, tokens, sessions, and terminal payloads", () => {
    const status = summarizeWorkspacePaneRecovery({
      visibleBoardPaneKeys: ["git:git-clone:Git/projects/kethalia/hive:kethalia/hive"],
      panes: {
        "git:git-clone:Git/projects/kethalia/hive:kethalia/hive": {
          boardPaneKey: "git:git-clone:Git/projects/kethalia/hive:kethalia/hive",
          kind: "git",
          connectionState: "failed",
          recoveryState: {
            phase: "final-failure",
            lastCloseCategory: "/home/coder/projects/kethalia/hive",
            lastReasonCategory: "https://coder.example.test/api?token=secret-token",
            failureCategory:
              "clone-proof-abc123 raw proxy upstream connect error terminal buffer payload",
          },
          gitRefreshState: {
            status: "failed",
            failureCategory:
              "Bearer abc.def.ghi /Users/alice/projects/repo full terminal contents session-main",
          },
        },
      },
      keepalive: {
        status: "failing",
        consecutiveFailures: 1,
        lastFailureCategory: "network",
      },
    });

    const serialized = JSON.stringify(status);
    expect(status).not.toBeNull();
    expect(serialized).not.toMatch(
      /clone-proof|abc123|secret-token|Bearer|coder\.example|\/home\/coder|\/Users\/alice|terminal buffer|terminal contents|session-main|raw proxy|upstream connect error|git-clone:Git\/projects/,
    );
    expect(status?.categories).toEqual([
      "git-refresh:unknown",
      "keepalive:network",
      "terminal:unknown",
    ]);
  });
});
