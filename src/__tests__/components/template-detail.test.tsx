// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-testid="terminal-panel">TerminalPanel</div>;
    Stub.displayName = "TerminalPanel";
    return Stub;
  },
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
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

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardTitle: ({ children }: React.PropsWithChildren) => <h3>{children}</h3>,
}));

vi.mock("lucide-react", () => ({
  ArrowLeft: () => <span>←</span>,
  RefreshCw: () => <span data-testid="refresh-icon">RefreshCw</span>,
  Upload: () => <span>Upload</span>,
  CheckCircle: () => <span data-testid="check-circle">✓</span>,
  XCircle: () => <span data-testid="x-circle">✗</span>,
}));

import { TemplateDetailClient } from "@/components/templates/TemplateDetailClient";
import type { TemplateStatus } from "@/lib/templates/staleness";

function makeStatus(overrides: Partial<TemplateStatus> = {}): TemplateStatus {
  return {
    name: "hive-worker",
    stale: true,
    lastPushed: "2026-04-10T12:00:00Z",
    activeVersionId: "ver-abc123",
    localHash: "abc123def456",
    remoteHash: "789xyz000111",
    ...overrides,
  } as TemplateStatus;
}

describe("TemplateDetailClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders template name", () => {
    render(<TemplateDetailClient status={makeStatus()} />);
    expect(screen.getByText("hive-worker")).toBeInTheDocument();
  });

  it("renders staleness badge when stale", () => {
    render(<TemplateDetailClient status={makeStatus({ stale: true })} />);
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("renders Current badge when not stale", () => {
    render(<TemplateDetailClient status={makeStatus({ stale: false, remoteHash: "abc" })} />);
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("renders Unknown badge when remoteHash is null", () => {
    render(<TemplateDetailClient status={makeStatus({ stale: false, remoteHash: null })} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("renders lastPushed, activeVersionId, and hashes", () => {
    render(<TemplateDetailClient status={makeStatus()} />);
    expect(screen.getByText("Last Pushed")).toBeInTheDocument();
    expect(screen.getByText("ver-abc123")).toBeInTheDocument();
    expect(screen.getByText("abc123def456")).toBeInTheDocument();
    expect(screen.getByText("789xyz000111")).toBeInTheDocument();
  });

  it("renders push button", () => {
    render(<TemplateDetailClient status={makeStatus()} />);
    expect(screen.getByText("Push")).toBeInTheDocument();
  });

  it("push button triggers POST to correct API endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jobId: "job-1" }),
    });
    global.fetch = mockFetch;

    global.EventSource = vi.fn().mockImplementation(() => ({
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    }));

    render(<TemplateDetailClient status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/templates/hive-worker/push", {
        method: "POST",
      });
    });
  });

  it("shows error message on push failure (non-ok response)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Template not found" }),
    });
    global.fetch = mockFetch;

    render(<TemplateDetailClient status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));

    await waitFor(() => {
      expect(screen.getByTestId("x-circle")).toBeInTheDocument();
      expect(screen.getByText("Push failed")).toBeInTheDocument();
    });
  });

  it("shows error message on fetch network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    global.fetch = mockFetch;

    render(<TemplateDetailClient status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));

    await waitFor(() => {
      expect(screen.getByText("Push failed")).toBeInTheDocument();
    });
  });

  it("renders back link to /templates", () => {
    render(<TemplateDetailClient status={makeStatus()} />);
    const backLink = screen.getByText("←").closest("a");
    expect(backLink).toHaveAttribute("href", "/templates");
  });

  it("shows Pushing… badge during push", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jobId: "job-1" }),
    });
    global.fetch = mockFetch;

    global.EventSource = vi.fn().mockImplementation(() => ({
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    }));

    render(<TemplateDetailClient status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));

    await waitFor(() => {
      const matches = screen.getAllByText("Pushing…");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders dash for missing lastPushed", () => {
    render(<TemplateDetailClient status={makeStatus({ lastPushed: null })} />);
    const dds = screen.getAllByText("—");
    expect(dds.length).toBeGreaterThanOrEqual(1);
  });
});
