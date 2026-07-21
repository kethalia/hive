// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TerminalSessionStatusClient } from "@/components/workspaces/TerminalSessionStatusClient";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
  }: React.PropsWithChildren<{ href: string; className?: string }>) => (
    <a className={className} href={href}>
      {children}
    </a>
  ),
}));

vi.mock("lucide-react", () => ({
  Pause: () => <span data-testid="pause-icon" />,
  Play: () => <span data-testid="play-icon" />,
  RefreshCw: () => <span data-testid="refresh-icon" />,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-testid="dashboard-page-sidebar-trigger">
      Toggle sidebar
    </button>
  ),
}));

function sessionEventsResponse() {
  return new Response(
    JSON.stringify({
      version: 1,
      instanceId: "proxy-instance-1",
      startedAt: "2026-07-21T08:00:00.000Z",
      generatedAt: "2026-07-21T08:00:01.000Z",
      events: [
        {
          id: 1,
          timestamp: "2026-07-21T08:00:01.000Z",
          workspaceId: "workspace-1",
          connectionId: "connection-1",
          sessionName: "git-session",
          sessionKind: "git",
          level: "info",
          type: "upstream_connected",
          details: {},
        },
      ],
    }),
    { status: 200 },
  );
}

function keepAliveStatusResponse() {
  return new Response(
    JSON.stringify({
      workspaces: {
        "workspace-1": {
          status: "failing",
          consecutiveFailures: 3,
          lastAttempt: "2026-06-07T19:00:00.000Z",
          lastSuccess: null,
          lastFailure: "2026-06-07T19:01:00.000Z",
          lastFailureCategory: "http-server",
          lastFailureReason: "coder-server-error",
          lastFailureDetail: "HTTP 500: Coder failed while extending the workspace.",
          lastHttpStatus: 500,
          lastHttpStatusText: "Internal Server Error",
          lastAttemptDurationMs: 42,
          activeConnectionCount: 2,
          lastDisconnectedAt: null,
        },
        "workspace-2": {
          status: "not-applicable",
          consecutiveFailures: 0,
          lastAttempt: "2026-06-07T19:02:00.000Z",
          lastSuccess: null,
          lastFailure: "2026-06-07T19:02:00.000Z",
          lastFailureCategory: "manual-shutdown",
          lastFailureReason: "manual-shutdown",
          lastFailureDetail: "Coder reports manual shutdown; keepalive is not applicable.",
          lastHttpStatus: 409,
          lastHttpStatusText: "Conflict",
          lastAttemptDurationMs: 15,
          activeConnectionCount: 1,
          lastDisconnectedAt: null,
        },
      },
    }),
    { status: 200 },
  );
}

function expectDiagnosticsLayout() {
  const pageShell = document.querySelector("[data-dashboard-page-shell]");
  expect(pageShell).toHaveClass(
    "h-full",
    "min-h-0",
    "w-full",
    "flex-1",
    "touch-pan-y",
    "overflow-y-auto",
    "overscroll-y-contain",
    "[-webkit-overflow-scrolling:touch]",
  );
  expect(pageShell).not.toHaveClass("max-w-5xl", "mx-auto");
  expect(screen.getByText("Terminal diagnostics").parentElement).toHaveClass("hidden", "sm:block");
}

describe("TerminalSessionStatusClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.__HIVE_CONFIG__ = { terminalWsUrl: "wss://terminal.example.test" };
  });

  afterEach(() => {
    cleanup();
    delete window.__HIVE_CONFIG__;
  });

  it("fetches authenticated aggregate status rows and highlights the requested workspace", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/session-events")
          ? sessionEventsResponse()
          : keepAliveStatusResponse(),
      );

    render(<TerminalSessionStatusClient highlightedWorkspaceId="workspace-1" />);

    await waitFor(() =>
      expect(screen.getByText("Authorized terminal session rows")).toBeInTheDocument(),
    );

    expect(fetchMock).toHaveBeenCalledWith("https://terminal.example.test/keepalive/status", {
      cache: "no-store",
      credentials: "include",
    });
    expect(screen.getByText("Workspace rows").parentElement).toHaveTextContent("2");
    expect(screen.getAllByText("Active terminal connections")[0].parentElement).toHaveTextContent(
      "3",
    );
    expect(screen.getByText("Failing rows").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Highlighted workspace")).toBeInTheDocument();
    expect(screen.getAllByText("workspace-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("workspace-2").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Open terminal" })[0]).toHaveAttribute(
      "href",
      "/workspaces/workspace-1/terminal",
    );
    expectDiagnosticsLayout();
    expect(screen.getByText("Live session events")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("upstream_connected")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://terminal.example.test/session-events?limit=500&workspaceId=workspace-1",
      { cache: "no-store", credentials: "include" },
    );
  });
});
