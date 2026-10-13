export type TerminalAudioStatus =
  | { phase: "standby" }
  | { phase: "request"; message: string; requestId: number }
  | { phase: "connecting" | "active" | "paused" | "error"; message: string };

const microphoneOwners = new Map<string, TerminalAudio>();

/** Native activity requests audio; only explicit browser approval starts capture. */
export class TerminalAudio {
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private visible = false;
  private disposed = false;
  private authorizing = false;
  private connectionAttempt = 0;
  private nativeActive = false;
  private generation = 0;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastPong = 0;
  private lastHeartbeat = 0;
  private frozen = false;
  private focused = false;
  private failed = false;
  private ownerRejected = false;
  private releaseMicrophoneLock: (() => void) | null = null;
  private pendingMicrophone = false;
  private ownsCall = false;
  private claimRequired = false;
  private cancelClaim: (() => void) | null = null;
  private confirmClaim: (() => void) | null = null;
  private updateClaimFocus: (() => void) | null = null;
  private pendingClaim = false;
  private claimRetry: ReturnType<typeof setTimeout> | undefined;
  private mediaPaused: boolean | undefined;
  private mediaFocus: boolean | undefined;
  private pendingPlayback: Record<string, unknown> | null = null;
  private playbackRetry: ReturnType<typeof setTimeout> | undefined;
  private mediaGeneration = 0;
  private generationSupported = false;
  private resumePending: {
    context: AudioContext;
    promise: Promise<void>;
    updateFocus: () => void;
    cancel: () => void;
    checkRunning: () => void;
  } | null = null;

  constructor(
    private url: string,
    private onStatus: (status: TerminalAudioStatus) => void,
    private canStart: () => boolean = () => true,
    private authorizeConnection?: (url: string) => Promise<string[]>,
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

  /** Approve the currently pending request from this terminal's Hive control. */
  approveMicrophone(requestId: number) {
    if (
      this.disposed ||
      requestId !== this.generation ||
      !this.nativeActive ||
      this.ownsCall ||
      this.pendingMicrophone ||
      this.ownerRejected ||
      !this.mediaFocused()
    )
      return;
    this.prime();
    void this.activate();
  }

  stopMicrophone() {
    if (this.disposed) return;
    this.failed = false;
    this.disconnect();
    this.refreshFocus();
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) this.failed = false;
    this.refreshFocus();
  }

  setFrozen(frozen: boolean) {
    this.frozen = frozen;
    if (!frozen) this.probeHeartbeat();
    this.refreshFocus();
  }

  /** Idle views yield their relay; owned calls stay connected and follow focus for media. */
  refreshFocus() {
    if (this.disposed) return;
    const focused = this.mediaFocused();
    if (focused && !this.focused && this.ownsCall) this.probeHeartbeat();
    this.focused = focused;
    this.updateMediaFocus();
    if (this.ownsCall || this.pendingMicrophone) return;
    if (focused) {
      this.connect();
      if (this.nativeActive && !this.failed) this.requestMicrophone();
    } else this.disconnect();
  }

  private mediaFocused() {
    return this.visible && !this.frozen && this.canStart();
  }

  private updateMediaFocus() {
    this.updateClaimFocus?.();
    this.resumePending?.updateFocus();
    const focused = this.mediaFocused();
    const paused = !focused || (this.context !== null && this.context.state !== "running");
    for (const track of this.stream?.getTracks() ?? []) track.enabled = !paused;
    if (!this.worklet) return;
    if (focused && this.context && this.context.state !== "running" && !this.resumePending) {
      const context = this.context;
      void this.resumeContext(context).then(
        () => {
          if (this.context === context) this.updateMediaFocus();
        },
        () => {
          if (this.context === context)
            this.onStatus({ phase: "error", message: "Press Enter in this pane to resume voice." });
        },
      );
    }
    if (this.mediaPaused === paused && this.mediaFocus === focused) return;
    this.mediaFocus = focused;
    if (this.mediaPaused !== paused) {
      this.mediaPaused = paused;
      this.mediaGeneration++;
      if (this.generationSupported)
        this.send({ type: "playback", enabled: !paused, generation: this.mediaGeneration });
      // Clear both audio buffers so resuming cannot replay speech from before pausing.
      this.worklet.port.postMessage({ type: "pause", paused, generation: this.mediaGeneration });
    }
    this.onStatus(
      paused
        ? focused
          ? { phase: "connecting", message: "Resuming voice…" }
          : { phase: "paused", message: "Voice paused — focus this pane to resume" }
        : { phase: "active", message: "Voice connected" },
    );
  }

