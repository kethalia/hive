// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  socket: vi.fn(),
  dispose: vi.fn(),
  instances: [] as {
    open(): void;
    message(v: unknown): void;
    close: ReturnType<typeof vi.fn>;
    sent: unknown[];
  }[],
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    dispose = calls.dispose;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

import { ProjectTerminal } from "@/components/projects/ProjectTerminal";

const projectId = "22222222-2222-4222-8222-222222222222";
const target = { workspaceId: "workspace", threadId: "manager-thread" };
const grant = () => ({
  url: `${window.location.origin}/api/projects/${projectId}/terminal`,
  ticket: "fixture-ticket",
  expiresAt: Math.floor(Date.now() / 1000) + 45,
  protocolVersion: "0.165.0",
  binding: { ownerId: "owner", buildId: "build", serverInstanceId: "runtime", ...target },
});
beforeEach(() => {
  vi.clearAllMocks();
  calls.instances.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      sent: unknown[] = [];
      constructor(url: string) {
        super();
        calls.socket(url);
        calls.instances.push(this);
      }
      close = vi.fn(() => {
        this.readyState = 3;
      });
      send(data: string) {
        this.sent.push(JSON.parse(data));
      }
      open() {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
      message(v: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(v) }));
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(grant())),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("task manager terminal target", () => {
  it("a delayed same-thread terminal handshake stays within the relay setup budget", async () => {
    vi.useFakeTimers();
    render(<ProjectTerminal projectId={projectId} visible expected={target} />);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(calls.instances).toHaveLength(1);
    const socket = calls.instances[0];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(socket.close).not.toHaveBeenCalled();
    act(() => {
      socket.open();
      socket.message({ type: "ready" });
    });
    expect(socket.sent[0]).toEqual({ type: "authenticate", ticket: "fixture-ticket" });
    expect(socket.sent[1]).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(calls.socket).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("unmount cancels a pending terminal and a late open cannot authenticate", async () => {
    vi.useFakeTimers();
    const view = render(<ProjectTerminal projectId={projectId} visible expected={target} />);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const socket = calls.instances[0];
    view.unmount();
    act(() => {
      socket.open();
      socket.message({ type: "ready" });
    });
    expect(socket.sent).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls.socket).toHaveBeenCalledTimes(1);
  });
  it("an expired short grant never accepts a late terminal ready", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...grant(), expiresAt: Math.floor(Date.now() / 1000) + 8 }),
    );
    render(<ProjectTerminal projectId={projectId} visible expected={target} />);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const socket = calls.instances[0];
    act(() => socket.open());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    act(() => socket.message({ type: "ready" }));
    expect(socket.sent).toEqual([{ type: "authenticate", ticket: "fixture-ticket" }]);
    expect(socket.close).toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  it.each([
    { workspaceId: "other" },
    { threadId: "replacement" },
  ])("never opens a socket for a different target %j", async (changed) => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...grant(), binding: { ...grant().binding, ...changed } }),
    );
    render(<ProjectTerminal projectId={projectId} visible expected={target} />);
    await screen.findByRole("alert");
    expect(calls.socket).not.toHaveBeenCalled();
  });
  it("keeps the same terminal mounted when switching views", async () => {
    const view = render(<ProjectTerminal projectId={projectId} visible expected={target} />);
    await waitFor(() => expect(calls.socket).toHaveBeenCalledTimes(1));
    view.rerender(
      <ProjectTerminal projectId={projectId} visible={false} expected={{ ...target }} />,
    );
    expect(calls.socket).toHaveBeenCalledTimes(1);
    expect(calls.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(calls.dispose).toHaveBeenCalledTimes(1);
  });
});
