// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeBackoff, useTerminalWebSocket } from "@/hooks/useTerminalWebSocket";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  binaryType: BinaryType = "blob";
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(readonly url: string) {
    instances.push(this);
  }
}

const instances: MockWebSocket[] = [];

function openSocket(socket = instances.at(-1)) {
  if (!socket) throw new Error("No MockWebSocket instance");
  socket.readyState = MockWebSocket.OPEN;
  act(() => {
    socket.onopen?.(new Event("open"));
  });
  return socket;
}

function closeSocket(socket: MockWebSocket, init: CloseEventInit) {
  socket.readyState = MockWebSocket.CLOSED;
  act(() => {
    socket.onclose?.(new CloseEvent("close", init));
  });
}

function latestSocket() {
  const socket = instances.at(-1);
  if (!socket) throw new Error("No MockWebSocket instance");
  return socket;
}

async function advanceTimersAndFlush(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mockVisibilityState(state: "hidden" | "visible") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

function dispatchPageTransitionEvent(type: "pagehide" | "pageshow", persisted = false) {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

describe("useTerminalWebSocket reconnect loop", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps retrying recoverable disconnects past ten attempts without final failure", () => {
    const onRecoveryStateChange = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
        onRecoveryStateChange,
      }),
    );
    openSocket();

    const expectedDelays = [
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 30000,
    ];

    for (const [attemptIndex, delay] of expectedDelays.entries()) {
      const socket = latestSocket();
      closeSocket(socket, {
        code: 1013,
        reason: "upstream connect timeout",
        wasClean: false,
      });

      expect(result.current.connectionState).toBe("disconnected");
      expect(result.current.recoveryState).toMatchObject({
        phase: "recovering",
        retryCount: attemptIndex + 1,
        maxRetryCount: null,
        lastCloseCategory: "transient",
        lastReasonCategory: "upstream-timeout",
        failureCategory: null,
        lastDelayMs: delay,
        isRecoverable: true,
        canRetry: true,
      });
      expect(result.current.connectionState).not.toBe("failed");
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        vi.advanceTimersByTime(delay - 1);
      });
      expect(instances).toHaveLength(attemptIndex + 1);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(instances).toHaveLength(attemptIndex + 2);
      expect(result.current.connectionState).toBe("reconnecting");
      expect(vi.getTimerCount()).toBe(1);
    }

    expect(onRecoveryStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ retryCount: 12, phase: "recovering" }),
    );
    unmount();
  });

  it("caps jittered reconnect backoff at thirty seconds", () => {
    vi.mocked(Math.random).mockReturnValue(1);

    expect(computeBackoff(20)).toBe(30000);

    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
      }),
    );
    openSocket();

    for (let attemptIndex = 0; attemptIndex <= 5; attemptIndex++) {
      closeSocket(latestSocket(), {
        code: 1006,
        reason: "recoverable network error",
        wasClean: false,
      });
      act(() => {
        vi.advanceTimersByTime(result.current.recoveryState.lastDelayMs ?? 0);
      });
    }

    expect(result.current.recoveryState).toMatchObject({
      phase: "recovering",
      retryCount: 6,
      lastDelayMs: 30000,
      failureCategory: null,
      isRecoverable: true,
    });
    expect(result.current.connectionState).toBe("reconnecting");
    unmount();
  });

  it("refreshes the URL before scheduled reconnect attempts", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 1013,
      reason: "upstream connect timeout",
      wasClean: false,
    });

    expect(result.current.recoveryState.lastDelayMs).toBe(1000);
    expect(instances).toHaveLength(1);

    await advanceTimersAndFlush(1000);

    expect(refreshUrlBeforeReconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUrl: "ws://terminal.example/ws?proof=stale",
        reason: "scheduled-reconnect",
        retryCount: 1,
        closeCategory: "transient",
        reasonCategory: "upstream-timeout",
      }),
    );
    expect(instances).toHaveLength(2);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/ws?proof=fresh");
    expect(result.current.recoveryState).toMatchObject({
      phase: "recovering",
      retryCount: 1,
      lastRecoveryAction: "schedule-reconnect",
      lastRefreshAction: "refresh-succeeded",
      refreshFailureCategory: null,
      isRecoverable: true,
    });
    unmount();
  });

  it("keeps an open socket alive when a PWA returns after a long background period", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    mockVisibilityState("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advanceTimersAndFlush(20000);
    mockVisibilityState("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshUrlBeforeReconnect).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    expect(result.current.connectionState).toBe("connected");
    unmount();
  });

  it("keeps an open socket alive across short visibility changes", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    mockVisibilityState("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advanceTimersAndFlush(9999);
    mockVisibilityState("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(refreshUrlBeforeReconnect).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    expect(result.current.connectionState).toBe("connected");
    unmount();
  });

  it("recovers when a WebSocket handshake stalls without open or close", async () => {
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
      }),
    );
    const stalledSocket = latestSocket();

    await advanceTimersAndFlush(15000);

    expect(stalledSocket.close).toHaveBeenCalledTimes(1);
    expect(result.current.connectionState).toBe("disconnected");
    expect(result.current.recoveryState).toMatchObject({
      phase: "recovering",
      retryCount: 1,
      lastCloseCategory: "transient",
      lastReasonCategory: "timeout",
      lastDelayMs: 1000,
      lastRecoveryAction: "schedule-reconnect",
      isRecoverable: true,
      canRetry: true,
    });
    expect(instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(instances).toHaveLength(2);
    expect(result.current.connectionState).toBe("reconnecting");
    unmount();
  });

  it("reconnects when the browser comes back online while disconnected", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 1006,
      reason: "transient network error",
      wasClean: false,
    });
    expect(result.current.connectionState).toBe("disconnected");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshUrlBeforeReconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUrl: "ws://terminal.example/ws?proof=stale",
        reason: "manual-reconnect",
        retryCount: 1,
      }),
    );
    expect(instances).toHaveLength(2);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/ws?proof=fresh");
    expect(result.current.connectionState).toBe("reconnecting");
    unmount();
  });

  it("does not reconnect on online when the socket is still open", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshUrlBeforeReconnect).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    expect(result.current.connectionState).toBe("connected");
    unmount();
  });

  it("reconnects once when lifecycle events find a connected state with a closed socket", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();
    socket.readyState = MockWebSocket.CLOSED;

    mockVisibilityState("visible");
    await act(async () => {
      dispatchPageTransitionEvent("pageshow");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshUrlBeforeReconnect).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/ws?proof=fresh");
    expect(result.current.connectionState).toBe("reconnecting");
    unmount();
  });

  it("keeps an open socket alive across pagehide and pageshow", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    act(() => {
      dispatchPageTransitionEvent("pagehide");
    });
    await advanceTimersAndFlush(999);
    await act(async () => {
      dispatchPageTransitionEvent("pageshow");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshUrlBeforeReconnect).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    expect(result.current.connectionState).toBe("connected");
    unmount();
  });

  it("does not duplicate reconnect when a lost socket gets pageshow followed by visibilitychange", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    act(() => {
      dispatchPageTransitionEvent("pagehide");
    });
    closeSocket(socket, {
      code: 1006,
      reason: "transient network error",
      wasClean: false,
    });
    await advanceTimersAndFlush(10000);
    mockVisibilityState("visible");
    await act(async () => {
      dispatchPageTransitionEvent("pageshow");
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshUrlBeforeReconnect).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    unmount();
  });

  it("does not reconnect with a stale URL when refresh fails", async () => {
    const refreshUrlBeforeReconnect = vi.fn().mockRejectedValue(new Error("resolver failed"));
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 1006,
      reason: "transient network error",
      wasClean: false,
    });

    await advanceTimersAndFlush(1000);

    expect(refreshUrlBeforeReconnect).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/ws?proof=stale");
    expect(result.current.connectionState).toBe("disconnected");
    expect(result.current.recoveryState).toMatchObject({
      phase: "recovering",
      retryCount: 2,
      lastRecoveryAction: "schedule-reconnect",
      lastRefreshAction: "refresh-failed",
      refreshFailureCategory: "callback-error",
      lastDelayMs: 2000,
      isRecoverable: true,
      canRetry: true,
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
  });

  it("treats malformed refresh results as sanitized refresh failures", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue({ url: "ws://terminal.example/ws" });
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 1013,
      reason: "upstream connect timeout",
      wasClean: false,
    });

    await advanceTimersAndFlush(1000);

    expect(instances).toHaveLength(1);
    expect(result.current.recoveryState).toMatchObject({
      lastRefreshAction: "refresh-failed",
      refreshFailureCategory: "malformed-response",
      lastCloseCategory: "transient",
      lastReasonCategory: "upstream-timeout",
      isRecoverable: true,
      canRetry: true,
    });
    unmount();
  });

  it("makes clone-proof-invalid closes refreshable only when a refresh callback exists", async () => {
    const withoutRefresh = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
      }),
    );
    closeSocket(openSocket(), {
      code: 1008,
      reason: "cloneProof invalid",
      wasClean: false,
    });

    expect(withoutRefresh.result.current.connectionState).toBe("failed");
    expect(withoutRefresh.result.current.recoveryState).toMatchObject({
      phase: "final-failure",
      lastCloseCategory: "clone-proof-invalid",
      failureCategory: "clone-proof-invalid",
      isRecoverable: false,
    });
    expect(vi.getTimerCount()).toBe(0);
    withoutRefresh.unmount();

    instances.length = 0;
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const withRefresh = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    closeSocket(openSocket(), {
      code: 1008,
      reason: "cloneProof invalid",
      wasClean: false,
    });

    expect(withRefresh.result.current.connectionState).toBe("disconnected");
    expect(withRefresh.result.current.recoveryState).toMatchObject({
      phase: "recovering",
      lastCloseCategory: "clone-proof-invalid",
      failureCategory: null,
      isRecoverable: true,
    });

    await advanceTimersAndFlush(1000);

    expect(refreshUrlBeforeReconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        closeCategory: "clone-proof-invalid",
        reasonCategory: "clone-proof-invalid",
      }),
    );
    expect(instances).toHaveLength(2);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/ws?proof=fresh");
    withRefresh.unmount();
  });

  it("keeps auth and permission closes final even with a refresh callback", () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 4401,
      reason: "unauthorized",
      wasClean: false,
    });

    expect(result.current.connectionState).toBe("failed");
    expect(result.current.recoveryState).toMatchObject({
      phase: "final-failure",
      lastCloseCategory: "auth-expired",
      failureCategory: "auth-expired",
      isRecoverable: false,
      canRetry: true,
    });
    expect(refreshUrlBeforeReconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("refreshes the URL before manual reconnects", async () => {
    const refreshUrlBeforeReconnect = vi
      .fn()
      .mockResolvedValue("ws://terminal.example/ws?proof=fresh");
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?proof=stale",
        onData: vi.fn(),
        refreshUrlBeforeReconnect,
      }),
    );
    const socket = openSocket();

    act(() => {
      result.current.manualReconnect();
    });
    await advanceTimersAndFlush(0);

    expect(refreshUrlBeforeReconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUrl: "ws://terminal.example/ws?proof=stale",
        reason: "manual-reconnect",
        retryCount: 0,
      }),
    );
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/ws?proof=fresh");
    expect(result.current.recoveryState).toMatchObject({
      lastRecoveryAction: "manual-reconnect",
      lastRefreshAction: "refresh-succeeded",
      refreshFailureCategory: null,
    });
    unmount();
  });

  it("cancels a pending reconnect on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 1013,
      reason: "upstream connect timeout",
      wasClean: false,
    });

    expect(result.current.recoveryState.lastDelayMs).toBe(1000);
    expect(vi.getTimerCount()).toBe(1);
    expect(instances).toHaveLength(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(instances).toHaveLength(1);
  });

  it("cancels a pending reconnect when the URL changes", () => {
    const { result, rerender, unmount } = renderHook(
      ({ url }) =>
        useTerminalWebSocket({
          url,
          onData: vi.fn(),
        }),
      { initialProps: { url: "ws://terminal.example/one" } },
    );
    const firstSocket = openSocket();

    closeSocket(firstSocket, {
      code: 1013,
      reason: "upstream connect timeout",
      wasClean: false,
    });
    expect(result.current.recoveryState.lastDelayMs).toBe(1000);
    expect(vi.getTimerCount()).toBe(1);

    rerender({ url: "ws://terminal.example/two" });

    expect(vi.getTimerCount()).toBe(1);
    expect(instances).toHaveLength(2);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/two");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(instances).toHaveLength(2);
    unmount();
  });

  it("uses one socket snapshot when a close races terminal input", () => {
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
      }),
    );
    const socket = openSocket();
    let readyStateReads = 0;
    Object.defineProperty(socket, "readyState", {
      configurable: true,
      get() {
        readyStateReads += 1;
        if (readyStateReads === 1) {
          socket.onclose?.(
            new CloseEvent("close", {
              code: 1013,
              reason: "upstream closed",
              wasClean: false,
            }),
          );
        }
        return MockWebSocket.OPEN;
      },
    });

    expect(() => {
      act(() => result.current.send("input"));
    }).not.toThrow();
    expect(socket.send).toHaveBeenCalledWith("input");
    expect(readyStateReads).toBe(1);
    unmount();
  });

  it("uses one socket snapshot when a close races a window refit", () => {
    const onResizeSent = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
        onResizeSent,
      }),
    );
    const socket = openSocket();
    let readyStateReads = 0;
    Object.defineProperty(socket, "readyState", {
      configurable: true,
      get() {
        readyStateReads += 1;
        if (readyStateReads === 1) {
          socket.onclose?.(
            new CloseEvent("close", {
              code: 1013,
              reason: "upstream closed",
              wasClean: false,
            }),
          );
        }
        return MockWebSocket.OPEN;
      },
    });

    expect(() => {
      act(() => result.current.resize(42, 120, "window-layout"));
    }).not.toThrow();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ height: 42, width: 120 }));
    expect(onResizeSent).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 42, cols: 120, source: "window-layout" }),
    );
    expect(readyStateReads).toBe(1);
    unmount();
  });

  it("ignores a stale close after a replacement socket is installed", () => {
    const { result, rerender, unmount } = renderHook(
      ({ url }: { url: string }) =>
        useTerminalWebSocket({
          url,
          onData: vi.fn(),
        }),
      { initialProps: { url: "ws://terminal.example/one" } },
    );
    const firstSocket = openSocket();
    const staleClose = firstSocket.onclose;

    rerender({ url: "ws://terminal.example/two" });
    const replacementSocket = openSocket();
    act(() => {
      staleClose?.(
        new CloseEvent("close", {
          code: 1013,
          reason: "late close",
          wasClean: false,
        }),
      );
      result.current.send("still-connected");
    });

    expect(replacementSocket.send).toHaveBeenCalledWith("still-connected");
    expect(result.current.connectionState).toBe("connected");
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("still treats explicitly unrecoverable closes as final failures", () => {
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 4403,
      reason: "permission denied",
      wasClean: false,
    });

    expect(result.current.connectionState).toBe("failed");
    expect(result.current.recoveryState).toMatchObject({
      phase: "final-failure",
      lastCloseCategory: "permission-denied",
      failureCategory: "permission-denied",
      isRecoverable: false,
      canRetry: true,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(instances).toHaveLength(1);
    unmount();
  });
});
