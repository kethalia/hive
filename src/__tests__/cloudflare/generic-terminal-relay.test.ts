import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERIC_TERMINAL_LIFETIME_MS,
  type GenericTerminalDependencies,
  openGenericTerminalRelay,
  parseGenericTerminalTarget,
} from "../../../deploy/cloudflare/app/generic-terminal-relay";
import type { RelaySocket } from "../../../deploy/cloudflare/app/project-relay";

class Socket implements RelaySocket {
  readyState = 1;
  binaryType: "arraybuffer" | "blob" = "blob";
  bufferedAmount = 0;
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(event: string, listener: unknown) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(event, set);
  }
  removeEventListener(event: string, listener: unknown) {
    this.listeners.get(event)?.delete(listener as (event: never) => void);
  }
  emit(event: string, value: unknown = {}) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value as never);
  }
}
const origin = "https://hive.example";
const target = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  agentId: "20000000-0000-4000-8000-000000000001",
  reconnectId: "30000000-0000-4000-8000-000000000001",
  sessionName: "session-1",
  width: "80",
  height: "24",
};
const request = (query = new URLSearchParams(target).toString()) =>
  new Request(`${origin}/ws?${query}`, { headers: { Upgrade: "websocket", Origin: origin } });
let closers: Array<() => void> = [];
function fixture() {
  const server = new Socket(),
    client = new Socket(),
    upstream = new Socket();
  const authority = {
    sessionId: "session",
    userId: "hive-owner",
    coderUserId: "coder-owner",
    coderOrigin: "https://coder.example",
    token: "synthetic-credential",
    buildId: "build-1",
    expiresAt: Date.now() + 3600000,
  };
  const deps = {
    authorize: vi.fn(async () => ({ ...authority })),
    extend: vi.fn(async () => {}),
    upgrade: vi.fn(async (_url: string, _options: RequestInit) => ({
      status: 101,
      webSocket: upstream,
    })),
    pair: () => ({ client, server }),
    response: () => {
      const r = new Response();
      Object.defineProperty(r, "status", { value: 101 });
      return r;
    },
    trackCleanup: vi.fn(),
    onClosed: vi.fn(),
  } satisfies GenericTerminalDependencies;
  const open = async (r = request()) => {
    const value = await openGenericTerminalRelay(r, origin, Date.now() + 3600000, deps);
    closers.push(() => server.emit("close"));
    return value;
  };
  return { server, client, upstream, authority, deps, open };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
});
afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  await Promise.resolve();
  vi.useRealTimers();
});
describe("generic reconnecting PTY relay", () => {
  it("constructs the fixed Coder PTY, keeps owner credentials off browser output and preserves binary framing", async () => {
    const f = fixture();
    expect((await f.open()).status).toBe(101);
    const [url, options] = f.deps.upgrade.mock.calls[0];
    expect(url).toContain(`/api/v2/workspaceagents/${target.agentId}/pty?`);
    expect(new URL(url).searchParams.get("reconnect")).toBe(target.reconnectId);
    expect(new URL(url).searchParams.get("command")).toContain("new-session -A");
    expect(new Headers(options.headers).get("Coder-Session-Token")).toBe(f.authority.token);
    expect(options.redirect).toBe("manual");
    expect(f.server.send).toHaveBeenCalledWith('{"type":"hive:ready"}');
    f.server.emit("message", { data: '{"data":"printf hello\\n"}' });
    expect(new TextDecoder().decode(f.upstream.send.mock.calls[0][0])).toBe(
      '{"data":"printf hello\\n"}',
    );
    f.upstream.emit("message", { data: '{"type":"hive:ready"}' });
    expect(f.server.send.mock.calls.at(-1)?.[0]).toBeInstanceOf(Uint8Array);
    expect(JSON.stringify(f.server.send.mock.calls)).not.toContain(f.authority.token);
  });
  it.each([
    "command=x",
    "clonePath=repo",
    "agentId=duplicate",
  ])("rejects arbitrary or duplicate selectors %s before authorization", async (extra) => {
    const f = fixture();
    expect((await f.open(request(`${new URLSearchParams(target)}&${extra}`))).status).toBe(400);
    expect(f.deps.authorize).not.toHaveBeenCalled();
  });
  it("rejects reserved sessions and invalid dimensions", () => {
    for (const change of [
      { sessionName: "git-clone-abc" },
      { width: "0" },
      { height: "65536" },
      { sessionName: "x;id" },
    ])
      expect(
        parseGenericTerminalTarget(
          new URL(request(new URLSearchParams({ ...target, ...change }).toString()).url),
        ),
      ).toBeNull();
  });
  it("separates browser ping/resize and enforces bounded input", async () => {
    const f = fixture();
    await f.open();
    f.server.emit("message", { data: '{"type":"hive:ping","id":1}' });
    expect(f.server.send).toHaveBeenCalledWith('{"type":"hive:pong","id":1}');
    f.server.emit("message", { data: '{"height":40,"width":120}' });
    expect(new TextDecoder().decode(f.upstream.send.mock.calls[0][0])).toBe(
      '{"height":40,"width":120}',
    );
    f.server.emit("message", { data: '{"height":-1}' });
    expect(f.server.close).toHaveBeenCalledWith(1008, "Terminal input rejected");
    await f.deps.trackCleanup.mock.calls[0]?.[0];
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
  });
  it("reauthorizes after ticket admission and closes on build replacement", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(1);
    f.deps.authorize.mockResolvedValue({ ...f.authority, buildId: "build-2" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.server.close).toHaveBeenCalledWith(4404, "Workspace offline");
  });
  it("treats unavailable refresh as recoverable rather than signing the owner out", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(1);
    f.deps.authorize.mockRejectedValue(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.server.close).toHaveBeenCalledWith(1013, "Terminal authorization unavailable");
  });
  it("recycles only the attachment at the bounded lifespan and keeps reconnect identity", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(GENERIC_TERMINAL_LIFETIME_MS);
    expect(f.server.close).toHaveBeenCalledWith(1013, "Terminal attachment renewal");
    expect(f.deps.upgrade).toHaveBeenCalledOnce();
    expect(f.deps.extend).toHaveBeenCalled();
    const next = fixture();
    await next.open();
    expect(new URL(next.deps.upgrade.mock.calls[0][0]).searchParams.get("reconnect")).toBe(
      target.reconnectId,
    );
  });
  it("closes bounded output/backpressure without interpreting raw terminal controls", async () => {
    const f = fixture();
    await f.open();
    f.server.bufferedAmount = 1048577;
    f.upstream.emit("message", { data: new Uint8Array([1]) });
    expect(f.server.close).toHaveBeenCalledWith(1013, "Terminal attachment budget reached");
    const bytes = fixture();
    await bytes.open();
    for (let i = 0; i < 5; i++) bytes.upstream.emit("message", { data: new Uint8Array(1048576) });
    expect(bytes.server.close).toHaveBeenCalledWith(1013, "Terminal attachment budget reached");
  });
});
