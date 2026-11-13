// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare"));

import { useTerminalWebSocket } from "@/hooks/useTerminalWebSocket";

class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  protocol = "hive-terminal-v1";
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = Socket.CLOSED;
  });
  constructor() {
    sockets.push(this);
  }
}
const sockets: Socket[] = [];
beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterAll(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("allows the bounded Cloudflare handshake past the Node 15s deadline and stops at 35s", () => {
  const { unmount } = renderHook(() =>
    useTerminalWebSocket({ url: "wss://hive.example/ws", onData: vi.fn() }),
  );
  const socket = sockets[0];
  try {
    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(socket.close).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(19999);
    });
    expect(socket.close).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(socket.close).toHaveBeenCalledOnce();
  } finally {
    unmount();
  }
});
it("accepts readiness at the relay's 30s setup boundary", () => {
  const { result, unmount } = renderHook(() =>
    useTerminalWebSocket({ url: "wss://hive.example/ws", onData: vi.fn() }),
  );
  const socket = sockets[0];
  try {
    act(() => {
      vi.advanceTimersByTime(30000);
      socket.readyState = Socket.OPEN;
      socket.onopen?.(new Event("open"));
      socket.onmessage?.(new MessageEvent("message", { data: '{"type":"hive:ready"}' }));
    });
    expect(result.current.connectionState).toBe("connected");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(socket.close).not.toHaveBeenCalled();
  } finally {
    unmount();
  }
});
