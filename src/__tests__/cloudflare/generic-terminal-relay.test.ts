import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyTerminalClose } from "@/hooks/useTerminalWebSocket";
import { createCloneSessionKey, createSafeCloneTerminalSessionName } from "@/lib/git/clone-tree";
import { GenericTerminalFailure } from "@/lib/terminal/generic-auth.server";
import type { RelaySocket } from "@/lib/terminal/relay-types";
import {
  GENERIC_TERMINAL_LIFETIME_MS,
  type GenericTerminalDependencies,
  openGenericTerminalRelay,
  parseGenericTerminalTarget,
} from "../../../deploy/cloudflare/app/generic-terminal-relay";

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
  it("preserves canonical clone session/path and the existing quoted PTY cwd", async () => {
    const f = fixture(),
      clonePath = "projects/owner/repo with spaces";
    const sessionName = createSafeCloneTerminalSessionName(
      createCloneSessionKey(clonePath.split("/")),
    );
    const params = new URLSearchParams({
      ...target,
      sessionName,
      clonePath,
      cloneProof: `${"a".repeat(80)}.${"b".repeat(43)}`,
    });
    expect(parseGenericTerminalTarget(new URL(request(params.toString()).url))).toMatchObject({
      sessionName,
      clonePath,
    });
    expect((await f.open(request(params.toString()))).status).toBe(101);
    const command = new URL(f.deps.upgrade.mock.calls[0][0]).searchParams.get("command");
    expect(command).toContain(`-s ${sessionName}`);
    expect(command).toContain("-c '/home/coder/projects/owner/repo with spaces'");
  });
  it.each([
    "../repo",
    "projects//repo",
    "/absolute/repo",
    "projects/./repo",
    "projects\\repo",
  ])("rejects clone traversal or noncanonical path %s", (clonePath) => {
    const sessionName = createSafeCloneTerminalSessionName(
      createCloneSessionKey(clonePath.split("/")),
    );
    const params = new URLSearchParams({
      ...target,
      sessionName,
      clonePath,
      cloneProof: `${"a".repeat(80)}.${"b".repeat(43)}`,
    });
    expect(parseGenericTerminalTarget(new URL(request(params.toString()).url))).toBeNull();
  });

  it("registers diagnostics before READY and drains close in the callback lifetime", async () => {
    const f = fixture();
    let open!: (value: boolean) => void, close!: () => void;
    const diagnostics = {
      connectionId: "10000000-0000-4000-8000-000000000001" as const,
      open: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            open = resolve;
          }),
      ),
      heartbeat: vi.fn(async () => true),
      activity: vi.fn(),
      event: vi.fn(async (_type: string) => {}),
      keepalive: vi.fn(async () => {}),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            close = resolve;
          }),
      ),
    };
    const deps = {
      ...f.deps,
      diagnostics: vi.fn(() => diagnostics),
      extend: vi.fn(async () => ({
        ok: false,
        httpStatus: 409,
        category: "manual-shutdown" as const,
        durationMs: 12,
      })),
    };
    const opening = openGenericTerminalRelay(request(), origin, Date.now() + 3600000, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.server.send).not.toHaveBeenCalled();
    expect(f.deps.upgrade).not.toHaveBeenCalled();
    open(true);
    expect((await opening).status).toBe(101);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.event.mock.calls.map(([type]) => type)).toEqual([
      "upstream_connecting",
      "upstream_connected",
    ]);
    expect(f.server.send).toHaveBeenCalledWith('{"type":"hive:ready"}');
    f.server.emit("message", { data: '{"data":"echo safe"}' });
    f.upstream.emit("message", { data: new Uint8Array([1, 2, 3]).buffer });
    expect(diagnostics.activity).toHaveBeenCalledWith("browser_input", 20);
    expect(diagnostics.activity).toHaveBeenCalledWith("upstream_output", 3);
    expect(diagnostics.heartbeat).toHaveBeenCalledOnce();
    expect(diagnostics.keepalive).toHaveBeenCalledWith({
      ok: false,
      httpStatus: 409,
      category: "manual-shutdown",
      durationMs: 12,
    });
    expect(deps.extend).toHaveBeenCalledOnce();
    f.server.emit("close", { code: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.close).toHaveBeenCalledWith(1013, "browser_disconnected");
    expect(f.deps.onClosed).not.toHaveBeenCalled();
    close();
    await Promise.all(f.deps.trackCleanup.mock.calls.map(([work]) => work));
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never emits READY if diagnostic registration fails", async () => {
    const f = fixture();
    const diagnostics = {
      connectionId: "10000000-0000-4000-8000-000000000001" as const,
      open: vi.fn(async () => false),
      activity: vi.fn(),
      heartbeat: vi.fn(async () => true),
      event: vi.fn(async (_type: string) => {}),
      keepalive: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const deps = { ...f.deps, diagnostics: () => diagnostics };
    expect(
      (await openGenericTerminalRelay(request(), origin, Date.now() + 3600000, deps)).status,
    ).toBe(401);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.server.send).not.toHaveBeenCalled();
    expect(f.deps.upgrade).not.toHaveBeenCalled();
    expect(diagnostics.close).toHaveBeenCalledWith(1011, "upstream_error");
  });

  it("preserves a normal upstream exit as a final close for the actual hook classifier", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(0);
    f.upstream.emit("close", {
      code: 1000,
      reason: "synthetic private provider detail unauthorized",
      wasClean: true,
    });
    expect(f.server.close).toHaveBeenCalledWith(1000, "Terminal session closed");
    expect(f.upstream.close).toHaveBeenCalledWith(1000, "Terminal session closed");
    const [code, reason] = f.server.close.mock.calls[0];
    expect(classifyTerminalClose({ code, reason, wasClean: true })).toMatchObject({
      closeCategory: "terminal-closed",
      failureCategory: "terminal-closed",
      recoverable: false,
    });
    await vi.advanceTimersByTimeAsync(GENERIC_TERMINAL_LIFETIME_MS);
    expect(f.server.close).toHaveBeenCalledOnce();
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
    expect(f.deps.authorize).toHaveBeenCalledTimes(2);
  });
  it.each([
    undefined,
    1001,
    1006,
    1008,
    1011,
    1013,
  ])("keeps upstream close %s retryable without forwarding its reason", async (upstreamCode) => {
    const f = fixture();
    await f.open();
    f.upstream.emit("close", {
      code: upstreamCode,
      reason: "synthetic private provider detail unauthorized",
    });
    expect(f.server.close).toHaveBeenCalledWith(1013, "Terminal peer closed");
    const [code, reason] = f.server.close.mock.calls[0];
    expect(classifyTerminalClose({ code, reason, wasClean: true })).toMatchObject({
      closeCategory: "transient",
      recoverable: true,
    });
  });
  it("keeps an upstream socket error retryable for the actual hook classifier", async () => {
    const f = fixture();
    await f.open();
    f.upstream.emit("error");
    expect(f.server.close).toHaveBeenCalledWith(1011, "Terminal transport unavailable");
    const [code, reason] = f.server.close.mock.calls[0];
    expect(classifyTerminalClose({ code, reason, wasClean: true }).recoverable).toBe(true);
  });
  it.each([
    4401, 4403,
  ] as const)("closes an established attachment with authorization code %s", async (code) => {
    const f = fixture();
    expect((await f.open()).status).toBe(101);
    await vi.advanceTimersByTimeAsync(0);
    f.deps.authorize.mockRejectedValue(new GenericTerminalFailure(code));
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.server.close).toHaveBeenCalledWith(code, "Terminal authorization expired");
    expect(f.upstream.close).toHaveBeenCalledWith(code, "Terminal authorization expired");
  });
  it.each([
    401, 403,
  ])("preserves upstream PTY authentication/permission refusal %s before upgrade", async (status) => {
    const f = fixture();
    f.deps.upgrade.mockResolvedValue({ status, webSocket: f.upstream });
    expect((await f.open()).status).toBe(status);
    expect(f.server.accept).not.toHaveBeenCalled();
  });
  it("uses password session credentials for PTY upgrades with bounded refresh and lifetime", async () => {
    const f = fixture();
    expect((await f.open()).status).toBe(101);
    const headers = new Headers(f.deps.upgrade.mock.calls[0][1].headers);
    expect(headers.get("Coder-Session-Token")).toBe("synthetic-credential");
    expect(headers.has("Authorization")).toBe(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.deps.authorize).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(GENERIC_TERMINAL_LIFETIME_MS - 20000);
    expect(f.server.close).toHaveBeenCalled();
  });
  it("admits delayed session authorization inside the bounded setup handshake", async () => {
    const f = fixture();
    const original = f.deps.authorize.getMockImplementation()!;
    f.deps.authorize.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      return original();
    });
    const opening = f.open();
    await vi.advanceTimersByTimeAsync(15000);
    expect((await opening).status).toBe(101);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.server.close).not.toHaveBeenCalled();
    expect(f.deps.extend).toHaveBeenCalledOnce();
  });
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
      { sessionName: "x".repeat(201) },
    ])
      expect(
        parseGenericTerminalTarget(
          new URL(request(new URLSearchParams({ ...target, ...change }).toString()).url),
        ),
      ).toBeNull();
  });
  it.each([129, 200])("accepts existing terminal names of %i characters", (length) => {
    const sessionName = "x".repeat(length);
    const url = new URL(request(new URLSearchParams({ ...target, sessionName }).toString()).url);
    expect(parseGenericTerminalTarget(url)?.sessionName).toBe(sessionName);
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
