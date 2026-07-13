// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { TemplatesClient } from "@/components/templates/TemplatesClient";
import { PULL_REFRESH_TRIGGER_PX } from "@/lib/gestures/conventions";
import type { TemplateStatus } from "@/lib/templates/staleness";

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-testid="terminal-panel">TerminalPanel</div>;
    Stub.displayName = "TerminalPanel";
    return Stub;
  },
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-testid="dashboard-page-sidebar-trigger">
      Toggle sidebar
    </button>
  ),
}));

let originalPointerEvent: typeof window.PointerEvent | undefined;
const originalSetPointerCapture = Element.prototype.setPointerCapture;
const originalReleasePointerCapture = Element.prototype.releasePointerCapture;
const originalHasPointerCapture = Element.prototype.hasPointerCapture;
const originalFetch = globalThis.fetch;

class MockEventSource {
  static instances: MockEventSource[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  closed = false;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  close() {
    this.closed = true;
  }
}

function makeStatus(overrides: Partial<TemplateStatus> = {}): TemplateStatus {
  return {
    name: "hive",
    stale: true,
    lastPushed: null,
    activeVersionId: "version-1",
    localHash: "local-hash",
    remoteHash: "remote-hash",
    ...overrides,
  };
}

function pointerDown(target: HTMLElement, { x = 20, y = 10 } = {}) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function pointerMove(target: HTMLElement, { x = 20, y }: { x?: number; y: number }) {
  fireEvent.pointerMove(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function pointerUp(target: HTMLElement, { x = 20, y }: { x?: number; y: number }) {
  fireEvent.pointerUp(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 0,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function dragPull(target: HTMLElement, moveY: number, moveX = 20) {
  pointerDown(target);
  pointerMove(target, { x: moveX, y: 10 + moveY });
  pointerUp(target, { x: moveX, y: 10 + moveY });
}

beforeAll(() => {
  originalPointerEvent = window.PointerEvent;
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => true);
  }
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
});

afterAll(() => {
  window.PointerEvent = originalPointerEvent as typeof PointerEvent;
  Element.prototype.setPointerCapture = originalSetPointerCapture;
  Element.prototype.releasePointerCapture = originalReleasePointerCapture;
  Element.prototype.hasPointerCapture = originalHasPointerCapture;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  MockEventSource.instances = [];
});

describe("templates mobile list", () => {
  it("renders mobile cards, desktop table columns, and 44px mobile push actions", () => {
    render(
      <TemplatesClient
        initialStatuses={[
          makeStatus({ name: "hive", stale: true }),
          makeStatus({ name: "ai-dev", stale: false, remoteHash: "local-hash" }),
          makeStatus({ name: "unknown", stale: false, remoteHash: null }),
        ]}
      />,
    );

    const stack = screen.getByTestId("templates-mobile-card-stack");
    expect(stack).toHaveAttribute("role", "list");
    expect(stack).toHaveClass("md:hidden", "text-sm", "pb-safe");

    const cards = screen.getAllByTestId("template-mobile-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]).getByText("hive")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Stale")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Current")).toBeInTheDocument();
    expect(within(cards[2]).getByText("Unknown")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Last pushed")).toBeInTheDocument();

    const mobilePush = within(cards[0]).getByRole("button", { name: /Push/ });
    expect(mobilePush).toHaveClass("min-h-11", "touch-manipulation", "text-sm");

    const desktopTable = screen.getByTestId("templates-desktop-table");
    expect(desktopTable).toHaveClass("hidden", "md:block");
    expect(within(desktopTable).getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(
      within(desktopTable).getByRole("columnheader", { name: "Last Pushed" }),
    ).toBeInTheDocument();
    expect(within(desktopTable).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(desktopTable).getByRole("columnheader", { name: "Action" })).toBeInTheDocument();
  });

  it("renders an empty mobile status card without removing the desktop table", () => {
    render(<TemplatesClient initialStatuses={[]} />);

    expect(screen.getByTestId("templates-empty-card")).toHaveTextContent("No templates found");
    expect(screen.getByTestId("templates-mobile-card-stack")).toHaveClass("md:hidden");
    expect(screen.getByTestId("templates-desktop-table")).toHaveClass("hidden", "md:block");
  });

  it("pulls /api/templates/status once while in-flight and updates cards when it resolves", async () => {
    let resolveFetch!: (value: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => statusPromise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<TemplatesClient initialStatuses={[makeStatus({ stale: true })]} />);
    const surface = screen.getByTestId("pull-to-refresh");

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/templates/status");
      expect(surface).toHaveAttribute("data-pull-state", "refreshing");
    });

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch({
        ok: true,
        json: () => Promise.resolve([makeStatus({ stale: false, remoteHash: "local-hash" })]),
      } as Response);
      await statusPromise;
    });

    await waitFor(() => {
      expect(
        within(screen.getByTestId("templates-mobile-card-stack")).getAllByText("Current"),
      ).toHaveLength(1);
      expect(surface).toHaveAttribute("data-pull-state", "idle");
    });
  });

  it.each([
    ["non-OK response", () => Promise.resolve({ ok: false } as Response)],
    ["network error", () => Promise.reject(new Error("network failed"))],
    [
      "malformed JSON",
      () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error("bad json")),
        } as Response),
    ],
  ])("keeps existing statuses after a failed refresh from %s", async (_label, fetchImpl) => {
    const fetchMock = vi.fn(fetchImpl);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<TemplatesClient initialStatuses={[makeStatus({ name: "hive", stale: true })]} />);
    const surface = screen.getByTestId("pull-to-refresh");

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/templates/status");
      expect(surface).toHaveAttribute("data-pull-state", "idle");
    });

    const card = screen.getByTestId("template-mobile-card");
    expect(within(card).getByText("hive")).toBeInTheDocument();
    expect(within(card).getByText("Stale")).toBeInTheDocument();
  });

  it("keeps the push flow working and leaves terminal panels outside the pull region", async () => {
    let resolvePush!: (value: Response) => void;
    const pushPromise = new Promise<Response>((resolve) => {
      resolvePush = resolve;
    });
    const fetchMock = vi.fn(() => pushPromise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<TemplatesClient initialStatuses={[makeStatus({ name: "hive", stale: true })]} />);
    const card = screen.getByTestId("template-mobile-card");
    const mobilePush = within(card).getByRole("button", { name: /Push/ });

    fireEvent.click(mobilePush);
    fireEvent.click(screen.getByRole("button", { name: /Confirm push/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/templates/hive/push", { method: "POST" });
      expect(within(card).getByRole("button", { name: /Pushing/ })).toBeDisabled();
    });

    const terminal = screen.getByTestId("terminal-panel");
    expect(screen.getByTestId("pull-to-refresh")).not.toContainElement(terminal);

    await act(async () => {
      resolvePush({ ok: true, json: () => Promise.resolve({ jobId: "job-1" }) } as Response);
      await pushPromise;
    });

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toBe("/api/templates/hive/push/job-1/stream");
    });
  });

  it("does not introduce tiny type in the S05-owned template markup", () => {
    const source = readFileSync("src/components/templates/TemplatesClient.tsx", "utf8");
    expect(source).not.toContain("text-[10px]");
  });
});
