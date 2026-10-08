import { VoiceRequestRejected, type VoiceRpc } from "./voice-rpc";

export type VoiceThread = { id: string; name: string; cwd: string };
type Thread = {
  id: string;
  name?: string | null;
  cwd: string;
  parentThreadId?: string | null;
  canAcceptDirectInput?: boolean | null;
};

export async function listVoiceThreads(rpc: VoiceRpc): Promise<VoiceThread[]> {
  const loaded = await rpc.request<{ data: string[]; nextCursor?: string | null }>(
    "thread/loaded/list",
    { limit: 100 },
  );
  // A bounded prototype: no saved-thread resumption, no configuration overrides.
  const threads: VoiceThread[] = [];
  for (let index = 0; index < loaded.data.length; index += 10) {
    const results = await Promise.all(
      loaded.data.slice(index, index + 10).map(async (threadId) => {
        const { thread } = await rpc.request<{ thread: Thread }>("thread/read", {
          threadId,
          includeTurns: false,
        });
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
      let startSent = false;
      let startAccepted = false;
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
        rpc.onNotification = () => {};
        rpc.onClose = () => {};
        try {
          controller.close();
        } catch {
          /* Consumer canceled. */
        }
        // Keep the control connection briefly so disconnect actually ends voice.
        // Never stop a session whose start was explicitly rejected.
        if (startAccepted || startSent) {
          void rpc
            .request("thread/realtime/stop", { threadId }, 3_000)
            .catch(() => {})
            .finally(() => rpc.close());
        } else rpc.close();
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
          startSent = false;
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
      startSent = true;
      void rpc
        .request("thread/realtime/start", {
          threadId,
          // Codex 0.161's AVAS WebRTC endpoint requires the V3 negotiation headers.
          version: "v3",
          outputModality: "audio",
          transport: { type: "webrtc", sdp },
        })
        .then(() => {
          startAccepted = true;
        })
        .catch((error) => {
          if (error instanceof VoiceRequestRejected) startSent = false;
          send({
            type: "error",
            message:
              "Codex rejected voice startup. Check voice availability and end any existing voice call first.",
          });
          finish();
        });
    },
    cancel() {
      finish();
    },
  });
}
