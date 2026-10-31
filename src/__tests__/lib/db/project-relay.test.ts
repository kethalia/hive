import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openProjectRelay,
  projectRelayPath,
  RELAY_MAX_FRAME,
  type RelayDependencies,
  type RelaySocket,
} from "../../../../deploy/cloudflare/app/project-relay";

class Socket implements RelaySocket {
  binaryType: "blob" | "arraybuffer" = "blob";
  readyState = 1;
  bufferedAmount = 0;
  listeners = new Map<string, Set<(event: never) => void>>();
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  addEventListener(event: string, callback: unknown) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback as (event: never) => void);
    this.listeners.set(event, set);
  }
  removeEventListener(event: string, callback: unknown) {
    this.listeners.get(event)?.delete(callback as (event: never) => void);
  }
  emit(event: string, value: unknown = {}) {
    for (const callback of [...(this.listeners.get(event) ?? [])]) callback(value as never);
  }
}
const origin = "https://preview.example",
  projectId = "00000000-0000-4000-8000-000000000001";
const now = Date.parse("2026-10-29T18:00:00Z");
const closers: Array<() => void> = [];
function request(path = `/api/projects/${projectId}/session`, extra: HeadersInit = {}) {
  return new Request(`${origin}${path}`, {
    headers: {
      Origin: origin,
      Upgrade: "websocket",
      Cookie: "owner-cookie=must-not-forward",
      Authorization: "Bearer must-not-forward",
      ...extra,
    },
  });
}
function fixture() {
  const server = new Socket(),
    client = new Socket(),
    upstream = new Socket();
  const principal = {
    hiveUserId: "hive-owner",
    coderUserId: "coder-owner",
    coderOrigin: "https://coder.example",
    expiresAt: now + 3600000,
  };
  const target = {
    coderOrigin: principal.coderOrigin,
    appOrigin: "https://registered-app.example",
    registrationId: "registration",
    expiresAt: Math.floor(now / 1000) + 600,
    binding: {
      ownerId: principal.coderUserId,
      workspaceId: "workspace",
      buildId: "build",
      serverInstanceId: "instance",
      threadId: "thread",
    },
  };
  const deps = {
    authenticate: vi.fn().mockResolvedValue(principal),
    authorize: vi.fn().mockResolvedValue(target),
    reauthorize: vi.fn().mockImplementation(async () => ({ principal, target })),
    trackCleanup: vi.fn(),
    exchange: vi.fn().mockImplementation(async (_principal, target, kind) => ({
      url: `${target.appOrigin}/${kind}`,
      cookie: `coder_subdomain_app_session_token_${"a".repeat(32)}=scoped-cookie`,
    })),
    upgrade: vi.fn().mockResolvedValue({ status: 101, webSocket: upstream }),
    pair: () => ({ client, server }),
    response: () => {
      const response = new Response(null, { headers: { "Cache-Control": "private, no-store" } });
      Object.defineProperty(response, "status", { value: 101 });
      return response;
    },
    now: () => Date.now(),
    onClosed: vi.fn(),
  } satisfies RelayDependencies;
  return {
    server,
    client,
    upstream,
    principal,
    target,
    deps,
    open: async (r = request(), expires = now + 900000) => {
      const result = await openProjectRelay(r, origin, expires, deps);
      closers.push(result.close);
      return result;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scoped project WebSocket relay", () => {
  it("accepts only exact UUID project session/terminal paths without query or subprotocol authority", async () => {
    expect(projectRelayPath(request(`/api/projects/${projectId}/terminal`))).toEqual({
      projectId,
      kind: "terminal",
    });
    expect(projectRelayPath(request("/api/workspace-proxy/anything"))).toBeNull();
    for (const r of [
      request(`/api/projects/${projectId}/session?token=forbidden`),
      request(`/api/projects/${projectId}/session`, { "Sec-WebSocket-Protocol": "unexpected" }),
    ]) {
      const f = fixture();
      expect((await f.open(r)).response.status).toBe(400);
      expect(f.deps.authenticate).not.toHaveBeenCalled();
    }
  });
  it("authenticates owner twice, rechecks target after exchange and forwards only fixed scoped headers", async () => {
    const f = fixture();
    const result = await f.open();
    expect(result.response.status).toBe(101);
    expect(f.server.binaryType).toBe("arraybuffer");
    expect(f.upstream.binaryType).toBe("arraybuffer");
    expect(f.deps.authenticate).toHaveBeenCalledTimes(2);
    expect(f.deps.authorize).toHaveBeenCalledTimes(2);
    expect(f.deps.upgrade).toHaveBeenCalledWith(
      `${f.target.appOrigin}/session`,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: {
          Upgrade: "websocket",
          Cookie: `coder_subdomain_app_session_token_${"a".repeat(32)}=scoped-cookie`,
          Origin: origin,
        },
      }),
    );
    expect(result.response.headers.has("set-cookie")).toBe(false);
    expect(result.response.headers.has("location")).toBe(false);
    f.server.emit("message", { data: '{"type":"auth","ticket":"signed-host-read-ticket"}' });
    expect(f.upstream.send).toHaveBeenCalledWith(
      '{"type":"auth","ticket":"signed-host-read-ticket"}',
    );
    f.upstream.emit("message", { data: "history" });
    expect(f.server.send).toHaveBeenCalledWith("history");
    result.close();
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
  });
  it("rejects cross-origin, revoked owner and changed registration/build before outbound upgrade", async () => {
    const cross = fixture();
    expect(
      (await cross.open(request(undefined, { Origin: "https://attacker.example" }))).response
        .status,
    ).toBe(403);
    expect(cross.deps.authenticate).not.toHaveBeenCalled();
    const owner = fixture();
    owner.deps.authenticate.mockResolvedValueOnce(owner.principal).mockResolvedValueOnce(null);
    expect((await owner.open()).response.status).toBe(401);
    expect(owner.deps.upgrade).not.toHaveBeenCalled();
    const changed = fixture();
    changed.deps.authorize.mockResolvedValueOnce(changed.target).mockResolvedValueOnce({
      ...changed.target,
      binding: { ...changed.target.binding, buildId: "changed" },
    });
    expect((await changed.open()).response.status).toBe(403);
    expect(changed.deps.upgrade).not.toHaveBeenCalled();
  });
  it("rejects cookie/URL substitution instead of passing caller authority to an arbitrary route", async () => {
    for (const exchange of [
      {
        url: "https://other.example/session",
        cookie: `coder_subdomain_app_session_token_${"a".repeat(32)}=scoped`,
      },
      { url: "https://registered-app.example/session", cookie: "coder_session_token=owner-secret" },
    ]) {
      const f = fixture();
      f.deps.exchange.mockResolvedValue(exchange);
      expect((await f.open()).response.status).toBe(403);
      expect(f.deps.upgrade).not.toHaveBeenCalled();
    }
  });
  it("keeps the same connection beyond60s with periodic fresh authority and hard preview expiry", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(65000);
    expect(f.server.close).not.toHaveBeenCalled();
    expect(f.deps.reauthorize).toHaveBeenCalledTimes(3);
    expect(f.deps.authenticate).toHaveBeenCalledTimes(2);
    const short = fixture();
    await short.open(request(), Date.now() + 4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(short.upstream.close).toHaveBeenCalledWith(1008, "Project authorization expired");
  });
  it("extends only the current registration lease while preserving owner and initial session limits", async () => {
    const f = fixture();
    f.target.expiresAt = Math.floor(now / 1000) + 30;
    f.deps.reauthorize.mockImplementation(async () => ({
      principal: f.principal,
      target: { ...f.target, expiresAt: Math.floor(Date.now() / 1000) + 60 },
    }));
    await f.open();
    await vi.advanceTimersByTimeAsync(65000);
    expect(f.server.close).not.toHaveBeenCalled();
    f.deps.reauthorize.mockResolvedValue({
      principal: f.principal,
      target: { ...f.target, binding: { ...f.target.binding, threadId: "different-thread" } },
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.server.close).toHaveBeenCalledWith(1008, "Project authorization unavailable");
  });
  it("does not accept late authority or release a reservation before an aborted check drains", async () => {
    const f = fixture();
    let resolve: (authority: { principal: typeof f.principal; target: typeof f.target }) => void;
    let signal: AbortSignal | undefined;
    f.deps.reauthorize.mockImplementation((_request, _project, currentSignal) => {
      signal = currentSignal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    await f.open();
    await vi.advanceTimersByTimeAsync(20000);
    f.server.emit("close", { code: 1000 });
    expect(signal?.aborted).toBe(true);
    expect(f.deps.onClosed).not.toHaveBeenCalled();
    expect(f.deps.trackCleanup).toHaveBeenCalledOnce();
    resolve!({ principal: f.principal, target: f.target });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.deps.reauthorize).toHaveBeenCalledOnce();
  });
  it("bounds a stalled reauthorization then drains it without scheduling another check", async () => {
    const f = fixture();
    let reject: (error: Error) => void;
    f.deps.reauthorize.mockImplementation(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    await f.open();
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.server.close).toHaveBeenCalledWith(1008, "Project authorization unavailable");
    expect(f.deps.onClosed).not.toHaveBeenCalled();
    reject!(new Error("Cancelled read drained"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
    expect(f.deps.reauthorize).toHaveBeenCalledOnce();
  });
  it("cancels the fetch handshake timeout after101 so it cannot abort an accepted socket", async () => {
    // AbortSignal.timeout uses the native clock in Node; model Workers' timer
    // semantics so a surviving fetch deadline would race the socket close.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const f = fixture();
    let signal: AbortSignal | undefined;
    f.deps.upgrade.mockImplementation(async (_url, init) => {
      signal = init.signal;
      signal?.addEventListener("abort", () => f.upstream.emit("close", { code: 1000 }));
      return { status: 101, webSocket: f.upstream };
    });
    expect((await f.open(request(), now + 2000)).response.status).toBe(101);
    vi.advanceTimersByTime(2000);
    expect(signal?.aborted).toBe(false);
    expect(f.server.close).toHaveBeenCalledWith(1008, "Project authorization expired");
  });
  it("propagates close/error with sanitized reason and releases the connection once", async () => {
    const f = fixture();
    await f.open();
    f.upstream.emit("close", { code: 1006, reason: "secret upstream URL" });
    expect(f.server.close).toHaveBeenCalledWith(1000, "Project peer closed");
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
    f.server.emit("error");
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
    const error = fixture();
    await error.open();
    error.server.emit("error");
    expect(error.upstream.close).toHaveBeenCalledWith(1011, "Project transport unavailable");
  });
  it("bounds frame bytes, aggregate bytes, message count and supported send buffering", async () => {
    const oversized = fixture();
    await oversized.open();
    oversized.server.emit("message", { data: new Uint8Array(RELAY_MAX_FRAME + 1) });
    expect(oversized.upstream.send).not.toHaveBeenCalled();
    expect(oversized.server.close).toHaveBeenCalledWith(1009, "Project message limit");
    const total = fixture();
    await total.open();
    for (let i = 0; i < 9; i++)
      total.upstream.emit("message", { data: new Uint8Array(RELAY_MAX_FRAME) });
    expect(total.server.send).toHaveBeenCalledTimes(8);
    const count = fixture();
    await count.open();
    for (let i = 0; i < 257; i++) count.server.emit("message", { data: "x" });
    expect(count.upstream.send).toHaveBeenCalledTimes(256);
    const buffered = fixture();
    await buffered.open();
    buffered.upstream.bufferedAmount = 2 * RELAY_MAX_FRAME + 1;
    buffered.server.emit("message", { data: "x" });
    expect(buffered.upstream.send).not.toHaveBeenCalled();
    const windows = fixture();
    await windows.open();
    for (let index = 0; index < 256; index++) windows.server.emit("message", { data: "x" });
    vi.advanceTimersByTime(1000);
    for (let index = 0; index < 256; index++) windows.server.emit("message", { data: "x" });
    expect(windows.upstream.send).toHaveBeenCalledTimes(512);
    expect(windows.server.close).not.toHaveBeenCalled();
  });
  it("cancels non-upgrade bodies and never returns redirect or upstream headers", async () => {
    const f = fixture(),
      cancel = vi.fn().mockResolvedValue(undefined);
    f.deps.upgrade.mockResolvedValue({ status: 302, body: { cancel } as never });
    const response = (await f.open()).response;
    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.headers.has("location")).toBe(false);
  });
});
