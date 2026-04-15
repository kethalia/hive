// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollbackHydration } from "@/hooks/useScrollbackHydration";

function createMockTerminal() {
  return {
    write: vi.fn(),
    dispose: vi.fn(),
  };
}

async function flushAll() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
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

describe("useScrollbackHydration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should start in idle state when not connected", () => {
    const terminal = createMockTerminal();
    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "test-uuid",
        terminalRef: { current: terminal as never },
        isConnected: false,
      }),
    );

    expect(result.current.hydrationState).toBe("idle");
    expect(result.current.isGatingLiveData).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("should not fetch when reconnectId is null", () => {
    const terminal = createMockTerminal();
    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: null,
        terminalRef: { current: terminal as never },
        isConnected: true,
      }),
    );

    expect(result.current.hydrationState).toBe("idle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("should fetch scrollback and write to terminal on success", async () => {
    const terminal = createMockTerminal();
    const scrollbackData = new Uint8Array([72, 101, 108, 108, 111]);
    fetchSpy.mockResolvedValue(makeResponse(scrollbackData));

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "abc-123",
        terminalRef: { current: terminal as never },
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("hydrated");
    expect(result.current.isGatingLiveData).toBe(false);
    expect(terminal.write).toHaveBeenCalled();
    const writtenData = terminal.write.mock.calls[0][0] as Uint8Array;
    expect(writtenData).toBeInstanceOf(Uint8Array);
    expect(writtenData.byteLength).toBe(5);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/terminal/scrollback?reconnectId=abc-123&limit=50",
    );
  });

  it("should handle empty scrollback (Content-Length: 0)", async () => {
    const terminal = createMockTerminal();
    fetchSpy.mockResolvedValue(makeResponse(null));

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "abc-123",
        terminalRef: { current: terminal as never },
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("hydrated");
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("should transition to error state on fetch failure", async () => {
    const terminal = createMockTerminal();
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "abc-123",
        terminalRef: { current: terminal as never },
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("error");
    expect(result.current.isGatingLiveData).toBe(false);
    expect(terminal.write).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("reconnectId=abc-123"),
      expect.any(String),
    );
  });

  it("should transition to error state on non-OK response", async () => {
    const terminal = createMockTerminal();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "abc-123",
        terminalRef: { current: terminal as never },
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("error");
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("should only hydrate once even across rerenders", async () => {
    const terminal = createMockTerminal();
    fetchSpy.mockResolvedValue(makeResponse(new Uint8Array([1, 2, 3])));

    const { result, rerender } = renderHook(
      ({ isConnected }) =>
        useScrollbackHydration({
          reconnectId: "abc-123",
          terminalRef: { current: terminal as never },
          isConnected,
        }),
      { initialProps: { isConnected: true } },
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("hydrated");

    const callCount = fetchSpy.mock.calls.length;
    rerender({ isConnected: true });
    await flushAll();

    expect(fetchSpy.mock.calls.length).toBe(callCount);
  });

  it("should log hydration state transitions to console", async () => {
    const terminal = createMockTerminal();
    fetchSpy.mockResolvedValue(makeResponse(new Uint8Array([1])));

    renderHook(() =>
      useScrollbackHydration({
        reconnectId: "abc-123",
        terminalRef: { current: terminal as never },
        isConnected: true,
      }),
    );

    await flushAll();

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("idle → loading"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("loading → hydrated"),
    );
  });

  it("isGatingLiveData is true only during loading state", async () => {
    const terminal = createMockTerminal();
    let resolvePromise!: (value: Response) => void;
    fetchSpy.mockImplementation(
      () => new Promise((resolve) => { resolvePromise = resolve; }),
    );

    const { result } = renderHook(() =>
      useScrollbackHydration({
        reconnectId: "abc-123",
        terminalRef: { current: terminal as never },
        isConnected: true,
      }),
    );

    await flushAll();

    expect(result.current.hydrationState).toBe("loading");
    expect(result.current.isGatingLiveData).toBe(true);

    resolvePromise(makeResponse(new Uint8Array([1])));
    await flushAll();

    expect(result.current.hydrationState).toBe("hydrated");
    expect(result.current.isGatingLiveData).toBe(false);
  });
});
