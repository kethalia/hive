interface PushStreamCallbacks {
  onLine: (line: string) => void;
  onStatus: (result: { success: boolean; error?: string }) => void;
  onReconnect: () => void;
}

/** Follow one enqueued job until a terminal status arrives or the caller leaves. */
export function followTemplatePush(
  name: string,
  jobId: string,
  { onLine, onStatus, onReconnect }: PushStreamCallbacks,
): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let receivedLines = 0;

  function stop() {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    source?.close();
    source = null;
  }

  function reconnect() {
    if (stopped || retryTimer !== null) return;
    source?.close();
    source = null;
    onReconnect();
    const delay = Math.min(1000 * 2 ** Math.min(attempts++, 5), 30_000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    // The endpoint replays the append-only log from the beginning. Skip lines
    // already delivered so reconnecting does not duplicate terminal output.
    let replayLines = receivedLines;
    try {
      const connection = new EventSource(`/api/templates/${name}/push/${jobId}/stream`);
      source = connection;
      const current = () => !stopped && source === connection;
      connection.onmessage = (event) => {
        if (!current()) return;
        attempts = 0;
        if (replayLines > 0) {
          replayLines--;
          return;
        }
        receivedLines++;
        onLine(event.data);
      };
      connection.addEventListener("status", (event) => {
        if (!current()) return;
        let result: { success: boolean; error?: string };
        try {
          result = JSON.parse((event as MessageEvent).data);
          if (typeof result?.success !== "boolean") throw new Error("Invalid push status");
        } catch {
          reconnect();
          return;
        }
        stop();
        onStatus(result);
      });
      connection.onerror = () => {
        if (current()) reconnect();
      };
    } catch {
      reconnect();
    }
  }

  connect();
  return stop;
}
