import { AuthServiceClient, SECURE_SESSION_COOKIE_NAME, verifyCookie } from "@hive/auth";
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { getCoderClientForUser } from "../../../src/lib/coder/user-client";
import {
  exchangeVerifiedWorkspaceAppSessionCookie,
  exchangeVerifiedWorkspaceAppTerminalCookie,
} from "../../../src/lib/codex-session/bootstrap-delivery.server";
import {
  createRegisteredSessionService,
  registeredSessionConfig,
} from "../../../src/lib/codex-session/registered-session.server";
import {
  openProjectRelay,
  projectRelayPath,
  type RelayDependencies,
  type RelayPrincipal,
  type RelaySocket,
} from "./project-relay";

export type ProjectRelayEnvironment = {
  DATABASE_URL?: string;
  AUTH_SERVICE?: { fetch: typeof fetch };
  AUTH_SERVICE_SECRET?: string;
  COOKIE_SECRET?: string;
  CODER_URL?: string;
  HIVE_CODEX_GATEWAY_ENABLED?: string;
  HIVE_CODEX_SESSION_TRANSPORT?: string;
  HIVE_CODEX_TERMINAL_ENABLED?: string;
  HIVE_PREVIEW_ORIGIN?: string;
};
let activeRelays = 0;
const error = (status: number) =>
  Response.json(
    { error: "Project transport unavailable" },
    { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" } },
  );

function runtimePair() {
  const runtime = globalThis as typeof globalThis & {
    WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket };
  };
  const pair = new runtime.WebSocketPair();
  return { client: pair[0], server: pair[1] };
}
function upgradeResponse(client: RelaySocket) {
  const init: ResponseInit & { webSocket: RelaySocket } = {
    status: 101,
    webSocket: client,
    headers: { "Cache-Control": "private, no-store" },
  };
  return new Response(null, init);
}

async function authenticate(
  incoming: Request,
  env: ProjectRelayEnvironment,
  signal?: AbortSignal,
): Promise<RelayPrincipal | null> {
  signal?.throwIfAborted();
  const values = (incoming.headers.get("Cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${SECURE_SESSION_COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const verified = verifyCookie(
    values[0].slice(SECURE_SESSION_COOKIE_NAME.length + 1),
    env.COOKIE_SECRET ?? "",
  );
  if (!verified) return null;
  const binding = env.AUTH_SERVICE;
  if (!binding) throw new Error("Relay authentication service unavailable");
  const auth = new AuthServiceClient("https://hive-auth.internal", undefined, {
    fetch: (input, init) => {
      signal?.throwIfAborted();
      return binding.fetch(input, {
        ...init,
        signal:
          signal && init?.signal
            ? AbortSignal.any([signal, init.signal])
            : (signal ?? init?.signal),
      });
    },
    serviceSecret: env.AUTH_SERVICE_SECRET,
  });
  const session = await auth.getSession(verified.sessionId);
  signal?.throwIfAborted();
  if (
    !session ||
    session.coderUrl.replace(/\/+$/, "") !== env.CODER_URL?.replace(/\/+$/, "") ||
    session.sessionId !== verified.sessionId
  )
    return null;
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return {
    hiveUserId: session.userId,
    coderUserId: session.coderUserId,
    coderOrigin: session.coderUrl.replace(/\/+$/, ""),
    expiresAt,
  };
}

/** Every refresh owns a new ALS/client lifetime; nothing captures the initial DB. */
async function reauthorize(
  request: Request,
  projectId: string,
  env: ProjectRelayEnvironment,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let database: ReturnType<typeof createCloudflareDatabaseRequest> | undefined;
  try {
    database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
      queryTimeoutMillis: 10_000,
      transactionTimeoutMillis: 10_000,
    });
    return await database.run(async () => {
      const principal = await authenticate(request, env, signal);
      if (!principal) throw new Error("Relay owner session unavailable");
      signal.throwIfAborted();
      const config = registeredSessionConfig();
      if (config.hiveOrigin !== env.HIVE_PREVIEW_ORIGIN) throw new Error("Relay origin mismatch");
      const service = createRegisteredSessionService(getDb(), config, { signal });
      const target = await service.authorizeRelayTarget(principal, projectId);
      signal.throwIfAborted();
      return { principal, target };
    });
  } finally {
    // A cancelled read drains before close; never allow a late continuation to
    // reconnect a Prisma client that was disconnected before it finished.
    await database?.close();
  }
}

