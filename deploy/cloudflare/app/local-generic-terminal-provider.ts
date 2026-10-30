// Local-only synthetic auth/Coder provider. No deployed configuration imports it.
import type { RelaySocket } from "./project-relay";

const workspaceId = "30000000-0000-4000-8000-000000000001",
  agentId = "40000000-0000-4000-8000-000000000001",
  coderId = "20000000-0000-4000-8000-000000000001",
  userId = "10000000-0000-4000-8000-000000000001",
  buildId = "50000000-0000-4000-8000-000000000001";
let revoked = false,
  frames = 0,
  extensions = 0;
const ids = new Set<string>();
export default {
  fetch(request: Request, env: { PROOF_BEARER: string; AUTH_SERVICE_SECRET: string }) {
    const url = new URL(request.url),
      path = url.pathname;
    if (path.startsWith("/__local/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`)
        return new Response(null, { status: 401 });
      if (path === "/__local/revoke") {
        revoked = true;
        return Response.json({ revoked });
      }
      return Response.json({ sessions: ids.size, frames, extensions });
    }
    if (path.startsWith("/sessions/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.AUTH_SERVICE_SECRET}` || revoked)
        return new Response(null, { status: 404 });
      if (path === "/sessions/fixture-session/token")
        return Response.json({
          token: "synthetic-coder-token",
          coderUrl: "https://coder.example",
          expiresAt: null,
        });
      if (path === "/sessions/fixture-session")
        return Response.json({
          userId,
          coderUserId: coderId,
          coderUrl: "https://coder.example",
          sessionId: "fixture-session",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        });
      return new Response(null, { status: 404 });
    }
    if (
      request.headers.get("Coder-Session-Token") !== "synthetic-coder-token" ||
      request.headers.has("Cookie") ||
      request.headers.has("Authorization")
    )
      return new Response(null, { status: 403 });
    if (path === "/api/v2/users/me") return Response.json({ id: coderId });
    if (path === `/api/v2/workspaces/${workspaceId}`)
      return Response.json({
        id: workspaceId,
        owner_id: coderId,
        latest_build: {
          id: buildId,
          status: "running",
          resources: [{ agents: [{ id: agentId, status: "connected" }] }],
        },
      });
    if (path === `/api/v2/workspaces/${workspaceId}/extend` && request.method === "PUT") {
      extensions++;
      return new Response(null, { status: 304 });
    }
    if (
      path !== `/api/v2/workspaceagents/${agentId}/pty` ||
      request.headers.get("Upgrade") !== "websocket" ||
      !url.searchParams.get("command")?.includes("new-session -A")
    )
      return new Response(null, { status: 404 });
    ids.add(url.searchParams.get("reconnect") ?? "invalid");
    const runtime = globalThis as typeof globalThis & {
      WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket };
    };
    const pair = new runtime.WebSocketPair(),
      server = pair[1];
    server.binaryType = "arraybuffer";
    server.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        server.close(1003, "fixture binary input required");
        return;
      }
      frames++;
      const raw = new TextDecoder().decode(event.data),
        value = JSON.parse(raw);
      if (value.data === "flood") {
        for (let i = 0; i < 5; i++) server.send(new Uint8Array(1048576));
        return;
      }
      if (value.data === "close") {
        server.close(1008, "fixture private provider detail");
        return;
      }
      server.send(
        new TextEncoder().encode(
          value.data === undefined ? `resize:${value.height}:${value.width}` : value.data,
        ),
      );
    });
    server.accept({ allowHalfOpen: true });
    const init: ResponseInit & { webSocket: RelaySocket } = { status: 101, webSocket: pair[0] };
    return new Response(null, init);
  },
};
