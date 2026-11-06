// Local-only composition of actual ticket/auth/provider/relay code, all providers synthetic.
import { createTerminalTicket } from "@hive/auth";
import { openGenericTerminalRelay } from "./generic-terminal-relay";
import {
  createGenericTerminalDependencies,
  genericTerminalRelay,
} from "./generic-terminal-runtime";
import type { RelaySocket } from "./project-relay";

type Env = {
  PROOF_BEARER: string;
  AUTH_SERVICE_SECRET: string;
  COOKIE_SECRET: string;
  PROVIDER: { fetch: typeof fetch };
};
export default {
  async fetch(request: Request, env: Env, context: { waitUntil(promise: Promise<unknown>): void }) {
    const url = new URL(request.url);
    const config = {
      HIVE_GENERIC_TERMINAL_ENABLED: "true",
      HIVE_PREVIEW_ORIGIN: url.origin,
      CODER_URL: "https://coder.example",
      COOKIE_SECRET: env.COOKIE_SECRET,
      AUTH_SERVICE_SECRET: env.AUTH_SERVICE_SECRET,
      AUTH_SERVICE: env.PROVIDER,
    };
    if (url.pathname.startsWith("/__local/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`)
        return new Response(null, { status: 401 });
      if (url.pathname === "/__local/off")
        return genericTerminalRelay(
          new Request(`${url.origin}/ws`),
          { ...config, HIVE_GENERIC_TERMINAL_ENABLED: "false" },
          Date.now() + 1000,
          context,
        );
      if (url.pathname === "/__local/ticket") {
        const target = await request.text();
        if (!target.startsWith("/ws?") || target.length > 2048)
          return new Response(null, { status: 400 });
        const ticket = createTerminalTicket(
          {
            sessionId: "fixture-session",
            audience: url.host,
            origin: url.origin,
            requestTarget: target,
          },
          env.COOKIE_SECRET,
          Date.now() + 3600000,
          request.headers.get("X-Local-Expired") === "yes" ? Date.now() - 60000 : Date.now(),
        );
        return Response.json({ ticket });
      }
      return env.PROVIDER.fetch(new Request(`https://coder.example${url.pathname}`, request));
    }
    if (url.pathname !== "/ws") return new Response(null, { status: 404 });
    try {
      const deps = createGenericTerminalDependencies(request, config, {
        fetch: env.PROVIDER.fetch.bind(env.PROVIDER),
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
            headers: { "Sec-WebSocket-Protocol": "hive-terminal-v1" },
          };
          return new Response(null, init);
        },
        onClosed() {},
        trackCleanup: (work) => context.waitUntil(work),
      });
      return await openGenericTerminalRelay(
        request,
        url.origin,
        Date.now() + (request.headers.get("X-Local-Short") === "yes" ? 1500 : 60000),
        deps,
      );
    } catch {
      return new Response(null, { status: 401 });
    }
  },
};
