import { describe, expect, it } from "vitest";

import {
  buildPtyUrl,
  decodeOutput,
  encodeInput,
  encodeResize,
} from "@/lib/terminal/protocol";

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

describe("buildPtyUrl", () => {
  const defaults = {
    reconnectId: "550e8400-e29b-41d4-a716-446655440000",
    width: 80,
    height: 24,
    sessionName: "my-session",
  };
  const agentId = "agent-123";

  it("constructs correct URL with all parameters", () => {
    const url = buildPtyUrl("https://coder.example.com", agentId, defaults);
    expect(url).toContain("wss://coder.example.com/api/v2/workspaceagents/agent-123/pty?");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("reconnect")).toBe(defaults.reconnectId);
    expect(parsed.searchParams.get("width")).toBe("80");
    expect(parsed.searchParams.get("height")).toBe("24");
    expect(parsed.searchParams.get("command")).toBe("tmux new-session -A -s my-session");
  });

  it("converts http:// to ws://", () => {
    const url = buildPtyUrl("http://localhost:3000", agentId, defaults);
    expect(url).toMatch(/^ws:\/\/localhost:3000\//);
  });

  it("converts https:// to wss://", () => {
    const url = buildPtyUrl("https://coder.dev", agentId, defaults);
    expect(url).toMatch(/^wss:\/\/coder.dev\//);
  });

  it("strips trailing slash from base URL", () => {
    const url = buildPtyUrl("https://coder.dev/", agentId, defaults);
    expect(url).toContain("wss://coder.dev/api/v2/");
    expect(url).not.toContain("//api/");
  });

  it("strips multiple trailing slashes from base URL", () => {
    const url = buildPtyUrl("https://coder.dev///", agentId, defaults);
    expect(url).toContain("wss://coder.dev/api/v2/");
    expect(url).not.toContain("//api/");
  });

  it("URL-encodes the tmux command", () => {
    const url = buildPtyUrl("https://coder.dev", agentId, defaults);
    expect(url).toContain("command=tmux+new-session+-A+-s+my-session");
  });

  it("rejects session name with spaces", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "my session" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects session name with semicolons", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "foo;rm -rf" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects session name with backticks", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "`whoami`" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects empty session name", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects session name with shell pipe", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "a|b" }),
    ).toThrow(/Invalid session name/);
  });

  it("accepts valid session names with dots, hyphens, underscores", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "my_session.v2-beta" }),
    ).not.toThrow();
  });
});
