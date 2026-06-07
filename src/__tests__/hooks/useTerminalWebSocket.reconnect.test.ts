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
      const socket = instances.at(-1)!;
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
      expect(vi.getTimerCount()).toBe(0);
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
      closeSocket(instances.at(-1)!, {
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

    expect(vi.getTimerCount()).toBe(0);
    expect(instances).toHaveLength(2);
    expect(instances.at(-1)?.url).toBe("ws://terminal.example/two");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(instances).toHaveLength(2);
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