  private probeHeartbeat() {
    this.lastPong = this.lastHeartbeat = Date.now();
    this.send({ type: "ping" });
  }

  private resumeContext(context: AudioContext): Promise<void> {
    if (this.resumePending?.context === context) return this.resumePending.promise;
    let resolve = () => {};
    let reject = (_error: Error) => {};
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let focused = false;
    let settled = false;
    let resumeAttempt = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (this.resumePending?.context === context) this.resumePending = null;
      if (error) reject(error);
      else resolve();
    };
    const checkRunning = () => {
      if (context.state === "running") finish();
    };
    const updateFocus = () => {
      if (settled) return;
      if (!this.mediaFocused()) {
        focused = false;
        resumeAttempt++;
        clearTimeout(deadline);
        deadline = undefined;
        // A running context needs no autoplay recovery while the pane is paused.
        checkRunning();
        return;
      }
      if (focused) return;
      focused = true;
      const attempt = ++resumeAttempt;
      deadline = setTimeout(() => {
        if (!this.mediaFocused()) {
          focused = false;
          deadline = undefined;
          return;
        }
        finish(
          new Error("Press Enter in the terminal to enable spoken replies, then run /voice again."),
        );
      }, 8000);
      void context.resume().then(
        () => {
          if (attempt === resumeAttempt) checkRunning();
        },
        (error) => {
          // Losing focus supersedes pending attempts, even if focus has since returned.
          if (attempt === resumeAttempt && this.mediaFocused())
            finish(error instanceof Error ? error : new Error("Could not resume voice audio."));
        },
      );
    };
    this.resumePending = { context, promise, updateFocus, cancel: () => finish(), checkRunning };
    updateFocus();
    return promise;
  }

  private async connect() {
    if (!this.mediaFocused() || this.disposed || this.socket || this.authorizing) return;
    clearTimeout(this.reconnect);
    let protocols: string | string[] = "hive-audio-v1";
    if (this.authorizeConnection) {
      const attempt = ++this.connectionAttempt;
      this.authorizing = true;
      try {
        protocols = await this.authorizeConnection(this.url);
      } catch {
        if (attempt !== this.connectionAttempt || this.disposed) return;
        this.authorizing = false;
        this.onStatus({ phase: "error", message: "Voice authentication unavailable." });
        if (this.mediaFocused()) this.reconnect = setTimeout(() => this.connect(), 3000);
        return;
      }
      if (attempt !== this.connectionAttempt || this.disposed) return;
      this.authorizing = false;
      if (!this.mediaFocused()) return;
    }
    const socket = new WebSocket(this.url, protocols);
    this.socket = socket;
    let retry = true;
    this.lastPong = Date.now();
    this.lastHeartbeat = Date.now();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.heartbeat = setInterval(() => {
        const now = Date.now();
        // A frozen page can run an overdue timer before queued pong events.
        if (now - this.lastHeartbeat > 10_000) this.lastPong = now;
        this.lastHeartbeat = now;
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
        playbackGeneration?: boolean;
        generation?: number;
      };
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
      if (value?.type === "ready" || value?.type === "pong") {
        this.lastPong = Date.now();
        if (value.type === "ready") {
          this.claimRequired = value.claimRequired === true;
          this.generationSupported = value.playbackGeneration === true;
        }
        if (value.type === "ready" && this.ownerRejected) {
          this.ownerRejected = false;
          this.failed = false;
          if (!this.nativeActive) this.onStatus({ phase: "standby" });
        }
      } else if (value?.type === "claimed") {
        this.confirmClaim?.();
      } else if (value?.type === "active" && typeof value.active === "boolean") {
        if (this.nativeActive === value.active) {
          if (!value.active) this.failed = false;
          return;
        }
        this.nativeActive = value.active;
        if (value.active) {
          this.requestMicrophone();
        } else {
          const preserveError = this.failed && !this.ownerRejected;
          this.releaseMedia();
          this.ownerRejected = this.failed = false;
          if (!preserveError) this.onStatus({ phase: "standby" });
          this.refreshFocus();
        }
      } else if (value?.type === "speaker" && typeof value.pcm === "string" && this.worklet) {
        if (
          !this.mediaFocused() ||
          this.mediaPaused ||
          value.pcm.length > 1280 ||
          (this.generationSupported && value.generation !== this.mediaGeneration)
        )
          return;
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
      const requested = this.nativeActive && !this.ownsCall && !this.failed;
      this.nativeActive = false;
      this.releaseMedia();
      if (requested) this.onStatus({ phase: "standby" });
      if (retry && this.visible && !this.disposed)
        this.reconnect = setTimeout(() => this.connect(), 3000);
    };
    socket.onerror = () => {
      /* onclose handles recovery and media cleanup. */
    };
  }

  private requestMicrophone() {
    if (this.pendingMicrophone) {
      this.fail("Finish the microphone permission request, then run /voice again.");
      return;
    }
    if (this.mediaFocused() && !this.ownsCall && !this.failed)
      this.onStatus({
        phase: "request",
        message: "This terminal is requesting microphone access.",
        requestId: this.generation,
      });
  }

  // Only approveMicrophone calls this, for one live request. No permission is
  // carried into the next capture, relay reconnect, or component instance.
  private async activate() {
    if (this.pendingMicrophone) {
      this.fail("Finish the microphone permission request, then run /voice again.");
      return;
    }
    const generation = ++this.generation;
    const current = () => !this.disposed && this.nativeActive && generation === this.generation;
    this.onStatus({ phase: "connecting", message: "Connecting voice…" });
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
          let deadline: ReturnType<typeof setTimeout> | undefined;
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            this.cancelClaim = this.confirmClaim = null;
            this.updateClaimFocus = null;
            if (error) reject(error);
            else resolve();
          };
          const updateFocus = () => {
            if (settled) return;
            if (!this.mediaFocused()) {
              clearTimeout(deadline);
              deadline = undefined;
              return;
            }
            if (deadline !== undefined) return;
            // On return, give queued claimed events a fresh deadline to dispatch.
            deadline = setTimeout(() => {
              if (!this.mediaFocused()) updateFocus();
              else finish(new Error("Voice ownership timed out. Run /voice again."));
            }, 8000);
          };
          this.cancelClaim = () => finish(new Error("Voice ended."));
          this.confirmClaim = () => finish();
          this.updateClaimFocus = updateFocus;
          updateFocus();
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
      this.updateMediaFocus();
      for (const track of stream.getTracks())
        track.onended = () => {
          if (current()) this.fail("Microphone access ended. Run /voice again to reconnect.");
        };
      this.context ??= new AudioContext({ sampleRate: 48_000 });
      const context = this.context;
      context.onstatechange = () => {
        if (this.context !== context) return;
        this.resumePending?.checkRunning();
        this.updateMediaFocus();
      };
      if (context.sampleRate !== 48_000)
        throw new Error("This browser does not support the voice audio format.");
      // A distinct URL prevents cached older worklets from using untagged capture.
      await context.audioWorklet.addModule("/hive-audio-worklet.js?capture-generation=1");
      if (!current()) return;
      await this.resumeContext(context);
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
          this.mediaPaused ||
          data?.generation !== this.mediaGeneration ||
          !(data?.pcm instanceof ArrayBuffer) ||
          data.pcm.byteLength !== 960
        )
          return;
        this.send({
          type: "microphone",
          pcm: btoa(String.fromCharCode(...new Uint8Array(data.pcm))),
        });
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
    if (message.type === "playback") {
      this.pendingPlayback = message;
      this.flushPlayback();
      return;
    }
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

  private flushPlayback() {
    clearTimeout(this.playbackRetry);
    this.playbackRetry = undefined;
    if (!this.pendingPlayback || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 64 * 1024 + 2048) {
      this.playbackRetry = setTimeout(() => this.flushPlayback(), 50);
      return;
    }
    this.socket.send(JSON.stringify(this.pendingPlayback));
    this.pendingPlayback = null;
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
    this.mediaFocus = undefined;
    this.pendingPlayback = null;
    clearTimeout(this.playbackRetry);
    this.playbackRetry = undefined;
    this.resumePending?.cancel();
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
      this.context.onstatechange = null;
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
    this.connectionAttempt++;
    this.authorizing = false;
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
