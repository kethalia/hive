// Simulated native provider, reached through a real local Worker service binding.
import type { RelaySocket } from "./project-relay";

type Runtime = typeof globalThis & { WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket } };
let providerMessages = 0;
export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname === "/__local-provider-status")
      return Response.json({ providerMessages });
    if (
      new URL(request.url).pathname !== "/session" ||
      request.headers.get("Upgrade") !== "websocket" ||
      request.headers.get("Cookie") !==
        `coder_subdomain_app_session_token_${"a".repeat(32)}=fixture-scoped-cookie`
    )
      return new Response(null, { status: 403 });
    const pair = new (globalThis as Runtime).WebSocketPair(),
      server = pair[1];
    let authenticated = false;
    server.addEventListener("message", (event) => {
      providerMessages++;
      if (!authenticated) {
        if (event.data !== '{"type":"auth","ticket":"fixture-signed-ticket"}') {
          server.close(1008, "fixture upstream secret reason");
          return;
        }
        authenticated = true;
        server.send("fixture-authenticated");
        return;
      }
      if (event.data === "fixture-close") {
        server.close(1008, "fixture upstream secret reason");
        return;
      }
      server.send(event.data as string | ArrayBuffer | ArrayBufferView);
    });
    server.binaryType = "arraybuffer";
    server.accept();
    const init: ResponseInit & { webSocket: RelaySocket } = { status: 101, webSocket: pair[0] };
    return new Response(null, init);
  },
};
