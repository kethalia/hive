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

/** Native WebSocket lifetime is separate from HTTP response-stream/Prisma lifetime. */
export async function projectRelay(
  request: Request,
  env: ProjectRelayEnvironment,
  previewExpiresAt: number,
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
  let database: ReturnType<typeof createCloudflareDatabaseRequest> | undefined;
  let result: Awaited<ReturnType<typeof openProjectRelay>> | undefined;
  let closedSuccessfully = true;
  try {
    database = createCloudflareDatabaseRequest(env.DATABASE_URL);
    result = await database.run(async () => {
      const db = getDb();
      const auth = new AuthServiceClient("https://hive-auth.internal", undefined, {
        fetch: env.AUTH_SERVICE?.fetch.bind(env.AUTH_SERVICE),
        serviceSecret: env.AUTH_SERVICE_SECRET,
      });
      const config = registeredSessionConfig();
      if (config.hiveOrigin !== env.HIVE_PREVIEW_ORIGIN) throw new Error("Relay origin mismatch");
      const service = createRegisteredSessionService(db, config);
      const deps: RelayDependencies = {
        async authenticate(incoming) {
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
          const session = await auth.getSession(verified.sessionId);
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
        },
        authorize: (principal, projectId) => service.authorizeRelayTarget(principal, projectId),
        async exchange(principal, target, kind) {
          const coder = await getCoderClientForUser(principal.hiveUserId);
          const exchange =
            kind === "session"
              ? exchangeVerifiedWorkspaceAppSessionCookie
              : exchangeVerifiedWorkspaceAppTerminalCookie;
          return exchange(coder, target, target.expiresAt);
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
    }
  }
  if (!closedSuccessfully) return error(503);
  if (result.response.status !== 101) release();
  return result.response;
}
