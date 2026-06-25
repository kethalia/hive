// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockKeepAliveStatus = vi.hoisted(() => ({
  consecutiveFailures: 0,
  lastSuccess: null,
  lastFailure: null,
  isLoading: false,
}));

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = ({
      sessionName,
      agentId,
      workspaceId,
      onConnectionStateChange,
    }: {
      sessionName: string;
      agentId: string;
      workspaceId: string;
      className?: string;
      onConnectionStateChange?: (state: string) => void;
    }) => (
      <div
        data-testid={`terminal-${sessionName}`}
        data-agent-id={agentId}
        data-workspace-id={workspaceId}
        data-has-conn-callback={String(!!onConnectionStateChange)}
      >
        Terminal: {sessionName}
      </div>
    );
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

const mockCreateSession = vi.fn();
const mockRenameSession = vi.fn();
const mockKillSession = vi.fn();
const mockGetSessions = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  renameSessionAction: (...args: unknown[]) => mockRenameSession(...args),
  killSessionAction: (...args: unknown[]) => mockKillSession(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetSessions(...args),
}));

vi.mock("@/hooks/useKeepAliveStatus", () => ({
  useKeepAliveStatus: () => mockKeepAliveStatus,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.PropsWithChildren<{
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    "data-testid"?: string;
  }>) => (
    <button onClick={onClick} disabled={disabled} data-testid={rest["data-testid"]}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (
    props: React.InputHTMLAttributes<HTMLInputElement> & {
      "data-testid"?: string;
    },
  ) => <input {...props} data-testid={props["data-testid"]} />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
    className,
  }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <span data-testid="connection-badge" data-variant={variant} className={className}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children, variant }: React.PropsWithChildren<{ variant?: string }>) => (
    <div data-testid="alert" data-variant={variant}>
      {children}
    </div>
  ),
  AlertTitle: ({ children }: React.PropsWithChildren) => (
    <div data-testid="alert-title">{children}</div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren) => (
    <div data-testid="alert-description">{children}</div>
  ),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

vi.mock("lucide-react", () => ({
  Code2: () => <span data-testid="icon-code" />,
  ExternalLink: () => <span data-testid="icon-external-link" />,
  X: () => <span data-testid="icon-x">×</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
  Pencil: () => <span data-testid="icon-pencil">✎</span>,
  AlertCircle: () => <span data-testid="icon-alert">⚠</span>,
  Terminal: () => <span data-testid="icon-terminal" />,
  Copy: () => <span data-testid="icon-copy" />,
  ClipboardPaste: () => <span data-testid="icon-paste" />,
  Send: () => <span data-testid="icon-send" />,
  XIcon: () => <span data-testid="icon-x-2">×</span>,
}));

import { TerminalTabManager } from "@/components/workspaces/TerminalTabManager";

const defaultProps = {
  agentId: "agent-1",
  workspaceId: "ws-1",
};

