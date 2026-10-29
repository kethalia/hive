export type RelayKind = "session" | "terminal";
export type RelayPrincipal = {
  hiveUserId: string;
  coderUserId: string;
  coderOrigin: string;
  expiresAt: number;
};
export type RelayTarget = {
  coderOrigin: string;
  appOrigin: string;
  registrationId: string;
  expiresAt: number;
  binding: {
    ownerId: string;
    workspaceId: string;
    buildId: string;
    serverInstanceId: string;
    threadId: string;
  };
};
type Message = { data: unknown };
type Closed = { code?: number };
export interface RelaySocket {
  readyState: number;
  bufferedAmount?: number;
  binaryType?: "arraybuffer" | "blob";
  accept(options?: { allowHalfOpen: boolean }): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "message", listener: (event: Message) => void): void;
  addEventListener(event: "close", listener: (event: Closed) => void): void;
  addEventListener(event: "error", listener: () => void): void;
  removeEventListener(event: string, listener: unknown): void;
}
export type UpgradeResponse = {
  status: number;
  webSocket?: RelaySocket;
  body?: ReadableStream<Uint8Array> | null;
};
export type RelayDependencies = {
  authenticate(request: Request): Promise<RelayPrincipal | null>;
  authorize(principal: RelayPrincipal, projectId: string): Promise<RelayTarget>;
  exchange(
    principal: RelayPrincipal,
    target: RelayTarget,
    kind: RelayKind,
  ): Promise<{ cookie: string; url: string }>;
  upgrade(url: string, init: RequestInit): Promise<UpgradeResponse>;
  pair(): { client: RelaySocket; server: RelaySocket };
  response(client: RelaySocket): Response;
  now?: () => number;
  onClosed?: () => void;
};
export const RELAY_MAX_MS = 60000;
export const RELAY_MAX_FRAME = 1024 * 1024;
export const RELAY_MAX_BYTES = 8 * RELAY_MAX_FRAME;
export const RELAY_MAX_MESSAGES = 256;
const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" };
const failure = (status: number) => ({
  response: Response.json(
    { error: "Project transport unavailable" },
    { status, headers: privateHeaders },
  ),
  close: () => {},
});
const safeClose = (socket: RelaySocket | undefined, code: number, reason: string) => {
  try {
    socket?.close(code, reason);
  } catch {}
};

export function projectRelayPath(request: Request): { projectId: string; kind: RelayKind } | null {
  const match =
    /^\/api\/projects\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/(session|terminal)$/.exec(
      new URL(request.url).pathname,
    );
  return match ? { projectId: match[1], kind: match[2] as RelayKind } : null;
}
function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    throw new Error("Invalid registered origin");
  return url.origin;
}
function identity(target: RelayTarget) {
  return JSON.stringify([
    target.coderOrigin,
    target.appOrigin,
    target.registrationId,
    target.binding.ownerId,
    target.binding.workspaceId,
    target.binding.buildId,
    target.binding.serverInstanceId,
    target.binding.threadId,
  ]);
}
function frameSize(data: unknown): number {
  if (typeof data === "string")
    return data.length > RELAY_MAX_FRAME ? Infinity : Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return Infinity;
}

