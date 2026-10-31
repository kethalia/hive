import { authServiceHeaders, isLoopbackHostname, verifyTerminalTicket } from "@hive/auth";
import { z } from "zod";
import {
  cancelPublicationBody,
  publicationBody,
  publicationFetch,
} from "../../../src/lib/templates/publication-io";
import {
  GenericTerminalFailure,
  genericTerminalAuthClient,
  genericTerminalSessionSchema,
} from "../../../src/lib/terminal/generic-auth.server";
import {
  type GenericTerminalAuthority,
  type GenericTerminalDependencies,
  type GenericTerminalTarget,
  genericTerminalPath,
  openGenericTerminalRelay,
  TERMINAL_SUBPROTOCOL,
} from "./generic-terminal-relay";
import type { RelaySocket } from "./project-relay";

export type GenericTerminalEnvironment = {
  HIVE_GENERIC_TERMINAL_ENABLED?: string;
  HIVE_PREVIEW_ORIGIN?: string;
  CODER_URL?: string;
  COOKIE_SECRET?: string;
  AUTH_SERVICE_SECRET?: string;
  AUTH_SERVICE?: { fetch: typeof fetch };
};
const uuid = z.string().uuid();
const tokenSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[!-~]+$/),
  coderUrl: z.string(),
  expiresAt: z.string().nullable(),
});

const workspaceSchema = z.object({
  id: uuid,
  owner_id: uuid,
  latest_build: z.object({
    id: uuid,
    status: z.string(),
    resources: z
      .array(z.object({ agents: z.array(z.object({ id: uuid, status: z.string() })).max(100) }))
      .max(100),
  }),
});
const privateError = (status: number) =>
  Response.json(
    { error: "Terminal transport unavailable" },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
// Admission pressure only, never identity/authorization or durable activity state.
let activeAttachments = 0;
async function settledPair<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const [a, b] = await Promise.allSettled([first, second]);
  if (a.status === "rejected") throw a.reason;
  if (b.status === "rejected") throw b.reason;
  return [a.value, b.value];
}

function configuredOrigin(value: string | undefined) {
  const url = new URL(value ?? "");
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
  )
    throw new Error("origin");
  return url.origin;
}
/** Only authenticated server callers supply sessionId; no request payload is identity. */
export async function authorizeOwnedWorkspacePty(
  sessionId: string,
  env: GenericTerminalEnvironment,
  workspaceId: string,
  agentId: string | undefined,
  callerSignal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const coderOrigin = configuredOrigin(env.CODER_URL);
  if (
    !uuid.safeParse(workspaceId).success ||
    (agentId !== undefined && !uuid.safeParse(agentId).success)
  )
    throw new Error("workspace");
  async function json(path: string, token: string, signal: AbortSignal) {
    const response = await publicationFetch(
      fetcher(`${coderOrigin}${path}`, {
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: { "Coder-Session-Token": token, Accept: "application/json" },
      }),
      signal,
    );
    if (response.status !== 200 || response.redirected) {
      await cancelPublicationBody(response);
      throw new Error("coder");
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await publicationBody(response, 1048576, signal),
      ),
    );
  }
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(5000)]);
  const auth = genericTerminalAuthClient(env, signal);
  const [rawSession, rawToken] = await settledPair(
    auth.getSession(sessionId),
    auth.getCoderToken(sessionId),
  );
  const session = genericTerminalSessionSchema.parse(rawSession),
    credential = tokenSchema.parse(rawToken);
  const sessionExpiry = Date.parse(session.expiresAt),
    tokenExpiry = credential.expiresAt === null ? Infinity : Date.parse(credential.expiresAt);
  if (
    session.sessionId !== sessionId ||
    session.coderUrl !== coderOrigin ||
    credential.coderUrl !== coderOrigin ||
    !Number.isFinite(sessionExpiry) ||
    sessionExpiry <= Date.now() ||
    (tokenExpiry !== Infinity && (!Number.isFinite(tokenExpiry) || tokenExpiry <= Date.now()))
  )
    throw new GenericTerminalFailure(4401);
  const [user, workspace] = await settledPair(
    json("/api/v2/users/me", credential.token, signal),
    json(`/api/v2/workspaces/${workspaceId}`, credential.token, signal),
  );
  const current = workspaceSchema.parse(workspace);
  const agents = current.latest_build.resources
    .flatMap((r) => r.agents)
    .filter((a) => agentId === undefined || a.id === agentId);
  if (
    user?.id !== session.coderUserId ||
    current.id !== workspaceId ||
    current.owner_id !== session.coderUserId
  )
    throw new GenericTerminalFailure(4403);
  if (
    current.latest_build.status !== "running" ||
    agents.length !== 1 ||
    agents[0].status !== "connected"
  )
    throw new GenericTerminalFailure(4404);
  signal.throwIfAborted();
  return {
    sessionId,
    agentId: agents[0].id,
    userId: session.userId,
    coderUserId: session.coderUserId,
    coderOrigin,
    buildId: current.latest_build.id,
    token: credential.token,
    expiresAt: Math.min(sessionExpiry, tokenExpiry),
  };
}

