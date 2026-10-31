import { describe, expect, it, vi } from "vitest";
import { runRequestLifetime } from "../../../../deploy/cloudflare/app/request-lifetime";

describe("Worker database request lifetime", () => {
  it("keeps the client alive until both streamed output and after work finish", async () => {
    const close = vi.fn(async () => {});
    const waits: Promise<unknown>[] = [];
    const context = {
      waitUntil: (task: Promise<unknown>) => waits.push(task),
      passThroughOnException() {},
    };
    let finishAfter!: () => void;
    const after = new Promise<void>((resolve) => {
      finishAfter = resolve;
    });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    const result = await runRequestLifetime(
      { run: (fn) => fn(), close },
      context,
      async (tracked) => {
        tracked.waitUntil(after);
        return new Response(body);
      },
    );
    expect(close).not.toHaveBeenCalled();
    const received = result.text();
    stream.enqueue(new TextEncoder().encode("rendered"));
    stream.close();
    expect(await received).toBe("rendered");
    expect(close).not.toHaveBeenCalled();
    finishAfter();
    await Promise.all(waits);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cleans up a canceled stream and an exceptional render", async () => {
    const waits: Promise<unknown>[] = [];
    const context = {
      waitUntil: (task: Promise<unknown>) => waits.push(task),
      passThroughOnException() {},
    };
    const close = vi.fn(async () => {});
    const canceled = await runRequestLifetime(
      { run: (fn) => fn(), close },
      context,
      async () => new Response(new ReadableStream()),
    );
    await canceled.body?.cancel();
    await Promise.all(waits);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(
      runRequestLifetime({ run: (fn) => fn(), close }, context, async () => {
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects upgrades instead of wrapping a WebSocket response as a stream", async () => {
    const close = vi.fn(async () => {});
    const context = { waitUntil() {}, passThroughOnException() {} };
    await expect(
      runRequestLifetime(
        { run: (fn) => fn(), close },
        context,
        async () => ({ status: 101 }) as Response,
      ),
    ).rejects.toThrow("dedicated lifetime adapter");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
