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
    layoutSignal?: unknown;
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
      layoutSignal,
      onTerminalReady,
      onTerminalDestroy,
    }: {
      agentId: string;
      workspaceId: string;
      sessionName: string;
      layoutSignal?: unknown;
      onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
      onTerminalDestroy?: () => void;
    }) => {
      terminalProps.set(sessionName, {
        agentId,
        workspaceId,
        sessionName,
        layoutSignal,
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

function twoSessionPayload() {
  return {
    data: [
      { name: "main-session", created: 1, windows: 1 },
      { name: "dev-server", created: 2, windows: 1 },
    ],
  };
}

async function renderTwoSessionWorkspace() {
  mockGetSessions.mockResolvedValue(twoSessionPayload());
  render(<MultiSessionWorkspace {...defaultProps} />);

  await waitFor(() => {
    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
  });
}

async function floatPane(sessionName: string) {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`float-pane-pane-${sessionName}`));
  });
}

function pointerDown(element: HTMLElement, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent.pointerDown(element, {
    pointerId: 7,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...init,
  });
}

function pointerMove(element: HTMLElement, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent.pointerMove(element, {
    pointerId: 7,
    pointerType: "mouse",
    buttons: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...init,
  });
}

function pointerUp(element: HTMLElement, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent.pointerUp(element, {
    pointerId: 7,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...init,
  });
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

  it("drags a floating pane from its chrome handle, clamps it in bounds, raises it, and keeps refit signals stable until commit", async () => {
    await renderTwoSessionWorkspace();
    await floatPane("main-session");
    await floatPane("dev-server");

    const pane = screen.getByTestId("workspace-pane-main-session");
    const devPane = screen.getByTestId("workspace-pane-dev-server");
    const handle = screen.getByTestId("drag-handle-pane-main-session");
    const initialLayoutSignal = terminalProps.get("main-session")?.layoutSignal;

    await act(async () => {
      pointerDown(handle, 100, 100);
      pointerMove(pane, 2000, 2000);
    });

    expect(pane).toHaveStyle({ left: "304px", top: "348px" });
    expect(Number(pane.style.zIndex)).toBeGreaterThan(Number(devPane.style.zIndex));
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(terminalProps.get("main-session")?.layoutSignal).toBe(initialLayoutSignal);

    await act(async () => {
      pointerUp(pane, 2000, 2000);
    });

    expect(pane).toHaveStyle({ left: "304px", top: "348px" });
    expect(localStorage.getItem("multi-session-layout:ws-1")).toContain(
      '"geometry":{"x":304,"y":348,"width":720,"height":420',
    );
    expect(terminalProps.get("main-session")?.layoutSignal).toBe(initialLayoutSignal);
  });

  it("resizes from an explicit handle, clamps below minimum size, and keeps active copy and paste ownership", async () => {
    await renderTwoSessionWorkspace();
    await floatPane("main-session");
    const mainTerm = makeTerminal("main-session");
    const mainSend = makeSender("main-session");
    const devTerm = makeTerminal("dev-server");
    const devSend = makeSender("dev-server");

    await act(async () => {
      terminalProps.get("main-session")?.onTerminalReady?.(mainTerm, mainSend);
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });

    const pane = screen.getByTestId("workspace-pane-main-session");
    const resizeHandle = screen.getByTestId("resize-handle-pane-main-session");

    await act(async () => {
      pointerDown(resizeHandle, 744, 444);
      pointerMove(pane, -1000, -1000);
      pointerUp(pane, -1000, -1000);
    });

    expect(pane).toHaveStyle({ width: "320px", height: "220px" });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");

    fireEvent.click(screen.getByTestId("copy-active-pane"));
    fireEvent.click(screen.getByTestId("paste-active-pane"));

    expect(mockCopyTerminalSelection).toHaveBeenCalledWith(mainTerm, expect.any(Object));
    expect(mockPasteToTerminal).toHaveBeenCalledWith(mainTerm, mainSend, expect.any(Object));
    expect(mockCopyTerminalSelection).not.toHaveBeenCalledWith(devTerm, expect.anything());
    expect(mockPasteToTerminal).not.toHaveBeenCalledWith(devTerm, devSend, expect.anything());
  });

  it("commits reachable geometry on pointer cancel and lost capture", async () => {
    await renderTwoSessionWorkspace();
    await floatPane("main-session");
    const pane = screen.getByTestId("workspace-pane-main-session");
    const handle = screen.getByTestId("drag-handle-pane-main-session");
    const resizeHandle = screen.getByTestId("resize-handle-pane-main-session");

    await act(async () => {
      pointerDown(handle, 100, 100);
      pointerMove(pane, 180, 160);
      fireEvent.pointerCancel(pane, {
        pointerId: 7,
        pointerType: "mouse",
        clientX: 180,
        clientY: 160,
        isPrimary: true,
      });
    });

    expect(pane).toHaveStyle({ left: "104px", top: "84px" });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");

    await act(async () => {
      pointerDown(resizeHandle, 824, 504);
      pointerMove(pane, 844, 524);
      fireEvent.lostPointerCapture(pane, {
        pointerId: 7,
        pointerType: "mouse",
        clientX: 844,
        clientY: 524,
        isPrimary: true,
      });
    });

    expect(pane).toHaveStyle({ width: "740px", height: "440px" });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
  });

  it("ignores terminal body, secondary pointer, editable target, and missing container measurements", async () => {
    await renderTwoSessionWorkspace();
    await floatPane("main-session");
    const pane = screen.getByTestId("workspace-pane-main-session");
    const terminalBody = screen.getByTestId("interactive-terminal-main-session");
    const handle = screen.getByTestId("drag-handle-pane-main-session");

    await act(async () => {
      pointerDown(terminalBody, 100, 100);
      pointerMove(pane, 300, 300);
      pointerUp(pane, 300, 300);
    });
    expect(pane).toHaveStyle({ left: "24px", top: "24px" });

    await act(async () => {
      pointerDown(handle, 100, 100, { pointerId: 8, isPrimary: false });
      pointerMove(pane, 300, 300, { pointerId: 8, isPrimary: false });
      pointerUp(pane, 300, 300, { pointerId: 8, isPrimary: false });
    });
    expect(pane).toHaveStyle({ left: "24px", top: "24px" });

    const editableTarget = document.createElement("input");
    handle.appendChild(editableTarget);
    await act(async () => {
      pointerDown(editableTarget, 100, 100);
      pointerMove(pane, 300, 300);
      pointerUp(pane, 300, 300);
    });
    expect(pane).toHaveStyle({ left: "24px", top: "24px" });
    editableTarget.remove();

    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 0 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 0 });
    vi.spyOn(pane.parentElement?.parentElement ?? pane, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-pane-pane-dev-server"));
      pointerDown(handle, 100, 100);
      pointerMove(pane, 300, 300);
      pointerUp(pane, 300, 300);
    });

    expect(pane).toHaveStyle({ left: "24px", top: "24px" });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
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