describe("TerminalTabManager regression — M006 coexistence", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", {
      randomUUID: () => `uuid-${Math.random()}`,
    });
    Object.assign(mockKeepAliveStatus, {
      consecutiveFailures: 0,
      lastSuccess: null,
      lastFailure: null,
      isLoading: false,
    });
  });

  describe("Session CRUD with M006 components present", () => {
    it("loads existing sessions and renders InteractiveTerminal stubs", async () => {
      mockGetSessions.mockResolvedValue({
        data: [
          { name: "main-session", created: 1000, windows: 1 },
          { name: "dev-session", created: 2000, windows: 1 },
        ],
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(2);
        expect(labels[0]).toHaveTextContent("main-session");
        expect(labels[1]).toHaveTextContent("dev-session");
      });

      expect(screen.getByTestId("terminal-main-session")).toBeInTheDocument();
      expect(mockGetSessions).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });

    it("creates a new tab via createSessionAction", async () => {
      mockGetSessions.mockResolvedValue({
        data: [{ name: "main-session", created: 1000, windows: 1 }],
      });
      mockCreateSession.mockResolvedValue({
        data: { name: "new-session" },
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("main-session");
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("add-tab-button"));
      });

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(2);
        expect(labels[1]).toHaveTextContent("new-session");
      });

      expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });

    it("renames a tab via renameSessionAction", async () => {
      mockGetSessions.mockResolvedValue({
        data: [{ name: "main-session", created: 1000, windows: 1 }],
      });
      mockRenameSession.mockResolvedValue({
        data: { oldName: "main-session", newName: "renamed-tab" },
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("main-session");
      });

      fireEvent.click(screen.getByTestId("rename-tab"));

      const input = screen.getByTestId("rename-input");
      fireEvent.change(input, { target: { value: "renamed-tab" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(mockRenameSession).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          oldName: "main-session",
          newName: "renamed-tab",
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("renamed-tab");
      });
    });

    it("kills a tab via killSessionAction", async () => {
      mockGetSessions.mockResolvedValue({
        data: [
          { name: "main-session", created: 1000, windows: 1 },
          { name: "second-session", created: 2000, windows: 1 },
        ],
      });
      mockKillSession.mockResolvedValue({
        data: { name: "main-session" },
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId("tab-label")).toHaveLength(2);
      });

      const killButtons = screen.getAllByTestId("close-tab");
      await act(async () => {
        fireEvent.click(killButtons[0]);
      });

      await waitFor(() => {
        expect(mockKillSession).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          sessionName: "main-session",
        });
      });

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(1);
        expect(labels[0]).toHaveTextContent("second-session");
      });
    });
  });

  describe("Tab switching preserves M006 state", () => {
    it("renders correct InteractiveTerminal instances with session props and uses display:none for inactive tabs", async () => {
      mockGetSessions.mockResolvedValue({
        data: [
          { name: "tab-a", created: 1000, windows: 1 },
          { name: "tab-b", created: 2000, windows: 1 },
        ],
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId("tab-label")).toHaveLength(2);
      });

      const termA = screen.getByTestId("terminal-tab-a");
      const termB = screen.getByTestId("terminal-tab-b");

      expect(termA).toBeInTheDocument();
      expect(termB).toBeInTheDocument();
      expect(termA).toHaveAttribute("data-agent-id", "agent-1");
      expect(termA).toHaveAttribute("data-workspace-id", "ws-1");
      expect(termA).toHaveAttribute("data-has-conn-callback", "true");

      const containerA = termA.parentElement!;
      const containerB = termB.parentElement!;

      expect(containerA.style.display).toBe("block");
      expect(containerB.style.display).toBe("none");

      const labels = screen.getAllByTestId("tab-label");
      fireEvent.click(labels[1].closest("button")!);

      await waitFor(() => {
        expect(containerA.style.display).toBe("none");
        expect(containerB.style.display).toBe("block");
      });
    });
  });

  describe("KeepAliveWarning integration", () => {
    it("shows KeepAliveWarning banner when consecutiveFailures >= 3", async () => {
      mockKeepAliveStatus.consecutiveFailures = 3;
      mockGetSessions.mockResolvedValue({
        data: [{ name: "main-session", created: 1000, windows: 1 }],
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toBeInTheDocument();
      });

      expect(screen.getByTestId("alert")).toBeInTheDocument();
      expect(screen.getByTestId("alert-title")).toHaveTextContent("Keep-alive failure");
      expect(screen.getByTestId("alert-description")).toHaveTextContent("3 consecutive failures");
    });

    it("hides KeepAliveWarning banner when consecutiveFailures < 3", async () => {
      mockKeepAliveStatus.consecutiveFailures = 0;
      mockGetSessions.mockResolvedValue({
        data: [{ name: "main-session", created: 1000, windows: 1 }],
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("alert")).not.toBeInTheDocument();
    });
  });

  describe("Refresh during transient ssh failure", () => {
    it("does NOT auto-create a phantom session when getWorkspaceSessionsAction fails", async () => {
      // Reproduces the bug: on refresh, the first sessions fetch can fail
      // transiently (ssh not yet reachable). The component previously treated
      // an empty/errored response identically to "user has zero sessions" and
      // called createSessionAction, allocating a fresh session-<ts> name that
      // hid the real tmux sessions still alive on the workspace.
      mockGetSessions.mockResolvedValue({
        serverError: "Failed to list tmux sessions (exit 255): Connection refused",
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("session-load-error")).toBeInTheDocument();
      });

      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(screen.queryByTestId("tab-label")).not.toBeInTheDocument();
      expect(screen.getByTestId("retry-load-sessions")).toBeInTheDocument();
    });

    it("DOES auto-create exactly one session when the workspace truly has zero", async () => {
      mockGetSessions.mockResolvedValue({ data: [] });
      mockCreateSession.mockResolvedValue({ data: { name: "session-12345" } });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("session-12345");
      });

      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
  });

  describe("ReconnectId cleanup on kill", () => {
    it("removes reconnectId from localStorage when a session tab is killed", async () => {
      mockGetSessions.mockResolvedValue({
        data: [
          { name: "my-session", created: 1000, windows: 1 },
          { name: "other-session", created: 2000, windows: 1 },
        ],
      });
      mockKillSession.mockResolvedValue({
        data: { name: "my-session" },
      });

      const reconnectKey = "terminal:reconnect:agent-1:my-session";
      const otherKey = "terminal:reconnect:agent-1:other-session";
      window.localStorage.setItem(reconnectKey, "reconnect-uuid-123");
      window.localStorage.setItem(otherKey, "reconnect-uuid-456");

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId("tab-label")).toHaveLength(2);
      });

      expect(window.localStorage.getItem(reconnectKey)).toBe("reconnect-uuid-123");

      const killButtons = screen.getAllByTestId("close-tab");
      await act(async () => {
        fireEvent.click(killButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getAllByTestId("tab-label")).toHaveLength(1);
      });

      expect(window.localStorage.getItem(reconnectKey)).toBeNull();
      expect(window.localStorage.getItem(otherKey)).toBe("reconnect-uuid-456");
    });
  });
});
