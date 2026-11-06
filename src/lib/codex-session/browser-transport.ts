import { z } from "zod";
import type { AuthorizedSessionTransport, SessionBinding } from "./adapter";

const bindingSchema = z
  .object({
    ownerId: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(200),
    buildId: z.string().min(1).max(200),
    serverInstanceId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
  })
  .strict();
const grantSchema = z
  .object({
    url: z.string().max(2048),
    binding: bindingSchema,
    protocolVersion: z.literal("0.165.0"),
    expiresAt: z.number().int(),
    ticket: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  })
  .strict();
export type SessionGrant = z.infer<typeof grantSchema>;
type CloseReason = "revoked" | "disconnected";
/** Preserves authorization denial even when the socket closes before the adapter
 * exists, so a reconnect cannot retain a formerly authorized transcript. */
export class SessionTransportError extends Error {
  constructor(
    readonly reason: CloseReason,
    message: string,
  ) {
    super(message);
    this.name = "SessionTransportError";
  }
}
export interface SessionSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
type Options = {
  // Must reauthorize through the server; do not return a cached signed ticket.
  freshGrant: () => Promise<SessionGrant>;
  createSocket?: (url: string) => SessionSocket;
};
const MAX_FRAME_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;
const ALLOWED_EVENTS = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "thread/reverted",
  "thread/closed",
  "thread/archived",
  "thread/deleted",
  "hive/session/actionRequired",
]);

function validateGrant(raw: unknown): SessionGrant {
  const grant = grantSchema.parse(raw);
  const url = new URL(grant.url);
  if (
    url.protocol !== "https:" ||
    !(
      url.pathname === "/session" ||
      (/^\/api\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/session$/.test(
        url.pathname,
      ) &&
        typeof globalThis.location !== "undefined" &&
        url.origin === globalThis.location.origin)
    ) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.hostname.includes("*") ||
    url.href !== grant.url
  ) {
    throw new Error("Invalid server-provided session URL.");
  }
  const remaining = grant.expiresAt * 1000 - Date.now();
  if (remaining <= 0 || remaining > 60_000) throw new Error("Session grant has an invalid expiry.");
  return grant;
}
function sameBinding(a: SessionBinding, b: SessionBinding) {
  return (Object.keys(a) as (keyof SessionBinding)[]).every((key) => a[key] === b[key]);
}

/** No endpoint discovery or ticket issuance occurs here. The grant must come from
 * an authenticated server route backed by a trusted workspace/thread registry.
 */
