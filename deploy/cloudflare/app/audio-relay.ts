import {
  buildPtyUrl,
  SAFE_IDENTIFIER_RE,
  UUID_RE,
} from "../../../services/terminal-proxy/src/protocol";
import {
  GENERIC_TERMINAL_AUTHORIZATION_MS,
  GENERIC_TERMINAL_HANDSHAKE_MS,
  GenericTerminalFailure,
} from "../../../src/lib/terminal/generic-auth.server";
import type { RelaySocket } from "../../../src/lib/terminal/relay-types";
import {
  GENERIC_TERMINAL_REFRESH_MS,
  type GenericTerminalAuthority,
  type GenericTerminalDependencies,
  type GenericTerminalTarget,
} from "./generic-terminal-relay";
export const AUDIO_PROTOCOL = "hive-audio-v1";
const MAX_QUEUE = 64 * 1024;
export function audioPath(request: Request) {
  return new URL(request.url).pathname === "/ws/audio";
}
export function parseAudioTarget(url: URL): GenericTerminalTarget | null {
  const fields = ["workspaceId", "agentId", "sessionName"];
  if (
    url.pathname !== "/ws/audio" ||
    url.search.length > 1024 ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !fields.includes(key)) ||
    fields.some((key) => url.searchParams.getAll(key).length !== 1)
  )
    return null;
  const workspaceId = url.searchParams.get("workspaceId") ?? "",
    agentId = url.searchParams.get("agentId") ?? "",
    sessionName = url.searchParams.get("sessionName") ?? "";
  if (
    !UUID_RE.test(workspaceId) ||
    !UUID_RE.test(agentId) ||
    !SAFE_IDENTIFIER_RE.test(sessionName) ||
    sessionName.length > 200
  )
    return null;
  return {
    workspaceId,
    agentId,
    sessionName,
    reconnectId: crypto.randomUUID(),
    width: 80,
    height: 24,
  };
}
export function parseBrowserAudio(data: string): string | null {
  if (data.length > 2048) return null;
  try {
    const value = JSON.parse(data);
    if (
      value?.type === "playback" &&
      typeof value.enabled === "boolean" &&
      Number.isSafeInteger(value.generation) &&
      value.generation > 0
    )
      return JSON.stringify({
        type: "playback",
        enabled: value.enabled,
        generation: value.generation,
      });
    if (value?.type === "ping" || value?.type === "release" || value?.type === "claim")
      return JSON.stringify({ type: value.type });
    if (
      value?.type === "microphone" &&
      typeof value.pcm === "string" &&
      value.pcm.length > 0 &&
      value.pcm.length <= 1280 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.pcm)
    ) {
      const pcm = Buffer.from(value.pcm, "base64");
      if (pcm.length > 0 && pcm.length <= 960 && pcm.length % 2 === 0)
        return JSON.stringify({ type: "microphone", pcm: value.pcm });
    }
  } catch {
    /* Malformed media is rejected without logging its contents. */
  }
  return null;
}

export function parseWorkspaceAudio(line: string): string | null {
  if (line.length > 2048) return null;
  try {
    const value = JSON.parse(line);
    if (value?.type === "ready")
      return JSON.stringify({
        type: "ready",
        ...(value.claimRequired === true ? { claimRequired: true } : {}),
      });
    if (value?.type === "pong" || value?.type === "claimed")
      return JSON.stringify({ type: value.type });
    if (value?.type === "active" && typeof value.active === "boolean")
      return JSON.stringify({ type: "active", active: value.active });
    if (value?.type === "speaker") {
      const microphone = parseBrowserAudio(JSON.stringify({ type: "microphone", pcm: value.pcm }));
      if (microphone) return microphone.replace('"microphone"', '"speaker"');
    }
    if (value?.type === "error" && typeof value.message === "string")
      return JSON.stringify({
        type: "error",
        message: value.message.slice(0, 200),
        ...(value.code === "session_busy" ? { code: "session_busy" } : {}),
      });
  } catch {
    /* PTY diagnostics cannot impersonate audio frames. */
  }
  return null;
}

