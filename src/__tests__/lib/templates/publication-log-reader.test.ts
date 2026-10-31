import { afterEach, describe, expect, it, vi } from "vitest";
import { readTemplateLogArray } from "@/lib/templates/publication-log-reader";

const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
function chunks(value: string, size: number) {
  const bytes = new TextEncoder().encode(value);
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= bytes.length) {
          c.close();
          return;
        }
        c.enqueue(bytes.subarray(at, at + size));
        at += size;
      },
    }),
  );
}
describe("bounded incremental template log array", () => {
  it("preserves complete rows across every UTF8/escape boundary", async () => {
    const output = 'emoji 🐝 quote " nested } ] slash \\ newline\n';
    const page = await readTemplateLogArray(
      chunks(
        JSON.stringify([
          { id: 2, output, stage: "plan" },
          { id: 4, output: "next" },
        ]),
        1,
      ),
      "1",
      signal(),
    );
    expect(page).toEqual({
      records: [
        { id: "2", output, stage: "plan" },
        { id: "4", output: "next" },
      ],
      nextAfter: "4",
      hasMore: false,
      fallback: null,
    });
  });
  it("stops at128 complete rows and never advances to an unconsumed row", async () => {
    const page = await readTemplateLogArray(
      chunks(
        JSON.stringify(Array.from({ length: 130 }, (_, n) => ({ id: n + 1, output: "line" }))),
        27,
      ),
      "0",
      signal(),
    );
    expect(page.records).toHaveLength(128);
    expect(page.nextAfter).toBe("128");
    expect(page.hasMore).toBe(true);
    expect(page.fallback).toBe("record_limit");
  });
  it("oversized first row returns no fabricated cursor; next read must face that same row", async () => {
    const page = await readTemplateLogArray(
      chunks(
        JSON.stringify([
          { id: 3, output: "x".repeat(40000) },
          { id: 4, output: "must not skip" },
        ]),
        4096,
      ),
      "2",
      signal(),
    );
    expect(page.records).toEqual([]);
    expect(page.nextAfter).toBe("2");
    expect(page.fallback).toBe("row_too_large");
  });
  it("malformed and duplicate IDs retain only the last validated prefix", async () => {
    for (const bad of [
      '{"id":1,"output":"duplicate"}',
      '{"id":2,"output":false}',
      '{"id":2,"output":"bad",}',
      "null",
    ]) {
      const page = await readTemplateLogArray(
        chunks(`[{"id":1,"output":"valid"},${bad}]`, 3),
        "0",
        signal(),
      );
      expect(page.records).toEqual([{ id: "1", output: "valid" }]);
      expect(page.nextAfter).toBe("1");
      expect(page.fallback).toBe("malformed");
    }
  });
  it("total byte cutoff leaves a partial next row unaccepted", async () => {
    const page = await readTemplateLogArray(
      chunks(
        JSON.stringify(
          Array.from({ length: 10 }, (_, n) => ({ id: n + 1, output: "x".repeat(30000) })),
        ),
        8192,
      ),
      "0",
      signal(),
    );
    expect(page.records).toHaveLength(8);
    expect(page.nextAfter).toBe("8");
    expect(page.fallback).toBe("byte_limit");
  });
  it("rejects trailing garbage, invalid UTF8 and trailing commas", async () => {
    for (const value of ['[{"id":1,"output":"ok"}]BAD', '[{"id":1,"output":"ok"},]'])
      expect((await readTemplateLogArray(chunks(value, 2), "0", signal())).fallback).toBe(
        "malformed",
      );
    expect(
      (await readTemplateLogArray(new Response(new Uint8Array([91, 255, 93])), "0", signal()))
        .fallback,
    ).toBe("malformed");
  });
  it("deadline races stalled read and hung cancellation", async () => {
    vi.useFakeTimers();
    const abort = new AbortController(),
      cancel = vi.fn(() => new Promise<void>(() => {}));
    const pending = readTemplateLogArray(
      new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel })),
      "0",
      abort.signal,
    );
    abort.abort();
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending).fallback).toBe("deadline");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("empty chunk flood is bounded independently of deadline scheduling", async () => {
    const page = await readTemplateLogArray(
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array());
          },
        }),
      ),
      "0",
      signal(),
    );
    expect(page.fallback).toBe("chunk_limit");
    expect(page.nextAfter).toBe("0");
  });
});