/** Fixed endpoint proxy, with independent Hive and registered-host authorization. */
export async function openProjectRelay(
  request: Request,
  configuredOrigin: string,
  previewExpiresAt: number,
  deps: RelayDependencies,
) {
  const path = projectRelayPath(request),
    url = new URL(request.url),
    now = deps.now ?? Date.now;
  if (
    !path ||
    request.method !== "GET" ||
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
    url.search ||
    url.hash ||
    request.headers.has("Sec-WebSocket-Protocol")
  )
    return failure(400);
  if (
    url.origin !== configuredOrigin ||
    request.headers.get("Origin") !== configuredOrigin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return failure(403);
  let upstream: RelaySocket | undefined;
  let close: () => void = () => safeClose(upstream, 1011, "Project transport unavailable");
  try {
    if (request.signal.aborted) return failure(400);
    const principal = await deps.authenticate(request);
    if (!principal || principal.expiresAt <= now()) return failure(401);
    const target = await deps.authorize(principal, path.projectId);
    origin(target.appOrigin);
    origin(target.coderOrigin);
    if (
      target.binding.ownerId !== principal.coderUserId ||
      target.coderOrigin !== principal.coderOrigin
    )
      return failure(403);
    const exchanged = await deps.exchange(principal, target, path.kind);
    if (
      exchanged.url !== `${target.appOrigin}/${path.kind}` ||
      !/^coder_subdomain_app_session_token_[a-f0-9]{32}=[A-Za-z0-9_-]{1,512}$/.test(
        exchanged.cookie,
      )
    )
      return failure(403);
    // Recheck after the external exchange: it must not bridge a changed host,
    // owner, session, registration generation or native thread incarnation.
    const freshPrincipal = await deps.authenticate(request);
    if (
      !freshPrincipal ||
      freshPrincipal.hiveUserId !== principal.hiveUserId ||
      freshPrincipal.coderUserId !== principal.coderUserId ||
      freshPrincipal.coderOrigin !== principal.coderOrigin
    )
      return failure(401);
    const freshTarget = await deps.authorize(freshPrincipal, path.projectId);
    if (identity(freshTarget) !== identity(target)) return failure(403);
    const deadline = Math.min(
      now() + RELAY_MAX_MS,
      previewExpiresAt,
      principal.expiresAt,
      freshPrincipal.expiresAt,
      freshTarget.expiresAt * 1000,
    );
    if (deadline - now() < 1000 || request.signal.aborted) return failure(403);
    const response = await deps.upgrade(exchanged.url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(Math.min(10000, deadline - now())),
      headers: { Upgrade: "websocket", Cookie: exchanged.cookie, Origin: configuredOrigin },
    });
    if (response.status !== 101 || !response.webSocket) {
      await response.body?.cancel().catch(() => {});
      return failure(502);
    }
    upstream = response.webSocket;
    if (deadline <= now() || request.signal.aborted) {
      safeClose(upstream, 1008, "Project authorization expired");
      return failure(403);
    }
    const { client, server } = deps.pair();
    let stopped = false,
      bytes = 0,
      messages = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners: Array<{ socket: RelaySocket; event: string; listener: unknown }> = [];
    const finish = (code: number, reason: string) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      for (const { socket, event, listener } of listeners)
        socket.removeEventListener(event, listener);
      request.signal.removeEventListener("abort", abort);
      safeClose(server, code, reason);
      safeClose(upstream, code, reason);
      deps.onClosed?.();
    };
    const abort = () => finish(1008, "Project connection closed");
    close = () => finish(1011, "Project transport unavailable");
    for (const [from, to] of [
      [server, upstream],
      [upstream, server],
    ] as const) {
      const message = (event: Message) => {
        if (stopped) return;
        const size = frameSize(event.data);
        bytes += size;
        messages++;
        if (
          size > RELAY_MAX_FRAME ||
          bytes > RELAY_MAX_BYTES ||
          messages > RELAY_MAX_MESSAGES ||
          (typeof to.bufferedAmount === "number" && to.bufferedAmount > 2 * RELAY_MAX_FRAME)
        ) {
          finish(1009, "Project message limit");
          return;
        }
        try {
          to.send(event.data as string | ArrayBuffer | ArrayBufferView);
        } catch {
          finish(1011, "Project transport unavailable");
        }
      };
      const closed = (event: Closed) => {
        const code =
          typeof event.code === "number" &&
          event.code >= 1000 &&
          event.code <= 4999 &&
          ![1004, 1005, 1006, 1015].includes(event.code)
            ? event.code
            : 1000;
        finish(code, "Project peer closed");
      };
      const error = () => finish(1011, "Project transport unavailable");
      from.addEventListener("message", message);
      from.addEventListener("close", closed);
      from.addEventListener("error", error);
      listeners.push(
        { socket: from, event: "message", listener: message },
        { socket: from, event: "close", listener: closed },
        { socket: from, event: "error", listener: error },
      );
    }
    request.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => finish(1008, "Project authorization expired"),
      Math.max(1, deadline - now()),
    );
    // Workers defaults binary frames to Blob with current compatibility dates.
    // Explicit ArrayBuffer delivery keeps synchronous size/backpressure bounds.
    server.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
    server.accept({ allowHalfOpen: true });
    upstream.accept({ allowHalfOpen: true });
    return { response: deps.response(client), close };
  } catch {
    close();
    return failure(503);
  }
}
