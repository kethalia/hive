import type { VoiceRpc } from "./voice-rpc";

export type VoiceThread = { id: string; name: string; cwd: string };
type Thread = {
  id: string;
  name?: string | null;
  cwd: string;
  parentThreadId?: string | null;
  canAcceptDirectInput?: boolean | null;
};

export async function listVoiceThreads(rpc: VoiceRpc): Promise<VoiceThread[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const loaded = await rpc.request<{ data: unknown; nextCursor?: unknown }>(
      "thread/loaded/list",
      { limit: 100, ...(cursor ? { cursor } : {}) },
    );
    if (
      !loaded ||
      !Array.isArray(loaded.data) ||
      loaded.data.length > 100 ||
      loaded.data.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 200 || seen.has(id),
      ) ||
      new Set(loaded.data).size !== loaded.data.length
    )
      throw new Error("Invalid Codex thread list");
    for (const id of loaded.data as string[]) {
      seen.add(id);
      ids.push(id);
    }
    const next = loaded.nextCursor;
    if (next === null || next === undefined) break;
    if (
      typeof next !== "string" ||
      !next.length ||
      next.length > 256 ||
      cursors.has(next) ||
      page === 9
    )
      throw new Error("Invalid Codex thread cursor");
    cursors.add(next);
    cursor = next;
  }
  // A bounded prototype: no saved-thread resumption, no configuration overrides.
  const threads: VoiceThread[] = [];
  for (let index = 0; index < ids.length; index += 10) {
    const results = await Promise.all(
      ids.slice(index, index + 10).map(async (threadId) => {
        const { thread } = await rpc.request<{ thread: Thread }>("thread/read", {
          threadId,
          includeTurns: false,
        });
        if (!thread || thread.id !== threadId || typeof thread.cwd !== "string")
          throw new Error("Invalid Codex thread");
        if (thread.parentThreadId || thread.canAcceptDirectInput === false) return null;
        return { id: thread.id, name: thread.name || thread.id, cwd: thread.cwd };
      }),
    );
    threads.push(...results.filter((thread): thread is VoiceThread => thread !== null));
  }
  return threads;
}

/** Stream signaling only; the browser's WebRTC connection carries the audio. */
export function createVoiceStream(
  rpc: VoiceRpc,
  threadId: string,
  sdp: string,
  signal: AbortSignal,
) {
  let finish: () => void = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      let startPending = false;
      let startAccepted = false;
      let upstreamClosed = false;
      let stopStarted = false;
      const closeStartedCall = () => {
        if (stopStarted) return;
        stopStarted = true;
        rpc.onNotification = () => {};
        if (startAccepted) {
          void rpc
            .request("thread/realtime/stop", { threadId }, 3_000)
            .catch(() => {})
            .finally(() => rpc.close());
        } else rpc.close();
      };
      const encoder = new TextEncoder();
      let heartbeat: ReturnType<typeof setInterval>;
      let deadline: ReturnType<typeof setTimeout>;
      let startupDeadline: ReturnType<typeof setTimeout>;
      const send = (event: Record<string, unknown>) => {
        if (finished) return;
        // Bound a stalled browser's signaling queue (audio never enters it).
        if ((controller.desiredSize ?? 0) < -16) {
          finish();
          return;
        }
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          finish();
        }
      };
      finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(deadline);
        clearTimeout(startupDeadline);
        signal.removeEventListener("abort", finish);
        rpc.onNotification = startPending
          ? ({ method, params }) => {
              if (method === "thread/realtime/closed" && params?.threadId === threadId)
                upstreamClosed = true;
            }
          : () => {};
        rpc.onClose = () => {};
        try {
          controller.close();
        } catch {
          /* Consumer canceled. */
        }
        // If startup is pending, its response decides whether this call owns a
        // session. An uncertain/rejected start must not stop another client's call.
        if (!startPending) closeStartedCall();
      };
      rpc.onClose = () => {
        send({ type: "error", message: "The Codex connection closed. Voice has ended." });
        finish();
      };
      rpc.onNotification = ({ method, params }) => {
        if (params?.threadId !== threadId || finished) return;
        if (method === "thread/realtime/sdp" && typeof params.sdp === "string") {
          clearTimeout(startupDeadline);
          send({ type: "sdp", sdp: params.sdp });
        } else if (method === "thread/realtime/error") {
          send({
            type: "error",
            message:
              "Codex could not start or continue voice. Check voice access and sign-in in the terminal.",
          });
          finish();
        } else if (method === "thread/realtime/closed") {
          upstreamClosed = true;
          startAccepted = false;
          send({ type: "closed" });
          finish();
        }
      };
      heartbeat = setInterval(() => send({ type: "ping" }), 10_000);
      deadline = setTimeout(() => {
        send({
          type: "error",
          message: "Voice reached its 30-minute prototype limit. Start again to continue.",
        });
        finish();
      }, 30 * 60_000);
      startupDeadline = setTimeout(() => {
        send({ type: "error", message: "Codex voice negotiation timed out." });
        finish();
      }, 30_000);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) {
        finish();
        return;
      }
      startPending = true;
      void rpc
        .request("thread/realtime/start", {
          threadId,
          // Codex 0.161's AVAS WebRTC endpoint requires the V3 negotiation headers.
          version: "v3",
          outputModality: "audio",
          transport: { type: "webrtc", sdp },
        })
        .then(() => {
          startPending = false;
          startAccepted = !upstreamClosed;
          if (finished) closeStartedCall();
        })
        .catch(() => {
          startPending = false;
          send({
            type: "error",
            message:
              "Codex rejected voice startup. Check voice availability and end any existing voice call first.",
          });
          if (finished) closeStartedCall();
          else finish();
        });
    },
    cancel() {
      finish();
    },
  });
}
