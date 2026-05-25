// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------- Mock EventSource ---------- */

type ESListener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  private listeners: Record<string, ESListener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: ESListener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: ESListener) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }

  close() {
    this.closed = true;
    this.readyState = 2; // CLOSED
  }

  /* Test helpers */
  _emitMessage(data: string) {
    const event = new MessageEvent("message", { data });
    if (this.onmessage) this.onmessage(event);
  }

  _emitStatus(payload: object) {
    this._emitStatusData(JSON.stringify(payload));
  }

  _emitStatusData(data: string) {
    const event = new MessageEvent("status", { data });
    for (const fn of this.listeners.status ?? []) {
      fn(event);
    }
  }

  _emitError() {
    const event = new Event("error");
    if (this.onerror) this.onerror(event);
  }
}

vi.stubGlobal("EventSource", MockEventSource);

/* We need to dynamically import after global stub is set */
let AgentStreamPanel: React.ComponentType<{ taskId: string; status: string }>;

beforeEach(async () => {
  MockEventSource.instances = [];
  const mod = await import("@/app/(dashboard)/tasks/[id]/agent-stream-panel");
  AgentStreamPanel = mod.AgentStreamPanel;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ---------- Helpers ---------- */

// Silence scrollIntoView which jsdom doesn't implement
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
}

/* ---------- Tests ---------- */

describe("AgentStreamPanel", () => {
  it("does not create EventSource when status is 'done'", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-123",
        status: "done",
      }),
    );
    expect(MockEventSource.instances).toHaveLength(0);
    // Should render nothing
    expect(screen.queryByTestId("agent-stream-panel")).toBeNull();
  });

  it("creates EventSource with correct URL when status is 'running'", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-456",
        status: "running",
      }),
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/tasks/task-456/stream");
  });

  it("renders streamed lines when message events are received", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-789",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];

    act(() => {
      es._emitMessage("hello");
      es._emitMessage("world");
    });

    const output = screen.getByTestId("stream-output");
    expect(output.textContent).toBe("hello\nworld");
  });

  it("renders sticky mobile stream header diagnostics", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-header",
        status: "running",
      }),
    );

    const header = screen.getByTestId("agent-stream-header");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-14");
    expect(header.className).toContain("z-20");
    expect(header.className).toContain("border-b");
    expect(header.className).toContain("bg-card/95");
    expect(header.className).toContain("backdrop-blur");
    expect(header.className).toContain("md:static");
  });

  it("renders an svh-sized native scroll viewport with desktop height override", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-viewport",
        status: "running",
      }),
    );

    const viewport = screen.getByTestId("stream-scroll-container");
    expect(viewport.className).toContain("h-[60svh]");
    expect(viewport.className).toContain("overflow-y-auto");
    expect(viewport.className).toContain("rounded-md");
    expect(viewport.className).toContain("bg-muted/30");
    expect(viewport.className).toContain("p-3");
    expect(viewport.className).toContain("pb-safe");
    expect(viewport.className).toContain("md:h-[400px]");
  });

  it("renders a touch-sized scroll-to-bottom button", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-button",
        status: "running",
      }),
    );

    const button = screen.getByTestId("scroll-to-bottom");
    expect(button.getAttribute("aria-label")).toBe("Scroll to latest agent output");
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("min-w-11");
    expect(button.className).toContain("touch-manipulation");
    expect(button.className).toContain("md:min-h-8");
    expect(button.className).toContain("md:min-w-8");
  });

  it("scrolls to the latest output with behavior auto when the button is tapped", () => {
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-click",
        status: "running",
      }),
    );

    act(() => {
      fireEvent.click(screen.getByTestId("scroll-to-bottom"));
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end", behavior: "auto" });
    expect(scrollIntoView).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("auto-scrolls appended messages only when already near the live tail", () => {
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-tail",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];
    const viewport = screen.getByTestId("stream-scroll-container");
    setScrollMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 560 });

    act(() => {
      es._emitMessage("near tail message");
    });

    expect(screen.getByTestId("stream-output").textContent).toBe("near tail message");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end", behavior: "auto" });
    expect(scrollIntoView).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("does not auto-scroll appended messages when the user is away from the live tail", () => {
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-away",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];
    const viewport = screen.getByTestId("stream-scroll-container");
    setScrollMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });

    act(() => {
      fireEvent.scroll(viewport);
      es._emitMessage("historical message");
    });

    expect(screen.getByTestId("stream-output").textContent).toBe("historical message");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("resets live-tail diagnostics when a new running stream starts", () => {
    const { rerender } = render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-before",
        status: "running",
      }),
    );
    const viewport = screen.getByTestId("stream-scroll-container");
    setScrollMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });

    act(() => {
      fireEvent.scroll(viewport);
    });
    expect(screen.getByTestId("scroll-to-bottom").getAttribute("data-at-tail")).toBe("false");

    rerender(
      React.createElement(AgentStreamPanel, {
        taskId: "task-after",
        status: "running",
      }),
    );

    expect(screen.getByTestId("scroll-to-bottom").getAttribute("data-at-tail")).toBe("true");
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it("shows error state on EventSource error", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-err",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];

    act(() => {
      es._emitError();
    });

    const label = screen.getByTestId("status-label");
    expect(label.textContent).toBe("Error");
  });

  it("closes EventSource on unmount", () => {
    const { unmount } = render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-unmount",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);

    unmount();
    expect(es.closed).toBe(true);
  });

  it("shows streaming status after receiving status connected event", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-connect",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];

    act(() => {
      es._emitStatus({ status: "connected" });
    });

    const label = screen.getByTestId("status-label");
    expect(label.textContent).toBe("Streaming");
  });

  it("shows waiting status when status event says waiting", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-wait",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];

    act(() => {
      es._emitStatus({ status: "waiting" });
    });

    const label = screen.getByTestId("status-label");
    expect(label.textContent).toBe("Waiting");
    expect(screen.getByTestId("waiting-message")).toBeTruthy();
  });

  it("ignores malformed status payloads and preserves the current connection status", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-malformed",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];

    act(() => {
      es._emitStatus({ status: "waiting" });
      es._emitStatusData("not-json");
    });

    expect(screen.getByTestId("status-label").textContent).toBe("Waiting");
    expect(es.closed).toBe(false);
  });

  it("closes EventSource when the stream ends", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-ended",
        status: "running",
      }),
    );
    const es = MockEventSource.instances[0];

    act(() => {
      es._emitStatus({ status: "ended" });
    });

    expect(screen.getByTestId("status-label").textContent).toBe("Ended");
    expect(es.closed).toBe(true);
  });
});
