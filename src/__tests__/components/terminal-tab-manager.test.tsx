// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = ({ sessionName }: { sessionName: string }) => (
      <div data-testid={`terminal-${sessionName}`}>Terminal: {sessionName}</div>
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

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    onDoubleClick,
    disabled,
    ...rest
  }: React.PropsWithChildren<{
    onClick?: () => void;
    onDoubleClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    title?: string;
    "data-testid"?: string;
  }>) => (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      disabled={disabled}
      data-testid={rest["data-testid"]}
      title={rest.title}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement> & { "data-testid"?: string }) => (
    <input {...props} data-testid={props["data-testid"]} />
  ),
}));

vi.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x">×</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
}));

import { TerminalTabManager } from "@/components/workspaces/TerminalTabManager";

const defaultProps = {
  agentId: "agent-1",
  workspaceId: "ws-1",
};

describe("TerminalTabManager", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => `uuid-${Math.random()}` });
  });

  describe("auto-load sessions on mount", () => {
    it("loads existing sessions as tabs on mount", async () => {
      mockGetSessions.mockResolvedValue({
        data: [
          { name: "hive-main", created: 1000, windows: 1 },
          { name: "dev-server", created: 2000, windows: 1 },
        ],
      });

      render(<TerminalTabManager {...defaultProps} />);

      expect(screen.getByText("Loading sessions…")).toBeInTheDocument();

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(2);
        expect(labels[0]).toHaveTextContent("hive-main");
        expect(labels[1]).toHaveTextContent("dev-server");
      });
    });

    it("creates a session when none exist", async () => {
      mockGetSessions.mockResolvedValue({ data: [] });
      mockCreateSession.mockResolvedValue({ data: { name: "session-123" } });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      });

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(1);
        expect(labels[0]).toHaveTextContent("session-123");
      });
    });
  });

  describe("add tab button", () => {
    it("creates a new session directly when + is clicked", async () => {
      mockGetSessions.mockResolvedValue({
        data: [{ name: "hive-main", created: 1000, windows: 1 }],
      });
      mockCreateSession.mockResolvedValue({ data: { name: "session-456" } });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("hive-main");
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("add-tab-button"));
      });

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      });

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(2);
        expect(labels[1]).toHaveTextContent("session-456");
      });
    });
  });

  describe("rename", () => {
    it("enters inline edit mode on double-click and commits on Enter", async () => {
      mockGetSessions.mockResolvedValue({
        data: [{ name: "hive-main", created: 1000, windows: 1 }],
      });
      mockRenameSession.mockResolvedValue({
        data: { oldName: "hive-main", newName: "my-tab" },
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("hive-main");
      });

      const tabButton = screen.getByTestId("tab-label").closest("button")!;
      fireEvent.doubleClick(tabButton);

      const input = screen.getByTestId("rename-input");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("hive-main");

      fireEvent.change(input, { target: { value: "my-tab" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(mockRenameSession).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          oldName: "hive-main",
          newName: "my-tab",
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("my-tab");
      });
    });

    it("cancels rename on Escape", async () => {
      mockGetSessions.mockResolvedValue({
        data: [{ name: "hive-main", created: 1000, windows: 1 }],
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("hive-main");
      });

      const tabButton = screen.getByTestId("tab-label").closest("button")!;
      fireEvent.doubleClick(tabButton);

      const input = screen.getByTestId("rename-input");
      fireEvent.change(input, { target: { value: "new-name" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(screen.getByTestId("tab-label")).toHaveTextContent("hive-main");
      expect(mockRenameSession).not.toHaveBeenCalled();
    });

    it("does not call rename for invalid names", async () => {
      mockGetSessions.mockResolvedValue({
        data: [{ name: "hive-main", created: 1000, windows: 1 }],
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("hive-main");
      });

      const tabButton = screen.getByTestId("tab-label").closest("button")!;
      fireEvent.doubleClick(tabButton);

      const input = screen.getByTestId("rename-input");
      fireEvent.change(input, { target: { value: "bad name!" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockRenameSession).not.toHaveBeenCalled();
    });
  });

  describe("kill", () => {
    it("calls killSessionAction and removes the tab", async () => {
      mockGetSessions.mockResolvedValue({
        data: [
          { name: "hive-main", created: 1000, windows: 1 },
          { name: "dev-server", created: 2000, windows: 1 },
        ],
      });
      mockKillSession.mockResolvedValue({ data: { name: "hive-main" } });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(2);
      });

      const killButtons = screen.getAllByTestId("close-tab");
      await act(async () => {
        fireEvent.click(killButtons[0]);
      });

      await waitFor(() => {
        expect(mockKillSession).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          sessionName: "hive-main",
        });
      });

      await waitFor(() => {
        const labels = screen.getAllByTestId("tab-label");
        expect(labels).toHaveLength(1);
        expect(labels[0]).toHaveTextContent("dev-server");
      });
    });

    it("does not show close button when only one tab remains", async () => {
      mockGetSessions.mockResolvedValue({
        data: [{ name: "hive-main", created: 1000, windows: 1 }],
      });

      render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("tab-label")).toHaveTextContent("hive-main");
      });

      expect(screen.queryByTestId("close-tab")).not.toBeInTheDocument();
    });
  });
});
