// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  open: vi.fn(),
  adapters: [] as { disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[],
}));
vi.mock("@/lib/codex-session/browser-transport", () => ({
  openCodexSessionTransport: mock.open,
  SessionTransportError: class extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/codex-session/adapter", () => ({
  CodexSessionAdapter: class {
    snapshot = { phase: "live" };
    disconnect = vi.fn();
    connect: ReturnType<typeof vi.fn>;
    constructor(_binding: unknown, changed: (v: unknown) => void) {
      this.connect = vi.fn(async () =>
        changed({ phase: "live", turns: [], needsRefresh: false, error: null }),
      );
      mock.adapters.push(this);
    }
  },
}));

import { useProjectConversation } from "@/hooks/useProjectConversation";
import { SessionTransportError } from "@/lib/codex-session/browser-transport";

const grant = { binding: { threadId: "thread" }, ticket: "fixture" };
let transport: { close: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.clearAllMocks();
  mock.adapters.length = 0;
  transport = { close: vi.fn(), onClose: vi.fn(() => vi.fn()) };
  mock.open.mockResolvedValue(transport);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(grant))),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("project read connection lifecycle", () => {
  it("does nothing before a native session exists", () => {
    renderHook(() => useProjectConversation("project", false));
    expect(fetch).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
  });
  it("opens only an authorized read subscription and does not reconnect for ordinary rerenders", async () => {
    const hook = renderHook(() => useProjectConversation("project", true));
    await waitFor(() => expect(hook.result.current.view.phase).toBe("live"));
    hook.rerender();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/projects/project/session-grant");
    expect(mock.adapters[0].connect).toHaveBeenCalledWith(transport);
    act(() => hook.result.current.reconnect());
    await waitFor(() => expect(mock.open).toHaveBeenCalledTimes(2));
    expect(mock.adapters[0].disconnect).toHaveBeenCalled();
  });
  it("closes a connection that completes after unmount without publishing stale data", async () => {
    let resolve!: (v: typeof transport) => void;
    mock.open.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const hook = renderHook(() => useProjectConversation("project", true));
    await waitFor(() => expect(mock.open).toHaveBeenCalled());
    hook.unmount();
    await act(async () => resolve(transport));
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(mock.adapters).toHaveLength(0);
  });
  it("clears history and avoids automatic retry when a reconnect handshake is revoked", async () => {
    const hook = renderHook(() => useProjectConversation("project", true));
    await waitFor(() => expect(hook.result.current.view.phase).toBe("live"));
    mock.open.mockRejectedValueOnce(new SessionTransportError("revoked", "private host policy"));
    act(() => hook.result.current.reconnect());
    await waitFor(() => expect(hook.result.current.view.phase).toBe("error"));
    expect(hook.result.current.view.turns).toEqual([]);
    expect(hook.result.current.view.error).not.toContain("private");
    expect(mock.open).toHaveBeenCalledTimes(2);
  });
  it("denied grants neither connect nor expose the authorization response body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("private upstream response", { status: 403 }));
    const hook = renderHook(() => useProjectConversation("project", true));
    await waitFor(() => expect(hook.result.current.view.phase).toBe("error"));
    expect(hook.result.current.view.turns).toEqual([]);
    expect(hook.result.current.view.error).not.toContain("private");
    expect(mock.open).not.toHaveBeenCalled();
  });
});
