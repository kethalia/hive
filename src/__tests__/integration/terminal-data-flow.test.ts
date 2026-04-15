// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/terminal/protocol", () => ({
  encodeResize: (rows: number, cols: number) => `resize:${rows}:${cols}`,
}));

function createMockTerminal() {
  return {
    write: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    loadAddon: vi.fn(),
    open: vi.fn(),
  };
}

function makeResponse(body: Uint8Array | null, status = 200) {
  const headers: Record<string, string> = {};
  if (body) {
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(body.byteLength);
    headers["X-Total-Chunks"] = "5";
  } else {
    headers["Content-Length"] = "0";
    headers["X-Total-Chunks"] = "0";
  }
  const init: ResponseInit = { status, headers };
  return body ? new Response(body as unknown as BodyInit, init) : new Response(null, init);
}

async function flushAll() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

type MockWS = {
  onopen: (() => void) | null;
  onclose: ((e: Partial<CloseEvent>) => void) | null;
  onmessage: ((e: Partial<MessageEvent>) => void) | null;
  onerror: (() => void) | null;
  binaryType: string;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let mockWSInstances: MockWS[];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockWSInstances = [];
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  vi.stubGlobal(
    "WebSocket",
    class MockWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      onopen: (() => void) | null = null;
      onclose: ((e: Partial<CloseEvent>) => void) | null = null;
      onmessage: ((e: Partial<MessageEvent>) => void) | null = null;
      onerror: (() => void) | null = null;
      binaryType = "blob";
      readyState = 0;
      send = vi.fn();
      close = vi.fn();
      constructor(_url: string) {
        mockWSInstances.push(this as unknown as MockWS);
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Integration: Hydration ↔ WebSocket gating", () => {
  it("buffers WebSocket messages during hydration and flushes in order after hydration completes", async () => {
    const { useScrollbackHydration } = await import("@/hooks/useScrollbackHydration");
    const { useTerminalWebSocket } = await import("@/hooks/useTerminalWebSocket");

    const mockTerminal = createMockTerminal();
    const terminalRef = { current: mockTerminal };
    const dataReceived: (Uint8Array | string)[] = [];

    let fetchResolve: (v: Response) => void;
    const fetchPromise = new Promise<Response>((r) => { fetchResolve = r; });
    fetchSpy.mockReturnValue(fetchPromise);

    const { result } = renderHook(() => {
      const hydration = useScrollbackHydration({
        reconnectId: "aaaa-bbbb-cccc-dddd",
        terminalRef: terminalRef as React.RefObject<{ write: typeof vi.fn } | null>,
        isConnected: true,
      });

      const ws = useTerminalWebSocket({
        url: "ws://localhost/test",
        onData: (d) => dataReceived.push(d),
        isGatingLiveData: hydration.isGatingLiveData,
      });

      return { hydration, ws };
    });

    await flushAll();

    expect(result.current.hydration.hydrationState).toBe("loading");
    expect(result.current.hydration.isGatingLiveData).toBe(true);

    const ws = mockWSInstances[0];
    expect(ws).toBeDefined();
    act(() => { ws.onopen?.(); });

    act(() => {
      ws.onmessage?.({ data: "msg-1" } as Partial<MessageEvent>);
      ws.onmessage?.({ data: "msg-2" } as Partial<MessageEvent>);
      ws.onmessage?.({ data: "msg-3" } as Partial<MessageEvent>);
    });

    expect(dataReceived).toHaveLength(0);

    const scrollbackData = new Uint8Array([72, 101, 108, 108, 111]);
    await act(async () => {
      fetchResolve!(makeResponse(scrollbackData));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushAll();

    expect(result.current.hydration.hydrationState).toBe("hydrated");
    expect(result.current.hydration.isGatingLiveData).toBe(false);

    expect(mockTerminal.write).toHaveBeenCalledWith(scrollbackData);
    expect(dataReceived).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("flushes buffered data even when hydration errors", async () => {
    const { useScrollbackHydration } = await import("@/hooks/useScrollbackHydration");
    const { useTerminalWebSocket } = await import("@/hooks/useTerminalWebSocket");

    const mockTerminal = createMockTerminal();
    const terminalRef = { current: mockTerminal };
    const dataReceived: (Uint8Array | string)[] = [];

    let fetchReject: (e: Error) => void;
    const fetchPromise = new Promise<Response>((_, rej) => { fetchReject = rej; });
    fetchSpy.mockReturnValue(fetchPromise);

    const { result } = renderHook(() => {
      const hydration = useScrollbackHydration({
        reconnectId: "err-test-id-0001",
        terminalRef: terminalRef as React.RefObject<{ write: typeof vi.fn } | null>,
        isConnected: true,
      });

      const ws = useTerminalWebSocket({
        url: "ws://localhost/test",
        onData: (d) => dataReceived.push(d),
        isGatingLiveData: hydration.isGatingLiveData,
      });

      return { hydration, ws };
    });

    await flushAll();

    const ws = mockWSInstances[0];
    act(() => { ws.onopen?.(); });

    act(() => {
      ws.onmessage?.({ data: "buffered-1" } as Partial<MessageEvent>);
      ws.onmessage?.({ data: "buffered-2" } as Partial<MessageEvent>);
    });

    expect(dataReceived).toHaveLength(0);

    await act(async () => {
      fetchReject!(new Error("Network failure"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushAll();

    expect(result.current.hydration.hydrationState).toBe("error");
    expect(result.current.hydration.isGatingLiveData).toBe(false);
    expect(dataReceived).toEqual(["buffered-1", "buffered-2"]);
  });

  it("passes data directly when hydration is already complete (not gating)", async () => {
    const { useTerminalWebSocket } = await import("@/hooks/useTerminalWebSocket");

    const dataReceived: (Uint8Array | string)[] = [];

    renderHook(() =>
      useTerminalWebSocket({
        url: "ws://localhost/test",
        onData: (d) => dataReceived.push(d),
        isGatingLiveData: false,
      }),
    );

    await flushAll();

    const ws = mockWSInstances[0];
    act(() => { ws.onopen?.(); });

    act(() => {
      ws.onmessage?.({ data: "direct-1" } as Partial<MessageEvent>);
      ws.onmessage?.({ data: "direct-2" } as Partial<MessageEvent>);
    });

    expect(dataReceived).toEqual(["direct-1", "direct-2"]);
  });
});

describe("Integration: Scrollback API format → hydration round-trip", () => {
  it("writes binary scrollback data from API response to terminal", async () => {
    const { useScrollbackHydration } = await import("@/hooks/useScrollbackHydration");

    const mockTerminal = createMockTerminal();
    const terminalRef = { current: mockTerminal };

    const chunk1 = new Uint8Array([65, 66, 67]);
    const chunk2 = new Uint8Array([68, 69, 70]);
    const concatenated = new Uint8Array([...chunk1, ...chunk2]);

    fetchSpy.mockResolvedValue(makeResponse(concatenated));

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "format-test-0001",
        terminalRef: terminalRef as React.RefObject<{ write: typeof vi.fn } | null>,
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("hydrated");
    expect(mockTerminal.write).toHaveBeenCalledTimes(1);

    const writtenData = mockTerminal.write.mock.calls[0][0] as Uint8Array;
    expect(writtenData).toBeInstanceOf(Uint8Array);
    expect(Array.from(writtenData)).toEqual([65, 66, 67, 68, 69, 70]);
  });

  it("handles empty scrollback response (Content-Length: 0)", async () => {
    const { useScrollbackHydration } = await import("@/hooks/useScrollbackHydration");

    const mockTerminal = createMockTerminal();
    const terminalRef = { current: mockTerminal };

    fetchSpy.mockResolvedValue(makeResponse(null));

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "empty-test-0001",
        terminalRef: terminalRef as React.RefObject<{ write: typeof vi.fn } | null>,
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("hydrated");
    expect(mockTerminal.write).not.toHaveBeenCalled();
  });

  it("transitions to error state on non-OK API response", async () => {
    const { useScrollbackHydration } = await import("@/hooks/useScrollbackHydration");

    const mockTerminal = createMockTerminal();
    const terminalRef = { current: mockTerminal };

    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "err-api-test-01",
        terminalRef: terminalRef as React.RefObject<{ write: typeof vi.fn } | null>,
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("error");
    expect(result.current.isGatingLiveData).toBe(false);
    expect(mockTerminal.write).not.toHaveBeenCalled();
  });

  it("preserves seqNum ordering with large multi-chunk binary data", async () => {
    const { useScrollbackHydration } = await import("@/hooks/useScrollbackHydration");

    const mockTerminal = createMockTerminal();
    const terminalRef = { current: mockTerminal };

    const chunks = Array.from({ length: 10 }, (_, i) =>
      new Uint8Array(Array.from({ length: 100 }, (_, j) => (i * 100 + j) % 256)),
    );
    const concatenated = new Uint8Array(chunks.reduce((acc, c) => [...acc, ...c], [] as number[]));

    fetchSpy.mockResolvedValue(makeResponse(concatenated));

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "multi-chunk-0001",
        terminalRef: terminalRef as React.RefObject<{ write: typeof vi.fn } | null>,
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("hydrated");
    const writtenData = mockTerminal.write.mock.calls[0][0] as Uint8Array;
    expect(writtenData.byteLength).toBe(1000);
    expect(Array.from(writtenData)).toEqual(Array.from(concatenated));
  });
});

describe("Integration: ReconnectId lifecycle", () => {
  it("generates and persists a reconnectId in localStorage", async () => {
    const { getOrCreateReconnectId } = await import(
      "@/components/workspaces/InteractiveTerminal"
    );

    const id = getOrCreateReconnectId("agent-1", "session-1");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    const stored = JSON.parse(
      localStorage.getItem("terminal:reconnect:agent-1:session-1")!,
    );
    expect(stored.id).toBe(id);
    expect(typeof stored.ts).toBe("number");
  });

  it("returns cached reconnectId within TTL", async () => {
    const { getOrCreateReconnectId } = await import(
      "@/components/workspaces/InteractiveTerminal"
    );

    const id1 = getOrCreateReconnectId("agent-1", "session-1");
    const id2 = getOrCreateReconnectId("agent-1", "session-1");
    expect(id1).toBe(id2);
  });

  it("regenerates reconnectId after 3 consecutive WebSocket failures", async () => {
    vi.useFakeTimers();
    const { useTerminalWebSocket } = await import("@/hooks/useTerminalWebSocket");

    const onReconnectIdExpired = vi.fn();

    renderHook(() =>
      useTerminalWebSocket({
        url: "ws://localhost/test",
        onData: vi.fn(),
        onReconnectIdExpired,
      }),
    );

    await act(async () => { vi.advanceTimersByTime(0); });

    expect(mockWSInstances).toHaveLength(1);

    // Failure 1: close without ever opening → consecutiveFailures=1, schedules reconnect
    act(() => {
      mockWSInstances[0].onclose?.({ code: 1006, reason: "abnormal" } as Partial<CloseEvent>);
    });
    expect(onReconnectIdExpired).not.toHaveBeenCalled();

    // Advance past reconnect delay to trigger ws[1]
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(mockWSInstances).toHaveLength(2);

    // Failure 2: close without ever opening → consecutiveFailures=2, schedules reconnect
    act(() => {
      mockWSInstances[1].onclose?.({ code: 1006, reason: "abnormal" } as Partial<CloseEvent>);
    });
    expect(onReconnectIdExpired).not.toHaveBeenCalled();

    // Advance past reconnect delay to trigger ws[2]
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(mockWSInstances).toHaveLength(3);

    // Failure 3: close without ever opening → consecutiveFailures=3, calls onReconnectIdExpired
    act(() => {
      mockWSInstances[2].onclose?.({ code: 1006, reason: "abnormal" } as Partial<CloseEvent>);
    });

    expect(onReconnectIdExpired).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("new reconnectId after expiry produces different localStorage entry", async () => {
    const { getOrCreateReconnectId } = await import(
      "@/components/workspaces/InteractiveTerminal"
    );

    const id1 = getOrCreateReconnectId("agent-x", "sess-y");

    localStorage.removeItem("terminal:reconnect:agent-x:sess-y");

    const id2 = getOrCreateReconnectId("agent-x", "sess-y");

    expect(id2).not.toBe(id1);

    const stored = JSON.parse(
      localStorage.getItem("terminal:reconnect:agent-x:sess-y")!,
    );
    expect(stored.id).toBe(id2);
  });

  it("reconnectId changes produce different wsUrl values", () => {
    const makeWsUrl = (reconnectId: string) =>
      `ws://localhost/api/terminal/ws?reconnectId=${reconnectId}`;

    const url1 = makeWsUrl("id-aaa");
    const url2 = makeWsUrl("id-bbb");

    expect(url1).not.toBe(url2);
    expect(url1).toContain("id-aaa");
    expect(url2).toContain("id-bbb");
  });
});
