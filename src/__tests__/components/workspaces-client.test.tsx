// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
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
    onClick?: (e: React.MouseEvent) => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
  }>) => (
    <button
      onClick={onClick}
      disabled={disabled}
      data-variant={rest.variant}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: React.PropsWithChildren) => (
    <div data-testid="card">{children}</div>
  ),
  CardContent: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    className,
  }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <span data-testid="badge" className={className}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: React.PropsWithChildren) => (
    <div role="alert">{children}</div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open,
  }: React.PropsWithChildren<{ open?: boolean }>) => (
    <div data-testid="collapsible" data-open={open}>
      {children}
    </div>
  ),
  CollapsibleContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  RefreshCw: () => <span>↻</span>,
  FolderOpen: () => <span>FB</span>,
  Monitor: () => <span>VNC</span>,
  Code: () => <span>CS</span>,
  ChevronDown: () => <span>▾</span>,
  ChevronRight: () => <span>▸</span>,
  Terminal: () => <span>Term</span>,
  AlertCircle: () => <span>!</span>,
}));

const mockListWorkspaces = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: (...args: unknown[]) => mockListWorkspaces(...args),
}));

import { WorkspacesClient } from "@/components/workspaces/WorkspacesClient";
import type { CoderWorkspace } from "@/lib/coder/types";

function makeWorkspace(
  overrides: Partial<CoderWorkspace> & { status?: string } = {},
): CoderWorkspace {
  const { status = "running", ...rest } = overrides;
  return {
    id: "ws-1",
    name: "dev-box",
    template_id: "tpl-1",
    template_name: "hive-worker",
    owner_name: "alice",
    latest_build: {
      id: "build-1",
      status: status as CoderWorkspace["latest_build"]["status"],
      job: { status: "succeeded", error: "" },
    },
    ...rest,
  };
}

describe("WorkspacesClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("open", vi.fn());
  });

  afterEach(() => {
    cleanup();
  });

  it("renders workspace list with name and status badge", () => {
    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);
    expect(screen.getByText("dev-box")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("shows empty state when no workspaces", () => {
    render(<WorkspacesClient initialWorkspaces={[]} coderUrl="https://coder.test" />);
    expect(screen.getByText("No workspaces found")).toBeInTheDocument();
  });

  it("expands workspace on click showing app buttons", () => {
    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);

    fireEvent.click(screen.getByText("dev-box"));

    expect(screen.getByText("Filebrowser")).toBeInTheDocument();
    expect(screen.getByText("KasmVNC")).toBeInTheDocument();
    expect(screen.getByText("Code Server")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("collapses workspace on second click", () => {
    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);

    fireEvent.click(screen.getByText("dev-box"));
    expect(screen.getByText("Filebrowser")).toBeInTheDocument();

    fireEvent.click(screen.getByText("dev-box"));
    const collapsible = screen.getByTestId("collapsible");
    expect(collapsible).toHaveAttribute("data-open", "false");
  });

  it("opens filebrowser in popup window", () => {
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);
    fireEvent.click(screen.getByText("dev-box"));
    fireEvent.click(screen.getByText("Filebrowser"));

    expect(mockOpen).toHaveBeenCalledWith(
      expect.stringContaining("filebrowser--main--dev-box--alice"),
      "Filebrowser",
      expect.any(String),
    );
  });

  it("opens kasmvnc in popup window", () => {
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);
    fireEvent.click(screen.getByText("dev-box"));
    fireEvent.click(screen.getByText("KasmVNC"));

    expect(mockOpen).toHaveBeenCalledWith(
      expect.stringContaining("kasm-vnc--main--dev-box--alice"),
      "KasmVNC",
      expect.any(String),
    );
  });

  it("opens code-server in popup window", () => {
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);
    fireEvent.click(screen.getByText("dev-box"));
    fireEvent.click(screen.getByText("Code Server"));

    expect(mockOpen).toHaveBeenCalledWith(
      expect.stringContaining("code-server--main--dev-box--alice"),
      "Code Server",
      expect.any(String),
    );
  });

  it("navigates to terminal page on Terminal click", () => {
    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);
    fireEvent.click(screen.getByText("dev-box"));
    fireEvent.click(screen.getByText("Terminal"));

    expect(mockPush).toHaveBeenCalledWith("/workspaces/ws-1/terminal");
  });

  it("shows unavailable message for stopped workspace", () => {
    render(
      <WorkspacesClient
        initialWorkspaces={[makeWorkspace({ status: "stopped" })]}
        coderUrl="https://coder.test"
      />,
    );

    fireEvent.click(screen.getByText("dev-box"));
    expect(screen.getByText(/apps unavailable/)).toBeInTheDocument();
  });

  it("refreshes workspace list", async () => {
    mockListWorkspaces.mockResolvedValue({
      data: [makeWorkspace({ name: "refreshed-box" })],
    });

    render(<WorkspacesClient initialWorkspaces={[makeWorkspace()]} coderUrl="https://coder.test" />);
    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => {
      expect(screen.getByText("refreshed-box")).toBeInTheDocument();
    });
  });
});
