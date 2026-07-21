// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TerminalSessionEventLog } from "@/components/workspaces/TerminalSessionEventLog";

vi.mock("lucide-react", () => ({
  Pause: () => <span />,
  Play: () => <span />,
  RefreshCw: () => <span />,
}));

function eventResponse(workspaceId: string, sessionName: string, type: string, id = 1) {
  return new Response(
    JSON.stringify({
      version: 1,
      instanceId: "proxy-instance-1",
      startedAt: "2026-07-21T08:00:00.000Z",
      generatedAt: "2026-07-21T08:00:01.000Z",
      events: [
        {
          id,
          timestamp: "2026-07-21T08:00:01.000Z",
          workspaceId,
          connectionId: `${workspaceId}-connection`,
          sessionName,
          sessionKind: "terminal",
          level: "info",
          type,
          details: {},
        },
      ],
    }),
    { status: 200 },
  );
}

describe("TerminalSessionEventLog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.__HIVE_CONFIG__ = { terminalWsUrl: "wss://terminal.example.test" };
  });

  afterEach(() => {
    cleanup();
    delete window.__HIVE_CONFIG__;
  });

  it("requests server-side session filtering", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(eventResponse("workspace-1", "terminal-1", "upstream_connected"));

    render(<TerminalSessionEventLog workspaceId="workspace-1" sessionName="terminal-1" />);

    await waitFor(() => expect(screen.getByText("upstream_connected")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://terminal.example.test/session-events?limit=500&workspaceId=workspace-1&sessionName=terminal-1",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    );
  });

  it("ignores a stale response after the workspace and session change", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(eventResponse("workspace-new", "session-new", "upstream_connected"));

    const view = render(
      <TerminalSessionEventLog workspaceId="workspace-old" sessionName="session-old" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(
      <TerminalSessionEventLog workspaceId="workspace-new" sessionName="session-new" />,
    );
    await waitFor(() => expect(screen.getByText("upstream_connected")).toBeInTheDocument());

    resolveOld?.(eventResponse("workspace-old", "session-old", "browser_error", 99));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("browser_error")).not.toBeInTheDocument();
    expect(screen.getByText("session=session-new")).toBeInTheDocument();
  });

  it("does not overlap one-second polling requests", async () => {
    vi.useFakeTimers();
    let finishInitial: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      finishInitial = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => pendingResponse);

    render(<TerminalSessionEventLog workspaceId="workspace-1" sessionName="terminal-1" />);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    finishInitial?.(eventResponse("workspace-1", "terminal-1", "upstream_connected"));
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });
});
