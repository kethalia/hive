// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    render: renderProp,
    ...rest
  }: React.PropsWithChildren<{
    onClick?: () => void;
    disabled?: boolean;
    nativeButton?: boolean;
    render?: React.ReactElement<{ href: string }>;
    variant?: string;
    size?: string;
    className?: string;
  }>) => {
    if (renderProp) {
      return <a href={renderProp.props.href}>{children}</a>;
    }
    return (
      <button onClick={onClick} disabled={disabled} data-variant={rest.variant}>
        {children}
      </button>
    );
  },
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
  XIcon: () => <span>Close</span>,
}));

import { TemplateDetailClient } from "@/components/templates/TemplateDetailClient";
import type { TemplateStatus } from "@/lib/templates/staleness";

function makeStatus(overrides: Partial<TemplateStatus> = {}): TemplateStatus {
  return {
    name: "browser-testing",
    stale: true,
    lastPushed: "2026-04-10T12:00:00Z",
    activeVersionId: "ver-abc123",
    localHash: "abc123def456",
    remoteHash: "789xyz000111",
    ...overrides,
  } as TemplateStatus;
}

function mockEventSourceConstructor(): typeof EventSource {
  return Object.assign(
    vi.fn().mockImplementation(() => ({
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    })),
    {
      CONNECTING: 0 as const,
      OPEN: 1 as const,
      CLOSED: 2 as const,
      prototype: {} as EventSource,
    },
  ) as unknown as typeof EventSource;
}

describe("TemplateDetailClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders template name", () => {
    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    expect(screen.getByText("browser-testing")).toBeInTheDocument();
  });

  it("renders catalog profile, runtime, and purpose", () => {
    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    expect(screen.getByText("Browser testing")).toBeInTheDocument();
    expect(screen.getByText("Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("Browser + desktop")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Dedicated Chrome and Playwright workspace for browser automation and inspection.",
      ),
    ).toBeInTheDocument();
  });

  it("renders staleness badge when stale", () => {
    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus({ stale: true })} />);
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("renders Current badge when not stale", () => {
    render(
      <TemplateDetailClient
        userId="fixture-owner"
        status={makeStatus({ stale: false, remoteHash: "abc" })}
      />,
    );
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("renders Unknown badge when remoteHash is null", () => {
    render(
      <TemplateDetailClient
        userId="fixture-owner"
        status={makeStatus({ stale: false, remoteHash: null })}
      />,
    );
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("renders lastPushed, activeVersionId, and hashes", () => {
    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    expect(screen.getByText("Last Pushed")).toBeInTheDocument();
    expect(screen.getByText("ver-abc123")).toBeInTheDocument();
    expect(screen.getByText("abc123def456")).toBeInTheDocument();
    expect(screen.getByText("789xyz000111")).toBeInTheDocument();
  });

  it("renders push button", () => {
    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    expect(screen.getByText("Push")).toBeInTheDocument();
  });

  it("push button triggers POST to correct API endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jobId: "job-1" }),
    });
    global.fetch = mockFetch;

    global.EventSource = mockEventSourceConstructor();

    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));
    fireEvent.click(screen.getByText("Confirm push"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/templates/browser-testing/push", {
        method: "POST",
        headers: { "Idempotency-Key": expect.any(String) },
      });
    });
  });

  it("reuses the normal UI request after lost ACK and reload, then clears it on observed completion", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(Error("lost ACK"))
      .mockResolvedValue({ ok: true, json: async () => ({ jobId: "same-job" }) });
    global.fetch = fetch;
    global.EventSource = mockEventSourceConstructor();
    const first = render(<TemplateDetailClient userId="owner-a" status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));
    fireEvent.click(screen.getByText("Confirm push"));
    await waitFor(() => expect(screen.getByText("Push failed")).toBeInTheDocument());
    const requestId = fetch.mock.calls[0][1].headers["Idempotency-Key"];
    first.unmount();
    render(<TemplateDetailClient userId="owner-a" status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));
    fireEvent.click(screen.getByText("Confirm push"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe(requestId);
    const source = vi.mocked(global.EventSource).mock.results.at(-1)?.value;
    await waitFor(() =>
      expect(source.addEventListener).toHaveBeenCalledWith("status", expect.any(Function)),
    );
    const status = source.addEventListener.mock.calls.find(
      (call: unknown[]) => call[0] === "status",
    )[1];
    act(() => status(new MessageEvent("status", { data: '{"success":true}' })));
    await waitFor(() => expect(screen.getByText("Push succeeded")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Push"));
    fireEvent.click(screen.getByText("Confirm push"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][1].headers["Idempotency-Key"]).not.toBe(requestId);
  });

  it("shows error message on push failure (non-ok response)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Template not found" }),
    });
    global.fetch = mockFetch;

    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));
    fireEvent.click(screen.getByText("Confirm push"));

    await waitFor(() => {
      expect(screen.getByTestId("x-circle")).toBeInTheDocument();
      expect(screen.getByText("Push failed")).toBeInTheDocument();
    });
  });

  it("shows error message on fetch network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    global.fetch = mockFetch;

    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));
    fireEvent.click(screen.getByText("Confirm push"));

    await waitFor(() => {
      expect(screen.getByText("Push failed")).toBeInTheDocument();
    });
  });

  it("does not render the old back link to /templates in the compact header", () => {
    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);

    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /templates/i })).not.toBeInTheDocument();
  });

  it("renders the template header without sidebar controls", () => {
    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);

    expect(screen.queryByTestId("page-sidebar-trigger")).not.toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveAttribute("data-dashboard-page-nav");
  });

  it("shows Pushing… badge during push", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jobId: "job-1" }),
    });
    global.fetch = mockFetch;

    global.EventSource = mockEventSourceConstructor();

    render(<TemplateDetailClient userId="fixture-owner" status={makeStatus()} />);
    fireEvent.click(screen.getByText("Push"));
    fireEvent.click(screen.getByText("Confirm push"));

    await waitFor(() => {
      const matches = screen.getAllByText("Pushing…");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders dash for missing lastPushed", () => {
    render(
      <TemplateDetailClient userId="fixture-owner" status={makeStatus({ lastPushed: null })} />,
    );
    const dds = screen.getAllByText("—");
    expect(dds.length).toBeGreaterThanOrEqual(1);
  });
});
