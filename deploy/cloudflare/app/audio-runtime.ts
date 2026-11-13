import type { RelaySocket } from "../../../src/lib/terminal/relay-types";
import { AUDIO_PROTOCOL, audioPath, openAudioRelay } from "./audio-relay";
import {
  createGenericTerminalDependencies,
  type GenericTerminalEnvironment,
} from "./generic-terminal-runtime";

export type AudioEnvironment = GenericTerminalEnvironment;
// Per-isolate admission pressure only. Authorization is refreshed per attachment.
let active = 0;
export async function audioRuntime(
  request: Request,
  env: AudioEnvironment,
  attachmentExpiresAt: number,
  context: { waitUntil(promise: Promise<unknown>): void },
) {
  const error = (status: number) =>
    Response.json(
      { error: "Audio transport unavailable" },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  if (!audioPath(request) || env.HIVE_GENERIC_TERMINAL_ENABLED !== "true") return error(404);
  if (active >= 4) return error(503);
  active++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      active--;
    }
  };
  try {
    const deps = createGenericTerminalDependencies(
      request,
      env,
      {
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
              "Sec-WebSocket-Protocol": AUDIO_PROTOCOL,
              "Cache-Control": "private, no-store",
            },
          };
          return new Response(null, init);
        },
        trackCleanup: (work) => context.waitUntil(work),
        onClosed: release,
      },
      AUDIO_PROTOCOL,
    );
    const response = await openAudioRelay(
      request,
      env.HIVE_PUBLIC_ORIGIN ?? "",
      attachmentExpiresAt,
      deps,
    );
    if (response.status !== 101) release();
    return response;
  } catch {
    release();
    return error(401);
  }
}
