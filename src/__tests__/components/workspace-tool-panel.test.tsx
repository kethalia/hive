// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
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

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    children,
    onValueChange,
    ...rest
  }: React.PropsWithChildren<{
    value?: string;
    onValueChange?: (v: string) => void;
    className?: string;
  }>) => (
    <div data-value={rest.value} data-slot="tabs">
      {children}
    </div>
  ),
  TabsList: ({ children }: React.PropsWithChildren) => <div data-slot="tabs-list">{children}</div>,
  TabsTrigger: ({
    children,
    value,
    ...rest
  }: React.PropsWithChildren<{ value: string }>) => {
    const tabsEl = rest as Record<string, unknown>;
    return (
      <button
        data-value={value}
        onClick={() => {
          const tabs = document.querySelector("[data-slot='tabs']");
          if (tabs) {
            const onValueChange = (tabs as HTMLElement).dataset.onvaluechange;
            if (onValueChange) (window as Record<string, unknown>)[onValueChange]?.(value);
          }
        }}
      >
        {children}
      </button>
    );
  },
  TabsContent: ({
    children,
    value,
  }: React.PropsWithChildren<{ value: string; className?: string }>) => (
    <div data-tab-content={value}>{children}</div>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children, ...rest }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <div role="alert" data-variant={rest.variant}>{children}</div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  ExternalLink: () => <span>ExtLink</span>,
  FolderOpen: () => <span>FolderOpen</span>,
  Monitor: () => <span>Monitor</span>,
  LayoutDashboard: () => <span>Dashboard</span>,
  AlertCircle: () => <span>AlertIcon</span>,
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

  it("renders filebrowser iframe by default", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    const iframe = document.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute("src")).toBe("https://fb.test");
  });

  it("opens popup with correct URL on Pop Out click", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    const popOutButton = screen.getByText("Pop Out").closest("button")!;
    fireEvent.click(popOutButton);

    expect(mockOpen).toHaveBeenCalledWith("https://fb.test", "_blank");
  });

  it("renders dashboard link with correct href and target", () => {
    render(<WorkspaceToolPanel {...defaultProps} />);

    const dashLinks = screen.getAllByText("Dashboard");
    const dashboardLink = dashLinks.find((el) => el.closest("a"))!.closest("a")!;
    expect(dashboardLink.getAttribute("href")).toBe("https://dash.test");
    expect(dashboardLink.getAttribute("target")).toBe("_blank");
  });

  it("shows disabled state when workspace is stopped", () => {
    render(
      <WorkspaceToolPanel
        {...defaultProps}
        workspace={makeWorkspace({ status: "stopped" })}
      />,
    );

    expect(screen.getByText(/stopped/)).toBeInTheDocument();

    const iframe = document.querySelector("iframe");
    expect(iframe).toBeNull();

    const filebrowserBtn = screen.getByText("Filebrowser").closest("button")!;
    expect(filebrowserBtn).toBeDisabled();

    const kasmBtn = screen.getByText("KasmVNC").closest("button")!;
    expect(kasmBtn).toBeDisabled();
  });

  it("shows error fallback with direct links when iframe error triggers", async () => {
    vi.useFakeTimers();

    const { container } = render(<WorkspaceToolPanel {...defaultProps} />);

    const iframe = container.querySelector("iframe")!;
    expect(iframe).toBeTruthy();

    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get() {
        return {
          get location() {
            throw new DOMException("Blocked a frame with origin from accessing a cross-origin frame.");
          },
        };
      },
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(
      screen.getByText(/Unable to embed/),
    ).toBeInTheDocument();

    const openFbButton = screen.getByText("Open Filebrowser").closest("button")!;
    fireEvent.click(openFbButton);
    expect(mockOpen).toHaveBeenCalledWith("https://fb.test", "_blank");

    const openKasmButton = screen.getByText("Open KasmVNC").closest("button")!;
    fireEvent.click(openKasmButton);
    expect(mockOpen).toHaveBeenCalledWith("https://kasm.test", "_blank");

    vi.useRealTimers();
  });

  it("renders dashboard link even in disabled state", () => {
    render(
      <WorkspaceToolPanel
        {...defaultProps}
        workspace={makeWorkspace({ status: "stopped" })}
      />,
    );

    const dashboardLink = screen.getByText("Coder Dashboard").closest("a")!;
    expect(dashboardLink.getAttribute("href")).toBe("https://dash.test");
    expect(dashboardLink.getAttribute("target")).toBe("_blank");
  });

  it("does not crash with empty coderUrl", () => {
    expect(() =>
      render(
        <WorkspaceToolPanel
          workspace={makeWorkspace()}
          agentName="main"
          coderUrl=""
        />,
      ),
    ).not.toThrow();
  });
});
