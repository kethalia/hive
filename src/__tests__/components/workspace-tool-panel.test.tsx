// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/workspaces/urls", () => ({
  buildWorkspaceUrls: (_ws: unknown, _agent: unknown, coderUrl: string) => {
    if (!coderUrl) return null;
    return {
      filebrowser: "https://fb.test",
      kasmvnc: "https://kasm.test",
      dashboard: "https://dash.test",
    };
  },
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
  }>) => (
    <button onClick={onClick} disabled={disabled} data-variant={rest.variant}>
      {children}
    </button>
  ),
  buttonVariants: () => "mock-button-class",
}));

vi.mock("@/components/ui/breadcrumb", () => ({
  Breadcrumb: ({ children }: React.PropsWithChildren) => (
    <nav aria-label="breadcrumb">{children}</nav>
  ),
  BreadcrumbList: ({ children }: React.PropsWithChildren) => <ol>{children}</ol>,
  BreadcrumbItem: ({ children }: React.PropsWithChildren) => <li>{children}</li>,
  BreadcrumbLink: ({
    children,
    render,
  }: React.PropsWithChildren<{ render?: React.ReactElement }>) =>
    render ? (
      <a href={(render as React.ReactElement<{ href: string }>).props.href}>{children}</a>
    ) : (
      <a>{children}</a>
    ),
  BreadcrumbPage: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  BreadcrumbSeparator: () => <li>/</li>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
  }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (v: boolean) => void }>) => (
    <div data-open={open}>{children}</div>
  ),
  PopoverTrigger: ({
    children,
    ...rest
  }: React.PropsWithChildren<{ className?: string; "data-testid"?: string }>) => (
    <button data-testid={rest["data-testid"]}>{children}</button>
  ),
  PopoverContent: ({ children }: React.PropsWithChildren) => (
    <div data-slot="popover-content">{children}</div>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    ...rest
  }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <div role="alert" data-variant={rest.variant}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-testid="terminal-tab-manager" />;
    Stub.displayName = "DynamicTerminalTabManager";
    return Stub;
  },
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("lucide-react", () => ({
  ExternalLink: () => <span>ExtLink</span>,
  FolderOpen: () => <span>FolderOpen</span>,
  Monitor: () => <span>Monitor</span>,
  TerminalSquare: () => <span>Terminal</span>,
  LayoutDashboard: () => <span>Dashboard</span>,
  AlertCircle: () => <span>AlertIcon</span>,
  ChevronDown: () => <span>▾</span>,
}));

import { WorkspaceToolPanel } from "@/components/workspaces/WorkspaceToolPanel";
import type { CoderWorkspace } from "@/lib/coder/types";

function makeWorkspace(
  overrides: Partial<CoderWorkspace> & { status?: string } = {},
): CoderWorkspace {
  const { status = "running", ...rest } = overrides;
  return {
    id: "ws-1",
    name: "dev",
    template_id: "tpl-1",
    owner_name: "alice",
    latest_build: {
      id: "build-1",
      status: status as CoderWorkspace["latest_build"]["status"],
      job: { status: "succeeded", error: "" },
    },
    ...rest,
  };
}

const defaultProps = {
  workspace: makeWorkspace(),
  agentId: "agent-1",
  agentName: "main",
  coderUrl: "https://coder.example.com",
};

describe("WorkspaceToolPanel", () => {
  let mockOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders terminal tab manager by default", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);
    expect(screen.getByTestId("terminal-tab-manager")).toBeInTheDocument();
  });

  it("renders breadcrumb with workspace name and tool picker", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    expect(screen.getByText("Workspaces")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByTestId("tool-picker-trigger")).toBeInTheDocument();
  });

  it("default tool picker shows Terminal", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    const trigger = screen.getByTestId("tool-picker-trigger");
    expect(trigger).toHaveTextContent("Terminal");
  });

  it("renders all four tool options in the dropdown", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    expect(screen.getByTestId("tool-option-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("tool-option-filebrowser")).toBeInTheDocument();
    expect(screen.getByTestId("tool-option-kasmvnc")).toBeInTheDocument();
    expect(screen.getByTestId("tool-option-dashboard")).toBeInTheDocument();
  });

  it("switches active tool when option is clicked", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    fireEvent.click(screen.getByTestId("tool-option-filebrowser"));

    const trigger = screen.getByTestId("tool-picker-trigger");
    expect(trigger).toHaveTextContent("Filebrowser");
  });

  it("renders proxied iframes for filebrowser and kasmvnc", () => {
    const { container } = render(<WorkspaceToolPanel {...defaultProps} />);

    const iframes = container.querySelectorAll("iframe");
    expect(iframes).toHaveLength(2);

    const srcs = Array.from(iframes).map((f) => f.getAttribute("src"));
    expect(srcs).toContain("/api/workspace-proxy/ws-1/filebrowser");
    expect(srcs).toContain("/api/workspace-proxy/ws-1/kasmvnc");
  });

  it("shows external placeholder for dashboard tool", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    fireEvent.click(screen.getByTestId("tool-option-dashboard"));

    expect(screen.getByText("Dashboard opens in a new tab")).toBeInTheDocument();
  });

  it("shows disabled state when workspace is stopped", () => {
    render(
      <WorkspaceToolPanel {...defaultProps} workspace={makeWorkspace({ status: "stopped" })} />,
    );

    expect(screen.getByText(/stopped/)).toBeInTheDocument();

    const iframe = document.querySelector("iframe");
    expect(iframe).toBeNull();

    const filebrowserBtn = screen.getByText("Filebrowser").closest("button")!;
    expect(filebrowserBtn).toBeDisabled();

    const kasmBtn = screen.getByText("KasmVNC").closest("button")!;
    expect(kasmBtn).toBeDisabled();
  });

  it("renders disabled dashboard button in stopped state", () => {
    render(
      <WorkspaceToolPanel {...defaultProps} workspace={makeWorkspace({ status: "stopped" })} />,
    );

    const dashboardBtns = screen.getAllByText("Dashboard");
    const disabledBtn = dashboardBtns
      .map((el) => el.closest("button"))
      .find((btn) => btn?.disabled);
    expect(disabledBtn).toBeTruthy();
  });

  it("does not crash with empty coderUrl", () => {
    expect(() =>
      render(
        <WorkspaceToolPanel
          workspace={makeWorkspace()}
          agentId="agent-1"
          agentName="main"
          coderUrl=""
        />,
      ),
    ).not.toThrow();
  });
});
