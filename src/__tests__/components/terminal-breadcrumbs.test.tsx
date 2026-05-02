// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
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
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  PopoverTrigger: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <button data-testid="session-trigger" className={className}>
      {children}
    </button>
  ),
  PopoverContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="session-popover">{children}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  Plus: () => <span>+</span>,
  X: () => <span>×</span>,
  Pencil: () => <span>✎</span>,
  Loader2: () => <span data-testid="loader">…</span>,
  Terminal: () => <span>T</span>,
  ChevronDown: () => <span>▾</span>,
}));

const mockGetWorkspace = vi.fn();
const mockGetSessions = vi.fn();
const mockCreateSession = vi.fn();
const mockKillSession = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  getWorkspaceAction: (...args: unknown[]) => mockGetWorkspace(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetSessions(...args),
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  killSessionAction: (...args: unknown[]) => mockKillSession(...args),
}));

import { TerminalBreadcrumbs } from "@/components/workspaces/TerminalBreadcrumbs";

describe("TerminalBreadcrumbs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.delete("session");
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading state initially", () => {
    mockGetWorkspace.mockReturnValue(new Promise(() => {}));
    mockGetSessions.mockReturnValue(new Promise(() => {}));

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);
    expect(screen.getByTestId("loader")).toBeInTheDocument();
  });

  it("renders breadcrumbs with workspace name after loading", async () => {
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({
      data: [{ name: "session-1", created: 1000, windows: 1 }],
    });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      expect(screen.getByText("Home")).toBeInTheDocument();
      expect(screen.getByText("dev-box")).toBeInTheDocument();
      expect(screen.getByText("Terminal")).toBeInTheDocument();
    });
  });

  it("auto-selects first session when no session param exists", async () => {
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1000, windows: 1 },
        { name: "debug", created: 2000, windows: 1 },
      ],
    });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/workspaces/ws-1/terminal?session=main-session");
    });
  });

  it("creates a session when none exist", async () => {
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({ data: [] });
    mockCreateSession.mockResolvedValue({ data: { name: "session-new" } });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/workspaces/ws-1/terminal?session=session-new");
    });
  });

  it("shows current session name in trigger", async () => {
    mockSearchParams.set("session", "my-session");
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({
      data: [{ name: "my-session", created: 1000, windows: 1 }],
    });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      const trigger = screen.getByTestId("session-trigger");
      expect(trigger).toHaveTextContent("my-session");
    });
  });

  it("lists sessions in popover", async () => {
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "alpha", created: 1000, windows: 1 },
        { name: "beta", created: 2000, windows: 1 },
      ],
    });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      const popover = screen.getByTestId("session-popover");
      expect(popover).toHaveTextContent("alpha");
      expect(popover).toHaveTextContent("beta");
    });
  });

  it("has a New Session button in popover", async () => {
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({
      data: [{ name: "alpha", created: 1000, windows: 1 }],
    });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });
  });

  it("creates session when New Session is clicked", async () => {
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({
      data: [{ name: "alpha", created: 1000, windows: 1 }],
    });
    mockCreateSession.mockResolvedValue({ data: { name: "session-new" } });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("New Session"));

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
  });

  it("renders Workspaces link pointing to /tasks", async () => {
    mockGetWorkspace.mockResolvedValue({ data: { name: "dev-box" } });
    mockGetSessions.mockResolvedValue({
      data: [{ name: "s1", created: 1000, windows: 1 }],
    });

    render(<TerminalBreadcrumbs workspaceId="ws-1" />);

    await waitFor(() => {
      const link = screen.getByText("Home").closest("a");
      expect(link).toHaveAttribute("href", "/tasks");
    });
  });
});