export function openCodexSessionTransport(
  initial: SessionGrant,
  options: Options,
): Promise<AuthorizedSessionTransport> {
  let grant: SessionGrant;
  try {
    grant = validateGrant(initial);
  } catch {
    throw new SessionTransportError("revoked", "Session grant is invalid.");
  }
  const endpoint = new URL(grant.url);
  endpoint.protocol = "wss:";
  const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(endpoint.href);
  return new Promise((resolve, reject) => {
    let current = grant;
    let authenticated = false;
    let closed = false;
    let closeReason: CloseReason = "disconnected";
    let sequence = 0;
    let pendingRenewal: SessionGrant | undefined;
    const notifications = new Set<(event: unknown) => void>();
    const closes = new Set<(reason?: CloseReason) => void>();
    const backlog: unknown[] = [];
    const requests = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalDeadline: ReturnType<typeof setTimeout> | undefined;
    const handshakeTimer = setTimeout(
      () => finish("disconnected", "Session authentication timed out."),
      TIMEOUT_MS,
    );

    function finish(reason: CloseReason, message: string) {
      if (closed) return;
      closed = true;
      closeReason = reason;
      clearTimeout(handshakeTimer);
      clearTimeout(renewalTimer);
      clearTimeout(expiryTimer);
      clearTimeout(renewalDeadline);
      for (const [type, listener] of listeners) socket.removeEventListener(type, listener);
      for (const request of requests.values()) {
        clearTimeout(request.timer);
        request.reject(new SessionTransportError(reason, message));
      }
      requests.clear();
      backlog.length = 0;
      pendingRenewal = undefined;
      socket.close(
        reason === "revoked" ? 1008 : 1000,
        reason === "revoked" ? "Session authorization unavailable" : "Session disconnected",
      );
      if (!authenticated) reject(new SessionTransportError(reason, message));
      for (const listener of closes) listener(reason);
    }
    function send(message: unknown) {
      const encoded = JSON.stringify(message);
      if (closed || socket.readyState !== 1) throw new Error("Session transport is disconnected.");
      if (Date.now() >= current.expiresAt * 1000) {
        finish("revoked", "Session authorization expired.");
        throw new Error("Session authorization expired.");
      }
      if (
        new TextEncoder().encode(encoded).length > MAX_FRAME_BYTES ||
        socket.bufferedAmount > 2 * MAX_FRAME_BYTES
      ) {
        finish("revoked", "Session transport limit exceeded.");
        throw new Error("Session transport limit exceeded.");
      }
      socket.send(encoded);
    }
    function scheduleAuthorization() {
      clearTimeout(expiryTimer);
      clearTimeout(renewalTimer);
      const remaining = current.expiresAt * 1000 - Date.now();
      expiryTimer = setTimeout(
        () => finish("revoked", "Session authorization expired."),
        Math.max(0, remaining),
      );
      const delay =
        remaining > 15_000 ? Math.min(40_000, remaining - 10_000) : Math.max(1000, remaining / 2);
      renewalTimer = setTimeout(() => {
        void renew();
      }, delay);
    }
    async function renew() {
      if (closed) return;
      // One bounded fresh authorization attempt; a failure never becomes a retry loop.
      renewalDeadline = setTimeout(
        () => finish("revoked", "Session renewal timed out."),
        TIMEOUT_MS,
      );
      try {
        const next = validateGrant(await options.freshGrant());
        if (closed) return;
        if (
          next.url !== current.url ||
          !sameBinding(next.binding, current.binding) ||
          next.ticket === current.ticket ||
          next.expiresAt <= current.expiresAt
        )
          throw new Error("Renewal binding changed.");
        pendingRenewal = next;
        send({ type: "renew", ticket: next.ticket });
      } catch {
        finish("revoked", "Session authorization could not be renewed.");
      }
    }

    const transport: AuthorizedSessionTransport = {
      binding: Object.freeze({ ...grant.binding }),
      request(method, params) {
        if (closed || !authenticated)
          return Promise.reject(new Error("Session transport is disconnected."));
        if (!["initialize", "thread/resume", "thread/turns/list"].includes(method))
          return Promise.reject(new Error("Session method is not allowed."));
        if (requests.size >= 8 || sequence >= 256) {
          finish("revoked", "Session request limit exceeded.");
          return Promise.reject(new Error("Session request limit exceeded."));
        }
        return new Promise((resolveRequest, rejectRequest) => {
          const id = ++sequence;
          const timer = setTimeout(
            () => finish("disconnected", "Session request timed out."),
            TIMEOUT_MS,
          );
          requests.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
          try {
            send({ id, method, params });
          } catch {
            finish("disconnected", "Session request could not be sent.");
          }
        });
      },
      notify(method) {
        if (method !== "initialized") throw new Error("Session notification is not allowed.");
        send({ method });
      },
      onNotification(listener) {
        notifications.add(listener);
        for (const event of backlog.splice(0)) listener(event);
        return () => {
          notifications.delete(listener);
        };
      },
      onClose(listener) {
        closes.add(listener);
        if (closed)
          queueMicrotask(() => {
            if (closes.has(listener)) listener(closeReason);
          });
        return () => {
          closes.delete(listener);
        };
      },
      close() {
        finish("disconnected", "Session transport closed.");
      },
    };

    const listeners: [string, EventListener][] = [
      [
        "open",
        () => {
          try {
            send({ type: "authenticate", ticket: current.ticket });
          } catch {
            finish("disconnected", "Session authentication could not be sent.");
          }
        },
      ],
      ["error", () => finish("disconnected", "Session connection unavailable.")],
      [
        "close",
        (event) =>
          finish(
            (event as CloseEvent).code === 1008 ? "revoked" : "disconnected",
            "Session connection closed.",
          ),
      ],
      [
        "message",
        (event) => {
          try {
            if (Date.now() >= current.expiresAt * 1000) {
              finish("revoked", "Session authorization expired.");
              return;
            }
            const data = (event as MessageEvent).data;
            if (typeof data !== "string" || new TextEncoder().encode(data).length > MAX_FRAME_BYTES)
              throw new Error("Invalid frame.");
            const message = JSON.parse(data);
            if (!message || typeof message !== "object" || Array.isArray(message))
              throw new Error("Invalid message.");
            if (!authenticated) {
              if (
                message.type !== "authenticated" ||
                message.protocolVersion !== "0.165.0" ||
                !sameBinding(bindingSchema.parse(message.binding), current.binding)
              )
                throw new Error("Authentication binding mismatch.");
              authenticated = true;
              clearTimeout(handshakeTimer);
              scheduleAuthorization();
              resolve(transport);
              return;
            }
            if (message.type === "renewed") {
              if (!pendingRenewal || message.expiresAt !== pendingRenewal.expiresAt)
                throw new Error("Unexpected renewal acknowledgement.");
              current = pendingRenewal;
              pendingRenewal = undefined;
              clearTimeout(renewalDeadline);
              scheduleAuthorization();
              return;
            }
            if (message.type === "renewalRejected") {
              finish("revoked", "Session renewal was rejected.");
              return;
            }
            if ("id" in message) {
              if (!Number.isSafeInteger(message.id) || "result" in message === "error" in message)
                throw new Error("Invalid RPC response.");
              const request = requests.get(message.id);
              if (!request) throw new Error("Unknown RPC response.");
              if ("error" in message) {
                const error = z
                  .object({ code: z.number().int(), message: z.string().max(1000) })
                  .parse(message.error);
                clearTimeout(request.timer);
                requests.delete(message.id);
                request.reject(Object.assign(new Error(error.message), { code: error.code }));
              } else {
                clearTimeout(request.timer);
                requests.delete(message.id);
                request.resolve(message.result);
              }
              return;
            }
            if (
              !ALLOWED_EVENTS.has(message.method) ||
              message.params?.threadId !== grant.binding.threadId
            )
              throw new Error("Invalid session event.");
            if (notifications.size) for (const listener of notifications) listener(message);
            else {
              if (backlog.length >= 64) throw new Error("Event backlog exceeded.");
              backlog.push(message);
            }
          } catch {
            finish("revoked", "Session protocol rejected.");
          }
        },
      ],
    ];
    for (const [type, listener] of listeners) socket.addEventListener(type, listener);
  });
}