/** Native WebSocket lifetime is separate from HTTP response-stream/Prisma lifetime. */
export async function projectRelay(
  request: Request,
  env: ProjectRelayEnvironment,
  previewExpiresAt: number,
  context?: { waitUntil(cleanup: Promise<void>): void },
) {
  const path = projectRelayPath(request);
  if (!path) return error(404);
  if (
    env.HIVE_CODEX_GATEWAY_ENABLED !== "true" ||
    env.HIVE_CODEX_SESSION_TRANSPORT !== "relay" ||
    (path.kind === "terminal" && env.HIVE_CODEX_TERMINAL_ENABLED !== "true")
  )
    return error(503);
  if (
    !env.AUTH_SERVICE ||
    !env.AUTH_SERVICE_SECRET ||
    !env.COOKIE_SECRET ||
    !env.CODER_URL ||
    !env.HIVE_PREVIEW_ORIGIN ||
    activeRelays >= 4
  )
    return error(503);
  activeRelays++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeRelays--;
    }
  };
  const setup = new AbortController();
  const setupTimer = setTimeout(() => setup.abort(), 10_000);
  const setupSignal = AbortSignal.any([request.signal, setup.signal]);
  let database: ReturnType<typeof createCloudflareDatabaseRequest> | undefined;
  let result: Awaited<ReturnType<typeof openProjectRelay>> | undefined;
  let closedSuccessfully = true;
  try {
    database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
      queryTimeoutMillis: 10_000,
      transactionTimeoutMillis: 10_000,
    });
    result = await database.run(async () => {
      const db = getDb();
      const config = registeredSessionConfig();
      if (config.hiveOrigin !== env.HIVE_PREVIEW_ORIGIN) throw new Error("Relay origin mismatch");
      const service = createRegisteredSessionService(db, config, { signal: setupSignal });
      const deps: RelayDependencies = {
        authenticate: (incoming) => authenticate(incoming, env, setupSignal),
        reauthorize: (incoming, projectId, signal) => reauthorize(incoming, projectId, env, signal),
        trackCleanup: context ? (cleanup) => context.waitUntil(cleanup) : undefined,
        authorize: (principal, projectId) => service.authorizeRelayTarget(principal, projectId),
        async exchange(principal, target, kind) {
          setupSignal.throwIfAborted();
          const coder = await getCoderClientForUser(principal.hiveUserId, { signal: setupSignal });
          const exchange =
            kind === "session"
              ? exchangeVerifiedWorkspaceAppSessionCookie
              : exchangeVerifiedWorkspaceAppTerminalCookie;
          return exchange(coder, target, target.expiresAt, (input, init) => {
            setupSignal.throwIfAborted();
            return fetch(input, {
              ...init,
              signal: init?.signal ? AbortSignal.any([setupSignal, init.signal]) : setupSignal,
            });
          });
        },
        upgrade: async (url, init) => fetch(url, init),
        pair: runtimePair,
        response: upgradeResponse,
        onClosed: release,
      };
      return openProjectRelay(request, env.HIVE_PREVIEW_ORIGIN ?? "", previewExpiresAt, deps);
    });
  } catch {
    result?.close();
    release();
    return error(503);
  } finally {
    try {
      await database?.close();
    } catch {
      result?.close();
      release();
      closedSuccessfully = false;
    } finally {
      clearTimeout(setupTimer);
    }
  }
  if (!closedSuccessfully) return error(503);
  if (result.response.status !== 101) release();
  return result.response;
}
