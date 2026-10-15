import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followTemplatePush } from "@/lib/templates/push-stream";

class MockSource {
  static instances: MockSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  status: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockSource.instances.push(this);
  }
  addEventListener(_type: string, handler: (event: MessageEvent) => void) {
    this.status = handler;
  }
  close() {
    this.closed = true;
  }
  line(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  result(data: string) {
    this.status?.(new MessageEvent("status", { data }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  MockSource.instances = [];
  vi.stubGlobal("EventSource", MockSource);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function follow() {
  const callbacks = { onLine: vi.fn(), onStatus: vi.fn(), onReconnect: vi.fn() };
  const stop = followTemplatePush("ai-dev-k8s", "job-1", callbacks);
  return { ...callbacks, stop };
}

describe("template push stream recovery", () => {
  it("reconnects the same job with backoff without inventing a terminal failure", async () => {
    const { onStatus, onReconnect } = follow();
    MockSource.instances[0].onerror?.();
    expect(onStatus).not.toHaveBeenCalled();
    expect(MockSource.instances[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    MockSource.instances[1].onerror?.();
    await vi.advanceTimersByTimeAsync(1999);
    expect(MockSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockSource.instances).toHaveLength(3);
    expect(new Set(MockSource.instances.map((source) => source.url))).toEqual(
      new Set(["/api/templates/ai-dev-k8s/push/job-1/stream"]),
    );
    MockSource.instances[2].result('{"success":true}');
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({ success: true });
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips replayed lines and ignores events from superseded connections", async () => {
    const { onLine, onStatus } = follow();
    const first = MockSource.instances[0];
    first.line("one");
    first.line("");
    first.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    first.result('{"success":false}');
    const next = MockSource.instances[1];
    next.line("one");
    next.line("");
    next.line("three");
    expect(onLine.mock.calls).toEqual([["one"], [""], ["three"]]);
    expect(onStatus).not.toHaveBeenCalled();
    next.result('{"success":false,"error":"Push failed"}');
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({ success: false, error: "Push failed" });
  });

  it("cancels pending reconnects when the caller leaves", async () => {
    const { stop, onStatus } = follow();
    MockSource.instances[0].onerror?.();
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockSource.instances).toHaveLength(1);
    expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries malformed status events instead of enabling a duplicate push", async () => {
    const { stop, onStatus } = follow();
    MockSource.instances[0].result("{}");
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockSource.instances).toHaveLength(2);
    expect(onStatus).not.toHaveBeenCalled();
    stop();
  });

  it("recovers if stream construction initially fails", async () => {
    vi.stubGlobal(
      "EventSource",
      vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("offline");
        })
        .mockImplementation((url: string) => new MockSource(url)),
    );
    const { stop, onStatus } = follow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockSource.instances).toHaveLength(1);
    expect(onStatus).not.toHaveBeenCalled();
    stop();
  });
});
