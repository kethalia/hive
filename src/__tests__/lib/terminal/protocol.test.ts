import { describe, expect, it } from "vitest";

import { decodeOutput, encodeInput, encodeResize } from "@/lib/terminal/protocol";

describe("encodeInput", () => {
  it("produces valid JSON with data field", () => {
    const result = JSON.parse(encodeInput("hello"));
    expect(result).toEqual({ data: "hello" });
  });

  it("handles newlines", () => {
    const result = JSON.parse(encodeInput("line1\nline2"));
    expect(result.data).toBe("line1\nline2");
  });

  it("handles quotes", () => {
    const result = JSON.parse(encodeInput('say "hi"'));
    expect(result.data).toBe('say "hi"');
  });

  it("handles unicode", () => {
    const result = JSON.parse(encodeInput("こんにちは"));
    expect(result.data).toBe("こんにちは");
  });

  it("handles empty string", () => {
    const result = JSON.parse(encodeInput(""));
    expect(result).toEqual({ data: "" });
  });
});

describe("encodeResize", () => {
  it("produces valid JSON with height/width fields", () => {
    const result = JSON.parse(encodeResize(24, 80));
    expect(result).toEqual({ height: 24, width: 80 });
  });

  it("omits zero rows", () => {
    const result = JSON.parse(encodeResize(0, 80));
    expect(result).toEqual({ width: 80 });
    expect(result.height).toBeUndefined();
  });

  it("omits zero cols", () => {
    const result = JSON.parse(encodeResize(24, 0));
    expect(result).toEqual({ height: 24 });
    expect(result.width).toBeUndefined();
  });

  it("returns empty object for zero dimensions", () => {
    const result = JSON.parse(encodeResize(0, 0));
    expect(result).toEqual({});
  });

  it("omits negative dimensions", () => {
    const result = JSON.parse(encodeResize(-1, -5));
    expect(result).toEqual({});
  });
});

describe("decodeOutput", () => {
  it("passes through string as-is", () => {
    const result = decodeOutput("terminal output");
    expect(result).toBe("terminal output");
  });

  it("converts ArrayBuffer to Uint8Array", () => {
    const buf = new ArrayBuffer(4);
    const view = new Uint8Array(buf);
    view.set([0x48, 0x69, 0x21, 0x0a]);

    const result = decodeOutput(buf);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(new Uint8Array([0x48, 0x69, 0x21, 0x0a]));
  });

  it("handles empty ArrayBuffer", () => {
    const result = decodeOutput(new ArrayBuffer(0));
    expect(result).toBeInstanceOf(Uint8Array);
    expect((result as Uint8Array).length).toBe(0);
  });
});
