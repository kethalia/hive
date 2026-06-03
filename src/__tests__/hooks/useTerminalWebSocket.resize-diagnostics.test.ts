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

describe("useTerminalWebSocket resize diagnostics", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.spyOn(Date, "now").mockReturnValue(12345);
  });

  afterEach(() => {
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
});