function connectNativeAudio(
  browser: RelaySocket,
  upstream: RelaySocket,
  finish: (code: number, reason: string) => void,
) {
  let buffer = "";
  let closed = false;
  let lastPong = Date.now();
  let lastWorkspacePong = Date.now();
  type Playback = { enabled: boolean; generation: number };
  let playback: Playback | null = null;
  let bufferPlayback: Playback | null = null;
  const browserControls: string[] = [];
  const workspaceControls: string[] = [];
  let controlRetry: ReturnType<typeof setTimeout> | undefined;
  const close = (code = 1000, reason = "audio ended") => finish(code, reason);
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(startup);
    clearTimeout(controlRetry);
    browserControls.length = workspaceControls.length = 0;
    browser.removeEventListener("message", browserMessage);
    upstream.removeEventListener("message", upstreamMessage);
    if (upstream.readyState === 1) {
      try {
        upstream.send(new TextEncoder().encode(JSON.stringify({ data: '{"type":"release"}\n' })));
      } catch {}
    }
  };
  const send = (socket: RelaySocket, message: string, binary = false) => {
    try {
      socket.send(binary ? new TextEncoder().encode(message) : message);
    } catch {
      close(1011, "Audio transport unavailable");
    }
  };
  const flushControls = () => {
    clearTimeout(controlRetry);
    controlRetry = undefined;
    if (closed) return;
    for (const [target, queue] of [
      [browser, browserControls],
      [upstream, workspaceControls],
    ] as const) {
      while (
        queue.length &&
        target.readyState === 1 &&
        (target.bufferedAmount ?? 0) <= MAX_QUEUE + 2048
      ) {
        const message = queue.shift() as string;
        send(target, message, target === upstream);
      }
    }
    if (browserControls.length || workspaceControls.length)
      controlRetry = setTimeout(flushControls, 50);
  };
  const queueControl = (queue: string[], message: string, periodic = false) => {
    if (closed || (periodic && queue.includes(message))) return;
    // Preserve every state transition in order, including stop followed by start.
    if (queue.length >= 32) {
      close(1013, "audio controls stalled");
      return;
    }
    queue.push(message);
    flushControls();
  };
  const startup = setTimeout(() => close(1013, "workspace audio timed out"), 10_000);
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPong > 20_000 || Date.now() - lastWorkspacePong > 20_000) {
      close(1013, "audio heartbeat timed out");
      return;
    }
    if (upstream.readyState === 1)
      queueControl(workspaceControls, JSON.stringify({ data: '{"type":"ping"}\n' }), true);
  }, 5000);
  const browserMessage = (event: { data: unknown }) => {
    const data = event.data;
    if (closed) return;
    if (typeof data !== "string") {
      close(1008, "invalid audio frame");
      return;
    }
    const message = parseBrowserAudio(data);
    if (!message) {
      close(1008, "invalid audio frame");
      return;
    }
    lastPong = Date.now();
    if (message === '{"type":"release"}') {
      close();
      return;
    }
    if (message.startsWith('{"type":"playback"')) {
      const next = JSON.parse(message);
      // Focus controls belong to this browser transport, never the native relay.
      if (!playback || next.generation > playback.generation) playback = next;
      return;
    }
    // A browser heartbeat can arrive while Coder is still opening the PTY.
    if (upstream.readyState !== 1) {
      if (message !== '{"type":"ping"}') close(1008, "audio is not ready");
      return;
    }
    if (!message.startsWith('{"type":"microphone"')) {
      queueControl(
        workspaceControls,
        JSON.stringify({ data: `${message}\n` }),
        message === '{"type":"ping"}',
      );
      return;
    }
    flushControls();
    if (workspaceControls.length || (upstream.bufferedAmount ?? 0) > MAX_QUEUE) return;
    // Coder's PTY accepts binary WebSocket frames, including JSON input envelopes.
    send(upstream, JSON.stringify({ data: `${message}\n` }), true);
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const upstreamMessage = (event: { data: unknown }) => {
    const data = event.data;
    if (closed) return;
    flushControls();
    if (!buffer.length) bufferPlayback = playback;
    try {
      const text =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? decoder.decode(new Uint8Array(data), { stream: true })
            : ArrayBuffer.isView(data)
              ? decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
                  stream: true,
                })
              : null;
      if (text === null || text.length > MAX_QUEUE) throw new Error("frame");
      buffer += text;
    } catch {
      close(1008, "invalid workspace audio frame");
      return;
    }
    if (buffer.length > MAX_QUEUE) {
      close(1008, "invalid workspace audio frame");
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const message = parseWorkspaceAudio(buffer.slice(0, newline).trim());
      const framePlayback = bufferPlayback;
      buffer = buffer.slice(newline + 1);
      bufferPlayback = playback;
      if (message && browser.readyState === 1) {
        const control = JSON.parse(message);
        if (control.type === "ready" || control.type === "pong") lastWorkspacePong = Date.now();
        if (control.type === "ready") clearTimeout(startup);
        if (control.type !== "speaker")
          queueControl(
            browserControls,
            control.type === "ready"
              ? JSON.stringify({ ...control, playbackGeneration: true })
              : message,
            control.type === "pong",
          );
        // Late PCM is disposable; state-changing controls are delivered first.
        else if (
          !browserControls.length &&
          (browser.bufferedAmount ?? 0) <= MAX_QUEUE &&
          // A fragmented line belongs to the focus generation of its first bytes.
          framePlayback === playback &&
          playback?.enabled !== false
        )
          send(
            browser,
            playback ? JSON.stringify({ ...control, generation: playback.generation }) : message,
          );
      }
      newline = buffer.indexOf("\n");
    }
  };
  browser.addEventListener("message", browserMessage);
  upstream.addEventListener("message", upstreamMessage);
  return dispose;
}
const closeSocket = (socket: RelaySocket | undefined, code: number, reason: string) => {
  try {
    socket?.accept({ allowHalfOpen: true });
  } catch {}
  try {
    socket?.close(code, reason);
  } catch {}
};
const identity = (a: GenericTerminalAuthority) =>
  JSON.stringify([a.sessionId, a.userId, a.coderUserId, a.coderOrigin]);
