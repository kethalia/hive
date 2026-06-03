// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";

const mockCreateSession = vi.fn();
const mockGetSessions = vi.fn();
const mockSetActiveTerminal = vi.fn();
const mockCopyTerminalSelection = vi.fn();
const mockPasteToTerminal = vi.fn();
const terminalProps = new Map<
  string,
  {
    agentId: string;
    workspaceId: string;
    sessionName: string;
    onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
    onTerminalDestroy?: () => void;
  }
>();

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<{ InteractiveTerminal: React.ComponentType<any> }>) => {
    void loader;
    const Stub = ({
      agentId,
      workspaceId,
      sessionName,
      onTerminalReady,
      onTerminalDestroy,
    }: {
      agentId: string;
      workspaceId: string;
      sessionName: string;
      onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
      onTerminalDestroy?: () => void;
    }) => {
      terminalProps.set(sessionName, {
        agentId,
        workspaceId,
        sessionName,
        onTerminalReady,
        onTerminalDestroy,
      });
      return (
        <div
          data-testid={`interactive-terminal-${sessionName}`}
          data-agent-id={agentId}
          data-workspace-id={workspaceId}
          data-session-name={sessionName}
        >
          Terminal: {sessionName}
        </div>
      );
    };
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetSessions(...args),
}));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: (): Partial<KeybindingContextValue> => ({
    setActiveTerminal: mockSetActiveTerminal,
  }),
}));

vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: (...args: unknown[]) => mockCopyTerminalSelection(...args),
  pasteToTerminal: (...args: unknown[]) => mockPasteToTerminal(...args),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
    ...rest
  }: React.PropsWithChildren<{
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    className?: string;
    variant?: string;
    size?: string;
    "data-testid"?: string;
    "aria-label"?: string;
  }>) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      data-testid={rest["data-testid"]}
      aria-label={rest["aria-label"]}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    variant,
    ...rest
  }: React.PropsWithChildren<{ variant?: string; "data-testid"?: string }>) => (
    <div data-testid={rest["data-testid"] ?? "alert"} data-variant={variant}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  AlertTitle: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  ClipboardPaste: () => <span data-testid="icon-paste" />,
  Copy: () => <span data-testid="icon-copy" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Plus: () => <span data-testid="icon-plus" />,
}));

import { MultiSessionWorkspace } from "@/components/workspaces/MultiSessionWorkspace";

const defaultProps = {
  agentId: "agent-1",
  workspaceId: "ws-1",
};

function makeTerminal(name: string): Terminal {
  return {
    name,
    getSelection: vi.fn(() => `${name}-selection`),
    clearSelection: vi.fn(),
  } as unknown as Terminal;
}

function makeSender(name: string) {
  return vi.fn((data: string) => `${name}:${data}`);
}

