import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScrollbackWriter } from "../src/scrollback-writer.js";

function makePool(behavior: "success" | "fail" | "fail-then-succeed" = "success") {
  let callCount = 0;
  const calls: Array<{ reconnectId: string; seqNum: number; byteSize: number }> = [];

  const pool = function (strings: TemplateStringsArray, ...values: unknown[]) {
    callCount++;
    const reconnectId = values[0] as string;
    const seqNum = values[3] as number;
    const byteSize = values[5] as number;
    calls.push({ reconnectId, seqNum, byteSize });

    if (behavior === "fail") {
      return Promise.reject(new Error("connection refused"));
    }
    if (behavior === "fail-then-succeed") {
      if (callCount <= 1) {
        return Promise.reject(new Error("connection refused"));
      }
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };

  return { pool: pool as unknown as import("postgres").Sql, calls, getCallCount: () => callCount };
}

const WRITER_OPTS = {
  reconnectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  agentId: "11111111-2222-3333-4444-555555555555",
  sessionName: "test-session",
};

describe("ScrollbackWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("append is synchronous — no immediate flush for small data", () => {
    const { pool, getCallCount } = makePool();
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool, flushIntervalMs: 60_000 });

    writer.append(Buffer.from("hello"));
    expect(getCallCount()).toBe(0);

    writer.close();
  });

  it("flushes when buffer exceeds 100KB threshold", async () => {
    const { pool, calls } = makePool();
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool, flushIntervalMs: 60_000 });

    const bigChunk = Buffer.alloc(102_400, 0x41);
    writer.append(bigChunk);

    await vi.advanceTimersByTimeAsync(0);

    expect(calls.length).toBe(1);
    expect(calls[0].byteSize).toBe(102_400);
    expect(calls[0].seqNum).toBe(0);

    await writer.close();
  });

  it("5s timer triggers flush of buffered data", async () => {
    const { pool, calls } = makePool();
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool });

    writer.append(Buffer.from("hello"));
    expect(calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls.length).toBe(1);
    expect(calls[0].byteSize).toBe(5);

    await writer.close();
  });

  it("flush failure pushes chunk to ring buffer and starts retry", async () => {
    const { pool, calls } = makePool("fail");
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool, flushIntervalMs: 60_000 });

    const data = Buffer.alloc(102_400, 0x42);
    writer.append(data);

    await vi.advanceTimersByTimeAsync(0);

    expect(calls.length).toBe(1);
    expect(console.error).toHaveBeenCalled();

    await writer.close();
  });

  it("ring buffer drains to DB on recovery with correct seqNum order", async () => {
    const { pool, calls } = makePool("fail-then-succeed");
    const writer = new ScrollbackWriter({
      ...WRITER_OPTS,
      pool,
      flushIntervalMs: 60_000,
    });

    const data = Buffer.alloc(102_400, 0x43);
    writer.append(data);

    await vi.advanceTimersByTimeAsync(0);

    expect(calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls.length).toBe(2);
    expect(calls[1].seqNum).toBe(0);

    await writer.close();
  });

  it("close() flushes remaining in-memory data", async () => {
    const { pool, calls } = makePool();
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool, flushIntervalMs: 60_000 });

    writer.append(Buffer.from("final data"));

    await writer.close();

    expect(calls.length).toBe(1);
    expect(calls[0].byteSize).toBe(10);
  });

  it("seqNum increments monotonically across flushes", async () => {
    const { pool, calls } = makePool();
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool });

    writer.append(Buffer.from("first"));
    await vi.advanceTimersByTimeAsync(5_000);

    writer.append(Buffer.from("second"));
    await vi.advanceTimersByTimeAsync(5_000);

    writer.append(Buffer.from("third"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls.map((c) => c.seqNum)).toEqual([0, 1, 2]);

    await writer.close();
  });

  it("concurrent appends during flush don't corrupt state", async () => {
    let resolveInsert: (() => void) | null = null;
    const calls: number[] = [];

    const slowPool = function (_strings: TemplateStringsArray, ..._values: unknown[]) {
      const seqNum = _values[3] as number;
      calls.push(seqNum);
      if (resolveInsert === null) {
        return new Promise<unknown[]>((resolve) => {
          resolveInsert = () => resolve([]);
        });
      }
      return Promise.resolve([]);
    } as unknown as import("postgres").Sql;

    const writer = new ScrollbackWriter({
      ...WRITER_OPTS,
      pool: slowPool,
      flushIntervalMs: 60_000,
      sizeThreshold: 10,
    });

    writer.append(Buffer.alloc(20, 0x41));

    const flushStarted = vi.advanceTimersByTimeAsync(0);

    writer.append(Buffer.alloc(20, 0x42));

    expect(calls).toEqual([0]);

    resolveInsert!();
    await flushStarted;
    await vi.advanceTimersByTimeAsync(0);

    await writer.close();

    expect(calls.length).toBe(2);
    expect(calls[0]).toBe(0);
    expect(calls[1]).toBe(1);
  });

  it("oversized single append (>256KB) triggers immediate flush", async () => {
    const { pool, calls } = makePool();
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool, flushIntervalMs: 60_000 });

    const oversized = Buffer.alloc(262_144, 0x44);
    writer.append(oversized);

    await vi.advanceTimersByTimeAsync(0);

    expect(calls.length).toBe(1);
    expect(calls[0].byteSize).toBe(262_144);

    await writer.close();
  });

  it("close with pending ring buffer data attempts final drain", async () => {
    let failCount = 0;
    const calls: number[] = [];

    const pool = function (_strings: TemplateStringsArray, ...values: unknown[]) {
      const seqNum = values[3] as number;
      failCount++;
      if (failCount <= 1) {
        return Promise.reject(new Error("fail first flush"));
      }
      calls.push(seqNum);
      return Promise.resolve([]);
    } as unknown as import("postgres").Sql;

    const writer = new ScrollbackWriter({
      ...WRITER_OPTS,
      pool,
      flushIntervalMs: 60_000,
    });

    const data = Buffer.alloc(102_400, 0x45);
    writer.append(data);

    await vi.advanceTimersByTimeAsync(0);

    expect(failCount).toBe(1);

    await writer.close();

    expect(calls).toContain(0);
  });

  it("does not flush after close", async () => {
    const { pool, calls } = makePool();
    const writer = new ScrollbackWriter({ ...WRITER_OPTS, pool });

    await writer.close();

    writer.append(Buffer.from("should be ignored"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls.length).toBe(0);
  });
});