const denied = (status: number) =>
  Response.json(
    { error: "Audio transport unavailable" },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );

/** Native PCM and consent controls use the fixed workspace audio command.
 * The captured credential expiry bounds the attachment through later refreshes. */
export async function openAudioRelay(
  request: Request,
  origin: string,
  attachmentExpiresAt: number,
  deps: GenericTerminalDependencies,
) {
  const now = deps.now ?? Date.now;
  const url = new URL(request.url),
    target = parseAudioTarget(url);
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
  const signal = AbortSignal.any([request.signal, handshake.signal]);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const handshakeTimer = setTimeout(() => handshake.abort(), GENERIC_TERMINAL_HANDSHAKE_MS);
  try {
    const authority = await deps.authorize(request, target, signal);
    signal.throwIfAborted();
    let deadline = Math.min(authority.expiresAt, attachmentExpiresAt);
    if (deadline <= now() || request.signal.aborted) return denied(401);
    expiryTimer = setTimeout(() => handshake.abort(), Math.min(deadline - now(), 2147483647));
    const pty = buildPtyUrl(authority.coderOrigin, target.agentId, { ...target, audioRelay: true })
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:");
    const response = await deps.upgrade(pty, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        Upgrade: "websocket",
        "Coder-Session-Token": authority.token,
      },
    });
    upstream = response.webSocket;
    if (response.status !== 101 || !upstream) {
      closeSocket(upstream, 1011, "Audio upgrade unavailable");
      void response.body?.cancel().catch(() => {});
      return denied([401, 403].includes(response.status) ? response.status : 502);
    }
    if (signal.aborted || request.signal.aborted || deadline <= now()) {
      closeSocket(upstream, 1008, "Audio authorization expired");
      return denied(401);
    }
    const { client, server } = deps.pair();
    let stopped = false,
      pending: Promise<void> | undefined,
      pendingAbort: AbortController | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined,
      lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    let stopAudio: (() => void) | undefined;
    const listeners: Array<{ socket: RelaySocket; event: string; listener: unknown }> = [];
    const finish = (code: number, reason: string) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(refreshTimer);
      clearTimeout(lifetimeTimer);
      pendingAbort?.abort();
      stopAudio?.();
      for (const item of listeners) item.socket.removeEventListener(item.event, item.listener);
      request.signal.removeEventListener("abort", abort);
      closeSocket(server, code, reason);
      closeSocket(upstream, code, reason);
      if (pending) deps.trackCleanup(pending.then(deps.onClosed, deps.onClosed));
      else deps.onClosed();
    };
    const abort = () => finish(1001, "Audio connection closed");
    cleanup = () => finish(1011, "Audio transport unavailable");
    const armDeadline = () => {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = setTimeout(
        () => {
          if (deadline <= now()) finish(4401, "Audio authorization expired");
          else armDeadline();
        },
        Math.min(deadline - now(), 2147483647),
      );
    };
    const schedule = () => {
      if (!stopped) refreshTimer = setTimeout(refresh, GENERIC_TERMINAL_REFRESH_MS);
    };
    const refresh = () => {
      if (stopped || pending) return;
      const controller = new AbortController();
      pendingAbort = controller;
      const timer = setTimeout(() => controller.abort(), GENERIC_TERMINAL_AUTHORIZATION_MS);
      const work = (async () => {
        const fresh = await deps.authorize(request, target, controller.signal);
        if (stopped) return;
        controller.signal.throwIfAborted();
        if (identity(fresh) !== identity(authority) || fresh.expiresAt <= now())
          throw new GenericTerminalFailure(4401);
        if (fresh.buildId !== authority.buildId) throw new GenericTerminalFailure(4404);
        deadline = Math.min(deadline, fresh.expiresAt);
        armDeadline();
      })()
        .catch((error) => {
          if (error instanceof GenericTerminalFailure)
            finish(
              error.closeCode,
              error.closeCode === 4404 ? "Workspace offline" : "Audio authorization expired",
            );
          else finish(1013, "Audio authorization unavailable");
        })
        .finally(() => {
          clearTimeout(timer);
          if (pending === work) pending = undefined;
          if (pendingAbort === controller) pendingAbort = undefined;
          schedule();
        });
      pending = work;
    };
    for (const socket of [server, upstream]) {
      const onClose = (event: { code?: number }) => {
        const normalExit = socket === upstream && event.code === 1000;
        finish(normalExit ? 1000 : 1013, normalExit ? "Audio session closed" : "Audio peer closed");
      };
      const onError = () => finish(1011, "Audio transport unavailable");
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      listeners.push(
        { socket, event: "close", listener: onClose },
        { socket, event: "error", listener: onError },
      );
    }
    server.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
    stopAudio = connectNativeAudio(server, upstream, finish);
    upstream.accept({ allowHalfOpen: true });
    server.accept({ allowHalfOpen: true });
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return deps.response(client);
    }
    armDeadline();
    refresh();
    return deps.response(client);
  } catch {
    cleanup?.();
    closeSocket(upstream, 1011, "Audio transport unavailable");
    return denied(401);
  } finally {
    clearTimeout(handshakeTimer);
    clearTimeout(expiryTimer);
  }
}