describe("MultiSessionWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalProps.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders two or more real panes with InteractiveTerminal props and active diagnostics", async () => {
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
      ],
    });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("2");
    });

    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-agent-id",
      "agent-1",
    );
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveAttribute(
      "data-workspace-id",
      "ws-1",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(terminalProps.get("main-session")?.sessionName).toBe("main-session");
    expect(terminalProps.get("dev-server")?.sessionName).toBe("dev-server");
  });

  it("floats and tiles a pane while persisting only redacted layout metadata", async () => {
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
      ],
    });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("float-pane-pane-main-session"));
    });

    expect(screen.getByTestId("floating-pane-layer")).toContainElement(
      screen.getByTestId("workspace-pane-main-session"),
    );
    expect(screen.getByTestId("tile-pane-pane-main-session")).toHaveAccessibleName(
      "Tile main-session",
    );
    expect(localStorage.getItem("multi-session-layout:ws-1")).toMatchInlineSnapshot(
      `"{"version":1,"activeSessionName":"main-session","panes":[{"sessionName":"main-session","mode":"floating","order":0,"geometry":{"x":24,"y":24,"width":720,"height":420,"zIndex":100}},{"sessionName":"dev-server","mode":"tiled","order":1}]}"`,
    );
    expect(localStorage.getItem("multi-session-layout:ws-1")).not.toMatch(
      /clipboard|terminalBuffer|selection|secret|cwd/i,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("tile-pane-pane-main-session"));
    });

    expect(screen.getByTestId("multi-session-grid")).toContainElement(
      screen.getByTestId("workspace-pane-main-session"),
    );
    expect(localStorage.getItem("multi-session-layout:ws-1")).toContain(
      '"sessionName":"main-session","mode":"tiled"',
    );
  });

  it("restores, repairs, and redacts stale or out-of-bounds stored layouts", async () => {
    window.localStorage.setItem(
      "multi-session-layout:ws-1",
      JSON.stringify({
        version: 1,
        activeSessionName: "dev-server",
        panes: [
          {
            sessionName: "stale-secret-session",
            mode: "floating",
            geometry: { x: 1, y: 1, width: 400, height: 300, zIndex: 120 },
            terminalBuffer: "do-not-render",
          },
          {
            sessionName: "dev-server",
            mode: "floating",
            geometry: { x: -999, y: -999, width: 10, height: 9999, zIndex: -1 },
            clipboard: "secret clipboard",
          },
        ],
      }),
    );
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
        { name: "new-session", created: 3, windows: 1 },
      ],
    });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    });

    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveAttribute(
      "data-pane-mode",
      "floating",
    );
    expect(screen.getByTestId("workspace-pane-new-session")).toHaveAttribute(
      "data-pane-mode",
      "tiled",
    );
    expect(screen.getByTestId("layout-persistence-status")).toHaveAttribute(
      "data-layout-codes",
      expect.stringContaining("stale-pane-dropped"),
    );
    expect(screen.getByTestId("layout-persistence-status")).toHaveAttribute(
      "data-layout-codes",
      expect.stringContaining("pane-geometry-repaired"),
    );
    expect(
      screen.queryByText(/stale-secret-session|secret clipboard|do-not-render/i),
    ).not.toBeInTheDocument();
  });

  it("recovers from corrupt layout storage and reset clears the stored layout", async () => {
    window.localStorage.setItem("multi-session-layout:ws-1", "{not-json with secret path /tmp/x");
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
      ],
    });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("layout-persistence-status")).toHaveTextContent(
        "Stored pane layout could not be read.",
      );
    });

    expect(screen.getByTestId("workspace-pane-main-session")).toHaveAttribute(
      "data-pane-mode",
      "tiled",
    );
    expect(screen.getByTestId("interactive-terminal-main-session")).toBeInTheDocument();
    expect(screen.queryByText(/secret path|not-json/i)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("reset-layout"));
    });

    expect(window.localStorage.getItem("multi-session-layout:ws-1")).toBeNull();
    expect(screen.queryByTestId("layout-persistence-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveAttribute(
      "data-pane-mode",
      "tiled",
    );
  });

  it("keeps panes mounted and redacts diagnostics when layout storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied secret path");
    });
    mockGetSessions.mockResolvedValue({ data: [{ name: "main-session", created: 1, windows: 1 }] });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("layout-persistence-status")).toHaveTextContent(
        "Layout persistence is unavailable.",
      );
    });

    expect(screen.getByTestId("interactive-terminal-main-session")).toBeInTheDocument();
    expect(screen.queryByText(/denied secret path/i)).not.toBeInTheDocument();
  });

  it("keeps committed layout changes in view when localStorage writes fail", async () => {
    mockGetSessions.mockResolvedValue({ data: [{ name: "main-session", created: 1, windows: 1 }] });
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("disk full with secret");
    });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("float-pane-pane-main-session"));
    });

    expect(setSpy).toHaveBeenCalledWith(
      "multi-session-layout:ws-1",
      expect.stringContaining('"mode":"floating"'),
    );
    expect(screen.getByTestId("workspace-pane-main-session")).toHaveAttribute(
      "data-pane-mode",
      "floating",
    );
    expect(screen.getByTestId("layout-persistence-status")).toHaveTextContent(
      "could not be saved locally",
    );
    expect(screen.queryByText(/disk full|secret/i)).not.toBeInTheDocument();
  });

  it("creates, appends, and selects a new session from the accessible create control", async () => {
    mockGetSessions.mockResolvedValue({ data: [{ name: "main-session", created: 1, windows: 1 }] });
    mockCreateSession.mockResolvedValue({ data: { name: "new-session" } });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-session-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("2");
    });

    expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(screen.getByTestId("interactive-terminal-new-session")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("new-session");
  });

  it("moves active ownership only when the selected pane is ready", async () => {
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
      ],
    });
    const mainTerm = makeTerminal("main-session");
    const devTerm = makeTerminal("dev-server");
    const mainSend = makeSender("main-session");
    const devSend = makeSender("dev-server");

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(terminalProps.has("main-session")).toBe(true);
      expect(terminalProps.has("dev-server")).toBe(true);
    });

    await act(async () => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });
    expect(mockSetActiveTerminal).not.toHaveBeenCalledWith(devTerm, devSend);

    await act(async () => {
      terminalProps.get("main-session")?.onTerminalReady?.(mainTerm, mainSend);
    });
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(mainTerm, mainSend);

    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-pane-dev-server"));
    });
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(devTerm, devSend);

    await act(async () => {
      terminalProps.get("dev-server")?.onTerminalDestroy?.();
    });
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(null, null);
  });

  it("does not set a stale sender when selecting a pane before terminal readiness", async () => {
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "ready-session", created: 1, windows: 1 },
        { name: "cold-session", created: 2, windows: 1 },
      ],
    });
    const readyTerm = makeTerminal("ready-session");
    const readySend = makeSender("ready-session");

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(terminalProps.has("ready-session")).toBe(true);
    });

    await act(async () => {
      terminalProps.get("ready-session")?.onTerminalReady?.(readyTerm, readySend);
    });
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(readyTerm, readySend);

    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-pane-cold-session"));
    });

    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(null, null);
  });

  it("copy and paste target only the active pane", async () => {
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
      ],
    });
    const mainTerm = makeTerminal("main-session");
    const devTerm = makeTerminal("dev-server");
    const mainSend = makeSender("main-session");
    const devSend = makeSender("dev-server");

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(terminalProps.has("main-session")).toBe(true);
      expect(terminalProps.has("dev-server")).toBe(true);
    });

    await act(async () => {
      terminalProps.get("main-session")?.onTerminalReady?.(mainTerm, mainSend);
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
      fireEvent.click(screen.getByTestId("workspace-pane-dev-server"));
    });

    fireEvent.click(screen.getByTestId("copy-active-pane"));
    fireEvent.click(screen.getByTestId("paste-active-pane"));

    expect(mockCopyTerminalSelection).toHaveBeenCalledWith(devTerm, expect.any(Object));
    expect(mockPasteToTerminal).toHaveBeenCalledWith(devTerm, devSend, expect.any(Object));
    expect(mockCopyTerminalSelection).not.toHaveBeenCalledWith(mainTerm, expect.anything());
    expect(mockPasteToTerminal).not.toHaveBeenCalledWith(mainTerm, mainSend, expect.anything());
  });

  it("shows inspectable empty, load error, and create error states without mounting stale terminals", async () => {
    mockGetSessions.mockResolvedValueOnce({ data: [] });
    mockCreateSession.mockResolvedValueOnce({ serverError: "creation failed with secret path" });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("multi-session-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId(/^interactive-terminal-/)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-empty-session-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("session-create-error")).toHaveTextContent(
        "Could not create a terminal session.",
      );
    });
    expect(screen.queryByText(/secret path/i)).not.toBeInTheDocument();

    cleanup();
    terminalProps.clear();
    mockGetSessions.mockResolvedValueOnce({ serverError: "workspace refused ssh" });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("session-load-error")).toHaveTextContent(
        "Could not load terminal sessions.",
      );
    });
    expect(screen.getByTestId("retry-load-sessions")).toBeInTheDocument();
    expect(screen.queryByTestId(/^interactive-terminal-/)).not.toBeInTheDocument();
  });
});
