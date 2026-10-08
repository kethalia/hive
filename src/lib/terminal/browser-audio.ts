export type TerminalAudioStatus =
  | { phase: "standby" }
  | { phase: "connecting" | "active" | "error"; message: string };

let microphoneOwner: TerminalAudio | null = null;

/** A terminal owns its audio transport; native device activity owns microphone access. */
export class TerminalAudio {
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private visible = false;
  private disposed = false;
  private nativeActive = false;
  private generation = 0;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastPong = 0;
  private failed = false;
  private releaseMicrophoneLock: (() => void) | null = null;

  constructor(
    private url: string,
    private onStatus: (status: TerminalAudioStatus) => void,
  ) {}

  /** Called synchronously from Enter so playback can use the browser's user activation. */
  prime() {
    if (!this.visible || this.disposed || !window.AudioContext) return;
    try {
      this.context ??= new AudioContext({ sampleRate: 48_000 });
      void this.context.resume().catch(() => {});
    } catch {
      /* Report unsupported audio only if native voice actually starts. */
    }
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.failed = false;
      this.connect();
    } else this.disconnect();
  }

  private connect() {
    if (!this.visible || this.disposed || this.socket) return;
    const socket = new WebSocket(this.url, "hive-audio-v1");
    this.socket = socket;
    let retry = true;
    this.lastPong = Date.now();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 20_000) {
          socket.close();
          return;
        }
        this.send({ type: "ping" });
      }, 5000);
    };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket || typeof data !== "string" || data.length > 2048) return;
      let value: { type?: string; active?: boolean; pcm?: string; message?: string };
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
      if (value?.type === "ready" || value?.type === "pong") this.lastPong = Date.now();
      else if (value?.type === "active" && typeof value.active === "boolean") {
        if (this.nativeActive === value.active) return;
        this.nativeActive = value.active;
        if (value.active) void this.activate();
        else {
          this.releaseMedia();
          if (!this.failed) this.onStatus({ phase: "standby" });
        }
      } else if (value?.type === "speaker" && typeof value.pcm === "string" && this.worklet) {
        if (value.pcm.length > 1280) return;
        try {
          const bytes = Uint8Array.from(atob(value.pcm), (char) => char.charCodeAt(0));
          if (bytes.length <= 960 && bytes.length % 2 === 0)
            this.worklet.port.postMessage(bytes.buffer, [bytes.buffer]);
        } catch {
          /* Reject malformed media without retaining it. */
        }
      } else if (value?.type === "error") {
        retry = false;
        this.fail(value.message ?? "Terminal audio is unavailable.", false);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.heartbeat);
      if (this.nativeActive && !this.failed)
        this.onStatus({
          phase: "error",
          message: "Voice disconnected. Run /voice again after reconnecting.",
        });
      this.nativeActive = false;
      this.releaseMedia();
      if (retry && this.visible && !this.disposed)
        this.reconnect = setTimeout(() => this.connect(), 3000);
    };
    socket.onerror = () => {
      /* onclose handles recovery and media cleanup. */
    };
  }

  private async activate() {
    const generation = ++this.generation;
    const current = () =>
      !this.disposed && this.visible && this.nativeActive && generation === this.generation;
    try {
      if (microphoneOwner && microphoneOwner !== this)
        throw new Error("End voice in the other terminal before using /voice here.");
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !window.AudioWorkletNode
      )
        throw new Error("Voice needs HTTPS and a browser with microphone and Web Audio support.");
      microphoneOwner = this;
      // The same origin's tabs and installed PWA windows share this lock.
      if (navigator.locks) {
        const claimed = await new Promise<boolean>((resolve, reject) => {
          void navigator.locks
            .request("hive-terminal-microphone", { ifAvailable: true }, (lock) => {
              if (!lock || !current()) {
                resolve(false);
                return;
              }
              return new Promise<void>((release) => {
                this.releaseMicrophoneLock = release;
                resolve(true);
              });
            })
            .catch(reject);
        });
        if (!current()) return;
        if (!claimed)
          throw new Error("End voice in the other Hive tab or window before using /voice here.");
      }
      this.failed = false;
      this.onStatus({
        phase: "connecting",
        message: "Connecting voice… Allow microphone access when prompted.",
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (!current()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      for (const track of stream.getTracks())
        track.onended = () => this.fail("Microphone access ended. Run /voice again to reconnect.");
      this.context ??= new AudioContext({ sampleRate: 48_000 });
      const context = this.context;
      if (context.sampleRate !== 48_000)
        throw new Error("This browser does not support the voice audio format.");
      await context.audioWorklet.addModule("/hive-audio-worklet.js");
      if (!current()) return;
      // resume() can remain pending when playback lacks a user gesture.
      let resumeDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          context.resume(),
          new Promise<never>((_, reject) => {
            resumeDeadline = setTimeout(
              () =>
                reject(
                  new Error(
                    "Press Enter in the terminal to enable spoken replies, then run /voice again.",
                  ),
                ),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(resumeDeadline);
      }
      if (!current()) return;
      if (context.state !== "running")
        throw new Error(
          "Press Enter in the terminal to enable spoken replies, then run /voice again.",
        );
      const worklet = new AudioWorkletNode(context, "hive-terminal-audio", {
        outputChannelCount: [1],
      });
      this.worklet = worklet;
      worklet.port.onmessage = ({ data }) => {
        if (!current() || !(data instanceof ArrayBuffer) || data.byteLength !== 960) return;
        this.send({ type: "microphone", pcm: btoa(String.fromCharCode(...new Uint8Array(data))) });
      };
      worklet.onprocessorerror = () =>
        this.fail("Voice audio stopped. Run /voice again to reconnect.");
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(worklet);
      worklet.connect(context.destination);
      this.onStatus({ phase: "active", message: "Voice connected" });
    } catch (error) {
      if (!current()) return;
      this.fail(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in your browser, then run /voice again."
          : error instanceof Error
            ? error.message
            : "Could not connect voice audio.",
      );
    }
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 64 * 1024) {
      this.fail("Voice audio stalled. Run /voice again to reconnect.");
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private fail(message: string, retry = true) {
    this.failed = true;
    this.onStatus({ phase: "error", message });
    this.disconnect();
    // Permission denial ends native capture; later /voice attempts can retry.
    if (retry && this.visible && !this.disposed)
      this.reconnect = setTimeout(() => this.connect(), 3000);
  }

  private releaseMedia() {
    this.generation++;
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet.port.close();
    }
    this.worklet = null;
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
    if (microphoneOwner === this) microphoneOwner = null;
    this.releaseMicrophoneLock?.();
    this.releaseMicrophoneLock = null;
  }

  private disconnect() {
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "release" }));
    socket?.close();
    this.nativeActive = false;
    this.releaseMedia();
    if (!this.failed && !this.disposed) this.onStatus({ phase: "standby" });
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
  }
}
