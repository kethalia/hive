// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalWebSocket } from "@/hooks/useTerminalWebSocket";

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

describe("useTerminalWebSocket resize diagnostics", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.spyOn(Date, "now").mockReturnValue(12345);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes onResizeSent only after an open WebSocket sends an encoded resize payload", () => {
    const onResizeSent = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
        onResizeSent,
      }),
    );
    const socket = openSocket();

    act(() => {
      result.current.resize(24, 80, "xterm-on-resize");
    });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ height: 24, width: 80 }));
    expect(onResizeSent).toHaveBeenCalledWith({
      rows: 24,
      cols: 80,
      source: "xterm-on-resize",
      sentAt: 12345,
    });
    unmount();
  });

  it("does not report resize-sent evidence while the WebSocket is closed", () => {
    const onResizeSent = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
        onResizeSent,
      }),
    );
    const socket = instances.at(-1)!;

    act(() => {
      result.current.resize(24, 80, "closed-socket-resize");
    });

    expect(socket.send).not.toHaveBeenCalled();
    expect(onResizeSent).not.toHaveBeenCalled();
    unmount();
  });

  it("ignores invalid and non-positive resize dimensions", () => {
    const onResizeSent = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
        onResizeSent,
      }),
    );
    const socket = openSocket();

    act(() => {
      result.current.resize(0, 80, "invalid-rows");
      result.current.resize(24, -1, "invalid-cols");
      result.current.resize(Number.NaN, 80, "nan-rows");
    });

    expect(socket.send).not.toHaveBeenCalled();
    expect(onResizeSent).not.toHaveBeenCalled();
    unmount();
  });

  it("preserves send behavior for open and closed sockets", () => {
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
      }),
    );
    const socket = openSocket();

    act(() => {
      result.current.send("hello");
    });
    expect(socket.send).toHaveBeenCalledWith("hello");

    socket.readyState = MockWebSocket.CLOSED;
    act(() => {
      result.current.send("ignored");
    });
    expect(socket.send).not.toHaveBeenCalledWith("ignored");
    unmount();
  });

  it("records retry metadata and reconnects after a recoverable close", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const onRecoveryStateChange = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws",
        onData: vi.fn(),
        onRecoveryStateChange,
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 1013,
      reason: "upstream connect timeout containing no terminal data",
      wasClean: false,
    });

    expect(result.current.connectionState).toBe("disconnected");
    expect(result.current.recoveryState).toMatchObject({
      phase: "recovering",
      retryCount: 1,
      maxRetryCount: null,
      lastCloseCode: 1013,
      lastCloseCategory: "transient",
      lastReasonCategory: "upstream-timeout",
      failureCategory: null,
      lastDelayMs: 1000,
      lastRecoveryAction: "schedule-reconnect",
      isRecoverable: true,
      canRetry: true,
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(instances).toHaveLength(2);
    expect(result.current.connectionState).toBe("reconnecting");
    expect(onRecoveryStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "recovering", retryCount: 1 }),
    );
    unmount();
  });

  it("classifies unrecoverable closes without storing raw close reasons", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() =>
      useTerminalWebSocket({
        url: "ws://terminal.example/ws?cloneProof=secret-token&path=/private/repo",
        onData: vi.fn(),
      }),
    );
    const socket = openSocket();

    closeSocket(socket, {
      code: 4401,
      reason: "Unauthorized cloneProof=secret-token /private/repo",
      wasClean: false,
    });

    expect(result.current.connectionState).toBe("failed");
    expect(result.current.recoveryState).toMatchObject({
      phase: "final-failure",
      retryCount: 0,
      lastCloseCode: 4401,
      lastCloseCategory: "auth-expired",
      lastReasonCategory: "clone-proof-invalid",
      failureCategory: "auth-expired",
      lastDelayMs: null,
      isRecoverable: false,
      canRetry: true,
    });
    expect(JSON.stringify(result.current.recoveryState)).not.toContain("secret-token");
    expect(JSON.stringify(result.current.recoveryState)).not.toContain("/private/repo");

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(instances).toHaveLength(1);
    unmount();
  });
});
