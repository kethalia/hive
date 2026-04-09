// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import React from "react";

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
    const event = new MessageEvent("status", {
      data: JSON.stringify(payload),
    });
    for (const fn of this.listeners["status"] ?? []) {
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
  const mod = await import(
    "@/app/tasks/[id]/agent-stream-panel"
  );
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
    expect(MockEventSource.instances[0].url).toBe(
      "/api/tasks/task-456/stream",
    );
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
      es._emitMessage("Hello from agent");
      es._emitMessage("Second line");
    });

    const output = screen.getByTestId("stream-output");
    expect(output.textContent).toContain("Hello from agent");
    expect(output.textContent).toContain("Second line");
  });

  it("shows connecting status indicator initially", () => {
    render(
      React.createElement(AgentStreamPanel, {
        taskId: "task-abc",
        status: "running",
      }),
    );

    const label = screen.getByTestId("status-label");
    expect(label.textContent).toBe("Connecting…");

    // Should show waiting message
    expect(screen.getByTestId("waiting-message")).toBeTruthy();
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
});