export function createGenericTerminalDependencies(
  request: Request,
  env: GenericTerminalEnvironment,
  transport: {
    fetch?: typeof fetch;
    pair(): { client: RelaySocket; server: RelaySocket };
    response(client: RelaySocket): Response;
    trackCleanup(promise: Promise<void>): void;
    onClosed(): void;
  },
): GenericTerminalDependencies {
  const hiveOrigin = configuredOrigin(env.HIVE_PREVIEW_ORIGIN),
    coderOrigin = configuredOrigin(env.CODER_URL);
  if (typeof env.AUTH_SERVICE_SECRET !== "string" || !env.AUTH_SERVICE || !env.COOKIE_SECRET)
    throw new Error("configuration");
  authServiceHeaders(env.AUTH_SERVICE_SECRET);
  const headers = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((v) => v.trim());
  const tickets = headers.filter((v) => v.startsWith("hive-ticket."));
  if (
    headers.length !== 2 ||
    !headers.includes(TERMINAL_SUBPROTOCOL) ||
    tickets.length !== 1 ||
    request.headers.has("Authorization")
  )
    throw new Error("ticket");
  const url = new URL(request.url);
  const ticket = verifyTerminalTicket(tickets[0].slice(12), env.COOKIE_SECRET, {
    audience: new URL(hiveOrigin).host,
    origin: hiveOrigin,
    requestTarget: url.pathname + url.search,
  });
  if (!ticket) throw new Error("ticket");
  // Ticket expiry bounds admission only. Every later refresh reauthorizes the
  // captured session/subject independently; it never renews a stale ticket.
  const sessionId = ticket.sessionId;
  const fetcher = transport.fetch ?? fetch;
  const deps: GenericTerminalDependencies = {
    ...transport,
    async authorize(_incoming, target, callerSignal) {
      return authorizeOwnedWorkspacePty(
        sessionId,
        env,
        target.workspaceId,
        target.agentId,
        callerSignal,
        fetcher,
      );
    },
    async upgrade(url, init) {
      const signal = init.signal ?? AbortSignal.timeout(10000);
      const work = fetcher(url, init);
      void work.then(
        (late) => {
          const socket = (late as Response & { webSocket?: RelaySocket }).webSocket;
          if (signal.aborted && socket) {
            try {
              socket.accept({ allowHalfOpen: true });
              socket.close(1008, "Terminal connection expired");
            } catch {}
          }
        },
        () => {},
      );
      const response = await publicationFetch(work, signal);
      return {
        status: response.status,
        body: response.body,
        webSocket: (response as Response & { webSocket?: RelaySocket }).webSocket,
      };
    },
    async extend(authority: GenericTerminalAuthority, target: GenericTerminalTarget, signal) {
      const response = await publicationFetch(
        fetcher(`${coderOrigin}/api/v2/workspaces/${target.workspaceId}/extend`, {
          method: "PUT",
          redirect: "manual",
          credentials: "omit",
          signal,
          headers: { "Content-Type": "application/json", "Coder-Session-Token": authority.token },
          body: JSON.stringify({ deadline: new Date(Date.now() + 3600000).toISOString() }),
        }),
        signal,
      );
      const okay = [200, 304].includes(response.status) && !response.redirected;
      await cancelPublicationBody(response);
      if (!okay) throw new Error("keepalive");
    },
  };
  return deps;
}

export async function genericTerminalRelay(
  request: Request,
  env: GenericTerminalEnvironment,
  previewExpiresAt: number,
  context: { waitUntil(promise: Promise<unknown>): void },
) {
  if (!genericTerminalPath(request) || env.HIVE_GENERIC_TERMINAL_ENABLED !== "true")
    return privateError(404);
  if (activeAttachments >= 4) return privateError(503);
  activeAttachments++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeAttachments--;
    }
  };
  try {
    const deps = createGenericTerminalDependencies(request, env, {
      pair() {
        const runtime = globalThis as typeof globalThis & {
          WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket };
        };
        const pair = new runtime.WebSocketPair();
        return { client: pair[0], server: pair[1] };
      },
      response(client) {
        const init: ResponseInit & { webSocket: RelaySocket } = {
          status: 101,
          webSocket: client,
          headers: {
            "Sec-WebSocket-Protocol": TERMINAL_SUBPROTOCOL,
            "Cache-Control": "private, no-store",
          },
        };
        return new Response(null, init);
      },
      trackCleanup: (work) => context.waitUntil(work),
      onClosed: release,
    });
    const response = await openGenericTerminalRelay(
      request,
      configuredOrigin(env.HIVE_PREVIEW_ORIGIN),
      previewExpiresAt,
      deps,
    );
    if (response.status !== 101) release();
    return response;
  } catch {
    release();
    return privateError(401);
  }
}
