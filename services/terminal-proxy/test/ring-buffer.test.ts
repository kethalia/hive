import { describe, it, expect, vi } from "vitest";
import { BoundedRingBuffer } from "../src/ring-buffer.js";

describe("BoundedRingBuffer", () => {
  it("rejects capacity < 1", () => {
    expect(() => new BoundedRingBuffer(0)).toThrow("capacity must be >= 1");
    expect(() => new BoundedRingBuffer(-1)).toThrow("capacity must be >= 1");
  });

  it("tracks size and isFull", () => {
    const buf = new BoundedRingBuffer<number>(3);
    expect(buf.size).toBe(0);
    expect(buf.isFull).toBe(false);

    buf.push(1);
    expect(buf.size).toBe(1);
    expect(buf.isFull).toBe(false);

    buf.push(2);
    buf.push(3);
    expect(buf.size).toBe(3);
    expect(buf.isFull).toBe(true);
  });

  it("drains in FIFO order", () => {
    const buf = new BoundedRingBuffer<string>(5);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(buf.drain()).toEqual(["a", "b", "c"]);
  });

  it("returns empty array when draining empty buffer", () => {
    const buf = new BoundedRingBuffer<number>(3);
    expect(buf.drain()).toEqual([]);
  });

  it("overwrites oldest items when full", () => {
    const buf = new BoundedRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // overwrites 1
    buf.push(5); // overwrites 2

    expect(buf.size).toBe(3);
    expect(buf.isFull).toBe(true);
    expect(buf.drain()).toEqual([3, 4, 5]);
  });

  it("works with capacity=1", () => {
    const buf = new BoundedRingBuffer<string>(1);
    buf.push("first");
    expect(buf.size).toBe(1);
    expect(buf.isFull).toBe(true);
    expect(buf.drain()).toEqual(["first"]);

    buf.push("a");
    buf.push("b"); // overwrites a
    expect(buf.drain()).toEqual(["b"]);
  });

  it("supports push/drain interleaving", () => {
    const buf = new BoundedRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    expect(buf.drain()).toEqual([1, 2]);
    expect(buf.size).toBe(0);

    buf.push(3);
    buf.push(4);
    buf.push(5);
    expect(buf.drain()).toEqual([3, 4, 5]);
  });

  it("warns at >80% capacity", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const buf = new BoundedRingBuffer<number>(5);

    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(warnSpy).not.toHaveBeenCalled();

    buf.push(5); // 100% — triggers >80% warning
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("ring buffer at");

    warnSpy.mockRestore();
  });

  it("resets size after drain", () => {
    const buf = new BoundedRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.isFull).toBe(true);

    buf.drain();
    expect(buf.size).toBe(0);
    expect(buf.isFull).toBe(false);
  });
});
