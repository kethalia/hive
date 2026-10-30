import {
  buildPtyUrl,
  SAFE_IDENTIFIER_RE,
  UUID_RE,
} from "../../../services/terminal-proxy/src/protocol";
import { GenericTerminalFailure } from "../../../src/lib/terminal/generic-auth.server";
import { TERMINAL_READY, TERMINAL_SUBPROTOCOL } from "../../../src/lib/terminal/protocol";
import type { RelaySocket, UpgradeResponse } from "./project-relay";

export const GENERIC_TERMINAL_LIFETIME_MS = 150000;
export const GENERIC_TERMINAL_REFRESH_MS = 20000;
export const GENERIC_TERMINAL_MAX_MESSAGE = 1048576;
export const GENERIC_TERMINAL_MAX_BYTES = 4194304;
export type GenericTerminalTarget = {
  workspaceId: string;
  agentId: string;
  reconnectId: string;
  sessionName: string;
  width: number;
  height: number;
};
export type GenericTerminalAuthority = {
  sessionId: string;
  userId: string;
  coderUserId: string;
  coderOrigin: string;
  buildId: string;
  token: string;
  expiresAt: number;
};
export interface GenericTerminalDependencies {
  authorize(
    request: Request,
    target: GenericTerminalTarget,
    signal: AbortSignal,
  ): Promise<GenericTerminalAuthority>;
  upgrade(url: string, init: RequestInit): Promise<UpgradeResponse>;
  extend(
    authority: GenericTerminalAuthority,
    target: GenericTerminalTarget,
    signal: AbortSignal,
  ): Promise<void>;
  pair(): { client: RelaySocket; server: RelaySocket };
  response(client: RelaySocket): Response;
  trackCleanup(promise: Promise<void>): void;
  onClosed(): void;
  now?: () => number;
}
export function genericTerminalPath(request: Request) {
  return new URL(request.url).pathname === "/ws";
}
export function parseGenericTerminalTarget(url: URL): GenericTerminalTarget | null {
  if (url.pathname !== "/ws" || url.hash || url.search.length > 2048) return null;
  const fields = ["workspaceId", "agentId", "reconnectId", "sessionName", "width", "height"];
  if (
    [...url.searchParams.keys()].some((key) => !fields.includes(key)) ||
    fields.some((key) => url.searchParams.getAll(key).length !== 1)
  )
    return null;
  const workspaceId = url.searchParams.get("workspaceId") ?? "",
    agentId = url.searchParams.get("agentId") ?? "",
    reconnectId = url.searchParams.get("reconnectId") ?? "",
    sessionName = url.searchParams.get("sessionName") ?? "";
  if (
    ![workspaceId, agentId, reconnectId].every((id) => UUID_RE.test(id)) ||
    !SAFE_IDENTIFIER_RE.test(sessionName) ||
    sessionName.length > 128 ||
    sessionName.startsWith("git-clone-")
  )
    return null;
  const dimensions = ["width", "height"].map((key) => url.searchParams.get(key) ?? "");
  if (dimensions.some((v) => !/^[1-9][0-9]{0,4}$/.test(v) || Number(v) > 65535)) return null;
  return {
    workspaceId,
    agentId,
    reconnectId,
    sessionName,
    width: Number(dimensions[0]),
    height: Number(dimensions[1]),
  };
}
const closeSocket = (socket: RelaySocket | undefined, code: number, reason: string) => {
  try {
    socket?.close(code, reason);
  } catch {}
};
const identity = (a: GenericTerminalAuthority) =>
  JSON.stringify([a.sessionId, a.userId, a.coderUserId, a.coderOrigin]);
const size = (value: unknown) =>
  typeof value === "string"
    ? Buffer.byteLength(value)
    : value instanceof ArrayBuffer || ArrayBuffer.isView(value)
      ? value.byteLength
      : Infinity;
const denied = (status: number) =>
  Response.json(
    { error: "Terminal transport unavailable" },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );

/** Browser protocol is unchanged; output is always binary so shell text cannot
 * impersonate ready/pong. No shell/agent is killed when this attachment closes. */
export async function openGenericTerminalRelay(
  request: Request,
  origin: string,
  previewExpiresAt: number,
  deps: GenericTerminalDependencies,
) {
  const now = deps.now ?? Date.now;
  const url = new URL(request.url),
    target = parseGenericTerminalTarget(url);
  if (
    !target ||
    request.method !== "GET" ||
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
  )
    return denied(400);
  if (
    url.origin !== origin ||
    request.headers.get("Origin") !== origin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return denied(403);
  let upstream: RelaySocket | undefined;
  let cleanup: (() => void) | undefined;
  const handshake = new AbortController();
  const handshakeTimer = setTimeout(() => handshake.abort(), 10000);
  try {
    const authority = await deps.authorize(request, target, handshake.signal);
    handshake.signal.throwIfAborted();
    let deadline = Math.min(
      now() + GENERIC_TERMINAL_LIFETIME_MS,
      authority.expiresAt,
      previewExpiresAt,
    );
    if (deadline <= now() || request.signal.aborted) return denied(401);
    const pty = buildPtyUrl(authority.coderOrigin, target.agentId, target)
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:");
    const response = await deps.upgrade(pty, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal: handshake.signal,
      headers: { Upgrade: "websocket", "Coder-Session-Token": authority.token },
    });
    upstream = response.webSocket;
    if (response.status !== 101 || !upstream) {
      closeSocket(upstream, 1011, "Terminal upgrade unavailable");
      void response.body?.cancel().catch(() => {});
      return denied(502);
    }
    if (handshake.signal.aborted || request.signal.aborted || deadline <= now()) {
      closeSocket(upstream, 1008, "Terminal authorization expired");
      return denied(401);
    }
    const { client, server } = deps.pair();
    let stopped = false,
      pending: Promise<void> | undefined,
      pendingAbort: AbortController | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined,
      lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    let authorized = authority,
      nextExtendAt = now();
    let windowStart = now(),
      messages = 0;
    const totals = { input: 0, output: 0 };
    const listeners: Array<{ socket: RelaySocket; event: string; listener: unknown }> = [];
    const finish = (code: number, reason: string) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(refreshTimer);
      clearTimeout(lifetimeTimer);
      pendingAbort?.abort();
      for (const item of listeners) item.socket.removeEventListener(item.event, item.listener);
      request.signal.removeEventListener("abort", abort);
      closeSocket(server, code, reason);
      closeSocket(upstream, code, reason);
      if (pending) deps.trackCleanup(pending.then(deps.onClosed, deps.onClosed));
      else deps.onClosed();
    };
    const abort = () => finish(1001, "Terminal connection closed");
    cleanup = () => finish(1011, "Terminal transport unavailable");
    const schedule = () => {
      if (!stopped) refreshTimer = setTimeout(refresh, GENERIC_TERMINAL_REFRESH_MS);
    };
    const refresh = () => {
      if (stopped || pending) return;
      const controller = new AbortController();
      pendingAbort = controller;
      const timer = setTimeout(() => controller.abort(), 5000);
      const work = (async () => {
        const fresh = await deps.authorize(request, target, controller.signal);
        if (stopped) return;
        controller.signal.throwIfAborted();
        if (identity(fresh) !== identity(authority) || fresh.expiresAt <= now())
          throw new GenericTerminalFailure(4401);
        if (fresh.buildId !== authority.buildId) throw new GenericTerminalFailure(4404);
        authorized = fresh;
        deadline = Math.min(deadline, fresh.expiresAt);
        clearTimeout(lifetimeTimer);
        lifetimeTimer = setTimeout(
          () => finish(1013, "Terminal attachment renewal"),
          deadline - now(),
        );
        if (now() >= nextExtendAt) {
          // An unavailable extension is not a renewed authorization or an auth
          // failure. The next refresh still independently verifies the owner.
          await deps.extend(authorized, target, controller.signal).catch(() => {});
          nextExtendAt = now() + 55000;
        }
      })()
        .catch((error) => {
          if (error instanceof GenericTerminalFailure)
            finish(
              error.closeCode,
              error.closeCode === 4404 ? "Workspace offline" : "Terminal authorization expired",
            );
          else finish(1013, "Terminal authorization unavailable");
        })
        .finally(() => {
          clearTimeout(timer);
          if (pending === work) pending = undefined;
          if (pendingAbort === controller) pendingAbort = undefined;
          schedule();
        });
      pending = work;
    };
    const listen = (
      socket: RelaySocket,
      event: "message" | "close" | "error",
      callback: (value: { data?: unknown }) => void,
    ) => {
      if (event === "message") {
        socket.addEventListener("message", callback);
        listeners.push({ socket, event, listener: callback });
      } else {
        const listener = () => callback({});
        if (event === "close") socket.addEventListener("close", listener);
        else socket.addEventListener("error", listener);
        listeners.push({ socket, event, listener });
      }
    };
    const admit = (data: unknown, direction: "input" | "output") => {
      const bytes = size(data);
      totals[direction] += bytes;
      if (now() - windowStart >= 1000) {
        windowStart = now();
        messages = 0;
      }
      messages++;
      if (
        bytes > GENERIC_TERMINAL_MAX_MESSAGE ||
        totals[direction] > GENERIC_TERMINAL_MAX_BYTES ||
        messages > 512 ||
        (typeof server.bufferedAmount === "number" &&
          server.bufferedAmount > GENERIC_TERMINAL_MAX_MESSAGE)
      ) {
        finish(1013, "Terminal attachment budget reached");
        return false;
      }
      return true;
    };
    listen(server, "message", (event) => {
      if (stopped || !admit(event.data, "input")) return;
      if (typeof event.data !== "string") {
        finish(1008, "Terminal input rejected");
        return;
      }
      try {
        const value = JSON.parse(event.data);
        if (
          value?.type === "hive:ping" &&
          Object.keys(value).length === 2 &&
          Number.isSafeInteger(value.id)
        ) {
          if (upstream?.readyState === 1)
            server.send(JSON.stringify({ type: "hive:pong", id: value.id }));
          return;
        }
        if (
          !value ||
          Array.isArray(value) ||
          Object.keys(value).length === 0 ||
          Object.keys(value).some((key) => !["data", "height", "width"].includes(key)) ||
          (value.data !== undefined && typeof value.data !== "string") ||
          [value.height, value.width].some(
            (v) => v !== undefined && (!Number.isInteger(v) || v < 1 || v > 65535),
          )
        )
          throw new Error("input");
        upstream?.send(new TextEncoder().encode(event.data));
      } catch {
        finish(1008, "Terminal input rejected");
      }
    });
    listen(upstream, "message", (event) => {
      if (stopped || !admit(event.data, "output")) return;
      try {
        server.send(
          typeof event.data === "string"
            ? new TextEncoder().encode(event.data)
            : (event.data as ArrayBuffer | ArrayBufferView),
        );
      } catch {
        finish(1011, "Terminal output unavailable");
      }
    });
    for (const socket of [server, upstream]) {
      listen(socket, "close", () => finish(1013, "Terminal peer closed"));
      listen(socket, "error", () => finish(1011, "Terminal transport unavailable"));
    }
    server.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
    upstream.accept({ allowHalfOpen: true });
    server.accept({ allowHalfOpen: true });
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return deps.response(client);
    }
    lifetimeTimer = setTimeout(() => finish(1013, "Terminal attachment renewal"), deadline - now());
    server.send(TERMINAL_READY);
    refresh();
    return deps.response(client);
  } catch {
    cleanup?.();
    closeSocket(upstream, 1011, "Terminal transport unavailable");
    return denied(401);
  } finally {
    clearTimeout(handshakeTimer);
  }
}

export { TERMINAL_SUBPROTOCOL };
