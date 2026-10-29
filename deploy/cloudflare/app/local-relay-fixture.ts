// Local transport fixture only: provider/auth metadata are explicitly simulated.
import { openProjectRelay, type RelaySocket } from "./project-relay";

type Runtime = typeof globalThis & { WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket } };
const pair = () => {
  const sockets = new (globalThis as Runtime).WebSocketPair();
  return { client: sockets[0], server: sockets[1] };
};
const upgraded = (socket: RelaySocket) => {
  const init: ResponseInit & { webSocket: RelaySocket } = { status: 101, webSocket: socket };
  return new Response(null, init);
};
let reauthorizations = 0;

export default {
  async fetch(
    request: Request,
    env: { RELAY_PROOF_BEARER: string; PROVIDER: { fetch: typeof fetch } },
  ) {
    if (request.headers.get("Authorization") !== `Bearer ${env.RELAY_PROOF_BEARER}`)
      return new Response(null, { status: 401 });
    if (new URL(request.url).pathname === "/__local-relay-status")
      return Response.json({ reauthorizations });
    const now = Date.now(),
      origin = new URL(request.url).origin;
    const principal = {
      hiveUserId: "fixture-owner",
      coderUserId: "fixture-coder-owner",
      coderOrigin: "https://coder.example",
      expiresAt: now + 180000,
    };
    const target = {
      coderOrigin: principal.coderOrigin,
      appOrigin: "https://registered-app.example",
      registrationId: "fixture-registration",
      expiresAt: Math.floor(now / 1000) + 180,
      binding: {
        ownerId: principal.coderUserId,
        workspaceId: "fixture-workspace",
        buildId: "fixture-build",
        serverInstanceId: "fixture-instance",
        threadId: "fixture-thread",
      },
    };
    const result = await openProjectRelay(
      request,
      origin,
      request.headers.get("X-Local-Short-Lifetime") === "yes" ? now + 2000 : now + 120000,
      {
        authenticate: async () =>
          request.headers.get("Cookie") === "__Host-hive-session=fixture" ? principal : null,
        authorize: async () => target,
        reauthorize: async (_request, _projectId, signal) => {
          signal.throwIfAborted();
          reauthorizations++;
          return { principal, target };
        },
        exchange: async (_principal, target, kind) => ({
          url: `${target.appOrigin}/${kind}`,
          cookie: `coder_subdomain_app_session_token_${"a".repeat(32)}=fixture-scoped-cookie`,
        }),
        async upgrade(url, init) {
          const headers = new Headers(init.headers);
          if (
            url !== `${target.appOrigin}/session` ||
            headers.get("Cookie") !==
              `coder_subdomain_app_session_token_${"a".repeat(32)}=fixture-scoped-cookie` ||
            headers.get("Origin") !== origin ||
            headers.has("Authorization")
          )
            throw new Error("Fixture fixed-target failure");
          const response = await env.PROVIDER.fetch(url, init);
          return {
            status: response.status,
            body: response.body,
            webSocket: (response as Response & { webSocket?: RelaySocket }).webSocket,
          };
        },
        pair,
        response: upgraded,
      },
    );
    return result.response;
  },
};
