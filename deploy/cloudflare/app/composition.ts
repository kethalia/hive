import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import {
  terminalDiagnosticsPath,
  terminalDiagnosticsRuntime,
} from "@/lib/terminal/diagnostics.server";
import { audioPath } from "./audio-relay";
import { audioRuntime } from "./audio-runtime";
import { genericTerminalPath } from "./generic-terminal-relay";
import { type GenericTerminalEnvironment, genericTerminalRelay } from "./generic-terminal-runtime";
import {
  boundPortableActionBody,
  isPortableDiscovery,
  isPortableServerAction,
  isUnsupportedPageMutation,
  type PortableActions,
} from "./portable-actions";
import { runRequestLifetime } from "./request-lifetime";

type Environment = GenericTerminalEnvironment & {
  DATABASE_URL?: string;
  AUTH_SERVICE?: { fetch: typeof fetch };
};
type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

export function createAppWorker(
  framework: { fetch(request: Request, env: Environment, context: Context): Promise<Response> },
  actions: PortableActions,
) {
  return {
    async fetch(request: Request, env: Environment, context: Context): Promise<Response> {
      if (audioPath(request)) return audioRuntime(request, env, Number.MAX_SAFE_INTEGER, context);
      if (genericTerminalPath(request)) {
        const databaseUrl = env.DATABASE_URL;
        return genericTerminalRelay(request, env, Number.MAX_SAFE_INTEGER, context, (bounds) =>
          createCloudflareDatabaseRequest(databaseUrl, bounds),
        );
      }
      const path = new URL(request.url).pathname;
      const unavailable =
        request.headers.has("Upgrade") ||
        isUnsupportedPageMutation(request, actions) ||
        (request.headers.has("Next-Action") && !isPortableServerAction(request, actions)) ||
        (path.startsWith("/api/discovery/") && !isPortableDiscovery(request, true, true));
      if (unavailable)
        return Response.json(
          { error: "This capability is unavailable in this preview." },
          { status: 503, headers: { "Cache-Control": "private, no-store" } },
        );
      if (request.headers.has("Next-Action")) {
        const bounded = await boundPortableActionBody(request, actions);
        if (bounded instanceof Response) return bounded;
        request = bounded;
      }
      const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
      const response = await runRequestLifetime(database, context, (tracked) =>
        terminalDiagnosticsPath(request)
          ? terminalDiagnosticsRuntime(request, env)
          : framework.fetch(request, env, tracked),
      );
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "private, no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
