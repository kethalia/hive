export type TerminalAudioStatus =
  | { phase: "standby" }
  | { phase: "connecting" | "active" | "paused" | "error"; message: string };

const microphoneOwners = new Map<string, TerminalAudio>();

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
  private ownerRejected = false;
  private releaseMicrophoneLock: (() => void) | null = null;
  private pendingMicrophone = false;
  private ownsCall = false;
  private claimRequired = false;
  private cancelClaim: (() => void) | null = null;
  private confirmClaim: (() => void) | null = null;
  private pendingClaim = false;
  private claimRetry: ReturnType<typeof setTimeout> | undefined;
  private mediaPaused: boolean | undefined;

  constructor(
    private url: string,
    private onStatus: (status: TerminalAudioStatus) => void,
    private canStart: () => boolean = () => true,
    // A single-use interaction arm is consumed at the first activation attempt.
    private canClaim: () => boolean = canStart,
  ) {}

  /** Called synchronously from Enter so playback can use the browser's user activation. */
  prime() {
    if (!this.visible || this.disposed || !window.AudioContext) return;
    try {
      this.context ??= new AudioContext({ sampleRate: 48_000 });
      void this.context.resume().catch(() => {});
      if (this.nativeActive) {
        // Enter used during an owned call (including /voice stop) must not arm
        // this observer to claim the next call started on a different device.
        if (this.ownsCall && this.claimRequired) this.canClaim();
        else if (!this.ownsCall) void this.activate();
      }
    } catch {
      /* Report unsupported audio only if native voice actually starts. */
    }
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) this.failed = false;
    this.refreshFocus();
  }

  /** Idle views yield their relay; owned calls stay connected and follow focus for media. */
  refreshFocus() {
    if (this.disposed) return;
    this.updateMediaFocus();
    if (this.ownsCall || this.pendingMicrophone) return;
    if (this.visible && this.canStart()) this.connect();
    else this.disconnect();
  }

  private mediaFocused() {
    return this.visible && this.canStart();
  }

  private updateMediaFocus() {
    if (!this.worklet) return;
    const paused = !this.mediaFocused();
    for (const track of this.stream?.getTracks() ?? []) track.enabled = !paused;
    if (this.mediaPaused === paused) return;
    this.mediaPaused = paused;
    // Clear both audio buffers so resuming cannot replay speech from before pausing.
    this.worklet.port.postMessage({ type: "pause", paused });
    this.onStatus(
      paused
        ? { phase: "paused", message: "Voice paused — focus this pane to resume" }
        : { phase: "active", message: "Voice connected" },
    );
  }

  private connect() {
    if (!this.visible || this.disposed || this.socket || !this.canStart()) return;
    clearTimeout(this.reconnect);
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
      let value: {
        type?: string;
        active?: boolean;
        pcm?: string;
        message?: string;
        code?: string;
        claimRequired?: boolean;
      };
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
      if (value?.type === "ready" || value?.type === "pong") {
        this.lastPong = Date.now();
        if (value.type === "ready") this.claimRequired = value.claimRequired === true;
        if (value.type === "ready" && this.ownerRejected) {
          this.ownerRejected = false;
          this.failed = false;
          if (!this.nativeActive) this.onStatus({ phase: "standby" });
        }
      } else if (value?.type === "claimed") {
        this.confirmClaim?.();
      } else if (value?.type === "active" && typeof value.active === "boolean") {
        if (this.nativeActive === value.active) return;
        this.nativeActive = value.active;
        if (value.active) void this.activate();
        else {
          this.releaseMedia();
          if (this.claimRequired && this.ownerRejected) {
            this.ownerRejected = false;
            this.failed = false;
          }
          if (!this.failed) this.onStatus({ phase: "standby" });
          this.refreshFocus();
        }
      } else if (value?.type === "speaker" && typeof value.pcm === "string" && this.worklet) {
        if (!this.mediaFocused() || value.pcm.length > 1280) return;
        try {
          const bytes = Uint8Array.from(atob(value.pcm), (char) => char.charCodeAt(0));
          if (bytes.length <= 960 && bytes.length % 2 === 0)
            this.worklet.port.postMessage(bytes.buffer, [bytes.buffer]);
        } catch {
          /* Reject malformed media without retaining it. */
        }
      } else if (value?.type === "error") {
        if (this.claimRequired && value.code === "session_busy") {
          // Keep watching the existing call instead of repeatedly reconnecting
          // and flashing its ownership warning. An observer never stops its owner.
          this.failed = this.ownerRejected = true;
          this.releaseMedia();
          this.onStatus({
            phase: "error",
            message: value.message ?? "This terminal's voice call is in use.",
          });
          return;
        }
        retry = value.code === "session_busy";
        this.fail(value.message ?? "Terminal audio is unavailable.", retry, value.code);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.heartbeat);
      if (this.ownsCall && !this.failed)
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
    // A view left open on another device must not answer native activity merely
    // because that browser still reports focus. Enter arms a new call briefly.
    if (this.claimRequired && !this.canClaim()) return;
    if (this.pendingMicrophone) {
      this.fail("Finish the microphone permission request, then run /voice again.");
      return;
    }
    const generation = ++this.generation;
    const current = () => !this.disposed && this.nativeActive && generation === this.generation;
    try {
      // Focus chooses a new call. Later focus changes pause media, not ownership.
      if (!this.mediaFocused())
        throw new Error("Select this terminal and run /voice again to start voice.");
      const owner = microphoneOwners.get(this.url);
      if (owner && owner !== this)
        throw new Error("Voice is already connected in another view of this terminal.");
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !window.AudioWorkletNode
      )
        throw new Error("Voice needs HTTPS and a browser with microphone and Web Audio support.");
      this.ownsCall = true;
      microphoneOwners.set(this.url, this);
      // The same origin's tabs and installed PWA windows share this lock.
      if (navigator.locks) {
        const claimed = await new Promise<boolean>((resolve, reject) => {
          void navigator.locks
            .request(`hive-terminal-microphone:${this.url}`, { ifAvailable: true }, (lock) => {
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
          throw new Error(
            "Voice for this terminal is already connected in another Hive tab or window.",
          );
      }
      if (this.claimRequired) {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(deadline);
            this.cancelClaim = this.confirmClaim = null;
            if (error) reject(error);
            else resolve();
          };
          const deadline = setTimeout(
            () => finish(new Error("Voice ownership timed out. Run /voice again.")),
            8000,
          );
          this.cancelClaim = () => finish(new Error("Voice ended."));
          this.confirmClaim = () => finish();
          this.send({ type: "claim" });
        });
        if (!current()) return;
      }
      this.failed = false;
      this.onStatus({
        phase: "connecting",
        message: "Connecting voice… Allow microphone access when prompted.",
      });
      this.pendingMicrophone = true;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      } finally {
        this.pendingMicrophone = false;
        // getUserMedia cannot be canceled. Keep its reservation until it settles,
        // even when the terminal was hidden or native capture ended meanwhile.
        if (!current()) {
          this.releaseOwnership();
          this.refreshFocus();
        }
      }
      if (!current()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      for (const track of stream.getTracks())
        track.onended = () => {
          if (current()) this.fail("Microphone access ended. Run /voice again to reconnect.");
        };
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
        if (
          !current() ||
          !this.mediaFocused() ||
          !(data instanceof ArrayBuffer) ||
          data.byteLength !== 960
        )
          return;
        this.send({ type: "microphone", pcm: btoa(String.fromCharCode(...new Uint8Array(data))) });
      };
      worklet.onprocessorerror = () => {
        if (current()) this.fail("Voice audio stopped. Run /voice again to reconnect.");
      };
      this.source = context.createMediaStreamSource(stream);
      this.updateMediaFocus();
      this.source.connect(worklet);
      worklet.connect(context.destination);
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
    if (message.type === "claim") {
      this.pendingClaim = true;
      this.flushClaim();
      return;
    }
    if (this.socket.bufferedAmount > 64 * 1024) {
      // Late PCM is disposable. Keep the call and a bounded allowance for
      // heartbeats; the existing liveness timeout detects a persistent outage.
      if (message.type === "microphone" || this.socket.bufferedAmount > 64 * 1024 + 2048) return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private flushClaim() {
    clearTimeout(this.claimRetry);
    this.claimRetry = undefined;
    if (!this.pendingClaim || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 64 * 1024 + 2048) {
      this.claimRetry = setTimeout(() => this.flushClaim(), 50);
      return;
    }
    this.pendingClaim = false;
    this.socket.send(JSON.stringify({ type: "claim" }));
  }

  private fail(message: string, retry = true, code?: string) {
    this.failed = true;
    this.ownerRejected = code === "session_busy";
    this.onStatus({ phase: "error", message });
    this.disconnect();
    // Permission denial ends native capture; later /voice attempts can retry.
    if (retry && this.visible && !this.disposed)
      this.reconnect = setTimeout(() => this.connect(), 3000);
  }

  private releaseMedia() {
    this.generation++;
    this.ownsCall = false;
    this.mediaPaused = undefined;
    this.pendingClaim = false;
    clearTimeout(this.claimRetry);
    this.claimRetry = undefined;
    this.cancelClaim?.();
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    if (this.worklet) {
      this.worklet.onprocessorerror = null;
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet.port.close();
    }
    this.worklet = null;
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
    this.releaseOwnership();
  }

  private releaseOwnership() {
    if (this.pendingMicrophone) return;
    if (microphoneOwners.get(this.url) === this) microphoneOwners.delete(this.url);
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
