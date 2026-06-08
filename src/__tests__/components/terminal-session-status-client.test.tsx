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
  RefreshCw: () => <span data-testid="refresh-icon" />,
}));

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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
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
              lastFailureDetail:
                "Coder reports workspace shutdown is manual; keepalive extension is not applicable.",
              lastHttpStatus: 409,
              lastHttpStatusText: "Conflict",
              lastAttemptDurationMs: 15,
              activeConnectionCount: 1,
              lastDisconnectedAt: null,
            },
          },
        }),
        { status: 200 },
      ),
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
  });
});
