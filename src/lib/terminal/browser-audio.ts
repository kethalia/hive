export type TerminalAudioStatus =
  | { phase: "standby" }
  | { phase: "request"; message: string; requestId: number }
  | { phase: "connecting" | "active" | "paused" | "error"; message: string };

export type AudioDevicePhase = "disconnected" | "connecting" | "connected" | "paused";
export type TerminalAudioDevices = {
  microphone: AudioDevicePhase;
  speaker: AudioDevicePhase;
  playing: boolean;
  focused: boolean;
  microphoneMuted: boolean;
  speakerMuted: boolean;
  listeningHere: boolean;
};

// Native audio supplies PCM without reply boundaries; a quiet interval ends the exception.
const REPLY_SILENCE_MS = 2000;

const microphoneOwners = new Map<string, TerminalAudio>();

/** Native activity requests audio; only explicit browser approval starts capture. */
export class TerminalAudio {
  private microphoneMuted = false;
  private speakerStopped = false;
  private speakerMuted = false;
  private listeningHere = false;
  private listenTimer: ReturnType<typeof setTimeout> | undefined;
  private monitorPaused: boolean | undefined;
  private playbackPaused: boolean | undefined;
  private pageActive = true;
  private playing = false;
  private lastSound = 0;
  private soundTimer: ReturnType<typeof setTimeout> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private startDevice: "microphone" | "speaker" | null = null;
  private microphoneConnecting = false;
  private microphoneAttempt = 0;
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
    private onDevices?: (devices: TerminalAudioDevices) => void,
  ) {}

  private publishDevices() {
    const running = this.context?.state === "running" && !this.frozen && this.pageActive;
    this.onDevices?.({
      microphone: this.stream
        ? this.microphoneMuted || !this.mediaFocused() || !running
          ? "paused"
          : "connected"
        : this.microphoneConnecting || this.startDevice === "microphone"
          ? "connecting"
          : "disconnected",
      speaker: this.speakerStopped
        ? "disconnected"
        : this.worklet
          ? this.speakerMuted || (!this.mediaFocused() && !this.listeningHere) || !running
            ? "paused"
            : "connected"
          : (!this.worklet && this.ownsCall) || this.startDevice === "speaker"
            ? "connecting"
            : "disconnected",
      playing: this.playing,
      focused: this.mediaFocused(),
      microphoneMuted: this.microphoneMuted,
      speakerMuted: this.speakerMuted,
      listeningHere: this.listeningHere,
    });
  }

  /** A menu click approves one bounded start, canceled on focus loss or replacement. */
  connectDevice(device: "microphone" | "speaker", startNativeVoice: () => void) {
    if (this.disposed || !this.mediaFocused() || this.pendingMicrophone || this.startDevice) return;
    this.prime();
    if (device === "speaker") this.speakerStopped = false;
    if (this.worklet) {
      if (device === "speaker") {
        this.speakerStopped = this.speakerMuted = false;
        this.updateMediaFocus();
      } else if (!this.stream) void this.attachMicrophone(this.generation);
      return;
    }
    if (this.ownsCall) return;
    this.failed = this.ownerRejected = false;
    if (this.nativeActive) {
      void this.activate(device === "microphone");
      return;
    }
    this.startDevice = device;
    this.onStatus({ phase: "connecting", message: "Starting native voice…" });
    this.publishDevices();
    this.startTimer = setTimeout(() => {
      this.cancelStart();
      this.onStatus({
        phase: "error",
        message: "Voice did not start. Open Codex and check that its F8 voice shortcut is enabled.",
      });
    }, 8000);
    startNativeVoice();
  }

  private cancelStart() {
    clearTimeout(this.startTimer);
    this.startTimer = undefined;
    this.startDevice = null;
    this.publishDevices();
  }

  setPageActive(active: boolean) {
    if (this.disposed || this.pageActive === active) return;
    this.pageActive = active;
    this.refreshFocus();
  }

  toggleMicrophone() {
    if (!this.stream) return;
    this.microphoneMuted = !this.microphoneMuted;
    this.updateMediaFocus();
  }

  toggleSpeaker() {
    if (!this.worklet || this.speakerStopped) return;
    this.speakerMuted = !this.speakerMuted;
    this.updateMediaFocus();
  }

  stopSpeaker() {
    this.speakerStopped = true;
    this.updateMediaFocus();
    if (!this.stream && !this.pendingMicrophone && !this.microphoneConnecting)
      this.stopMicrophone();
  }

  /** Play this live reply without changing the selected pane or enabling its microphone. */
  listenToCurrentReply() {
    if (
      this.disposed ||
      !this.worklet ||
      !this.context ||
      !this.ownsCall ||
      !this.pageActive ||
      this.frozen ||
      this.speakerStopped ||
      this.speakerMuted ||
      Date.now() - this.lastSound >= REPLY_SILENCE_MS
    )
      return false;
    if (this.listeningHere) return true;
    this.listeningHere = true;
    const context = this.context;
    if (context.state !== "running") {
      void context.resume().then(
        () => {
          if (this.context === context) this.updateMediaFocus();
        },
        () => {
          if (this.context !== context) return;
          this.cancelListenHere();
          this.updateMediaFocus();
          this.onStatus({
            phase: "error",
            message: "Could not play this reply. Try listening again.",
          });
        },
      );
    }
    const check = () => {
      const remaining = REPLY_SILENCE_MS - (Date.now() - this.lastSound);
      if (remaining > 0) this.listenTimer = setTimeout(check, remaining);
      else {
        this.cancelListenHere();
        this.updateMediaFocus();
      }
    };
    this.listenTimer = setTimeout(check, REPLY_SILENCE_MS - (Date.now() - this.lastSound));
    this.updateMediaFocus();
    return true;
  }

  private cancelListenHere() {
    clearTimeout(this.listenTimer);
    this.listenTimer = undefined;
    this.listeningHere = false;
  }

  private clearSound() {
    clearTimeout(this.soundTimer);
    this.soundTimer = undefined;
    this.playing = false;
  }

  private markSound() {
    this.lastSound = Date.now();
    if (this.playing) return;
    this.playing = true;
    this.publishDevices();
    const check = () => {
      if (Date.now() - this.lastSound < 200) this.soundTimer = setTimeout(check, 200);
      else {
        this.clearSound();
        this.publishDevices();
      }
    };
    this.soundTimer = setTimeout(check, 200);
  }

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
    this.cancelStart();
    this.microphoneAttempt++;
    this.microphoneConnecting = false;
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    if (this.worklet && !this.speakerStopped) {
      this.updateMediaFocus();
      return;
    }
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
    if (!focused && this.startDevice) {
      this.cancelStart();
      this.onStatus({ phase: "standby" });
    }
    this.updateMediaFocus();
    if (this.ownsCall || this.pendingMicrophone) return;
    if (focused) {
      this.connect();
      if (this.nativeActive && !this.failed) this.requestMicrophone();
    } else this.disconnect();
  }

  private mediaFocused() {
    return this.visible && this.pageActive && !this.frozen && this.canStart();
  }

  private updateMediaFocus() {
    this.updateClaimFocus?.();
    this.resumePending?.updateFocus();
    const focused = this.mediaFocused();
    const suspended = this.context !== null && this.context.state !== "running";
    const paused = !focused || this.microphoneMuted || !this.stream || suspended;
    const monitorPaused =
      this.frozen || !this.pageActive || this.speakerStopped || this.speakerMuted || suspended;
    if (focused || this.frozen || !this.pageActive || this.speakerStopped || this.speakerMuted)
      this.cancelListenHere();
    const playbackPaused = (!focused && !this.listeningHere) || monitorPaused;
    this.publishDevices();
    for (const track of this.stream?.getTracks() ?? []) track.enabled = !paused;
    if (!this.worklet) return;
    if (
      this.pageActive &&
      !this.frozen &&
      this.context &&
      this.context.state !== "running" &&
      !this.resumePending
    ) {
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
    if (
      this.mediaPaused === paused &&
      this.mediaFocus === focused &&
      this.playbackPaused === playbackPaused &&
      this.monitorPaused === monitorPaused
    )
      return;
    this.mediaFocus = focused;
    if (
      this.mediaPaused !== paused ||
      this.playbackPaused !== playbackPaused ||
      this.monitorPaused !== monitorPaused
    ) {
      this.monitorPaused = monitorPaused;
      this.mediaPaused = paused;
      this.playbackPaused = playbackPaused;
      if (monitorPaused) {
        this.clearSound();
        this.publishDevices();
      }
      this.mediaGeneration++;
      if (this.generationSupported)
        this.send({ type: "playback", enabled: !monitorPaused, generation: this.mediaGeneration });
      // Clear both audio buffers so resuming cannot replay speech from before pausing.
      this.worklet.port.postMessage({
        type: "pause",
        paused,
        playbackPaused,
        generation: this.mediaGeneration,
      });
    }
    if (this.listeningHere && !focused) {
      this.onStatus({ phase: "active", message: "Listening to this reply here" });
      return;
    }
    this.onStatus(
      paused
        ? focused
          ? suspended
            ? { phase: "connecting", message: "Resuming voice…" }
            : { phase: "paused", message: this.stream ? "Microphone paused" : "Speakers connected" }
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
          const device = this.startDevice;
          this.cancelStart();
          if (device && this.mediaFocused()) void this.activate(device === "microphone");
          else this.requestMicrophone();
        } else {
          const preserveError = this.failed && !this.ownerRejected;
          this.releaseMedia();
          this.ownerRejected = this.failed = false;
          if (!preserveError) this.onStatus({ phase: "standby" });
          this.refreshFocus();
        }
      } else if (value?.type === "speaker" && typeof value.pcm === "string" && this.worklet) {
        if (
          this.frozen ||
          !this.pageActive ||
          this.speakerStopped ||
          this.speakerMuted ||
          value.pcm.length > 1280 ||
          (this.generationSupported && value.generation !== this.mediaGeneration)
        )
          return;
        try {
          const bytes = Uint8Array.from(atob(value.pcm), (char) => char.charCodeAt(0));
          if (bytes.length <= 960 && bytes.length % 2 === 0) {
            const samples = new DataView(bytes.buffer);
            for (let at = 0; at < bytes.length; at += 2) {
              if (Math.abs(samples.getInt16(at, true)) > 256) {
                this.markSound();
                break;
              }
            }
            if (!this.playbackPaused && (this.mediaFocused() || this.listeningHere))
              this.worklet.port.postMessage(bytes.buffer, [bytes.buffer]);
          }
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

  // Explicit approval or a bounded menu start owns exactly one native call.
  private async activate(microphone = true) {
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
        (microphone && !navigator.mediaDevices?.getUserMedia) ||
        !window.AudioWorkletNode
      )
        throw new Error("Voice needs HTTPS and a browser with microphone and Web Audio support.");
      this.speakerStopped = this.speakerMuted = this.microphoneMuted = false;
      this.ownsCall = true;
      this.microphoneConnecting = microphone;
      this.publishDevices();
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
      this.microphoneConnecting = microphone;
      this.publishDevices();
      this.onStatus({ phase: "connecting", message: "Connecting voice…" });
      if (microphone) await this.attachMicrophone(generation);
      if (!current()) return;
      this.context ??= new AudioContext({ sampleRate: 48_000 });
      const context = this.context;
      context.onstatechange = () => {
        if (this.context !== context) return;
        this.resumePending?.checkRunning();
        this.updateMediaFocus();
      };
      if (context.sampleRate !== 48_000)
        throw new Error("This browser does not support the voice audio format.");
      await context.audioWorklet.addModule("/hive-audio-worklet.js?independent-devices=2");
      if (!current()) return;
      await this.resumeContext(context);
      if (!current()) return;
      if (context.state !== "running") throw new Error("Click Connect to enable spoken replies.");
      const worklet = new AudioWorkletNode(context, "hive-terminal-audio", {
        outputChannelCount: [1],
      });
      this.worklet = worklet;
      worklet.port.onmessage = ({ data }) => {
        if (
          !current() ||
          !this.mediaFocused() ||
          this.mediaPaused ||
          !this.stream ||
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
        if (current()) this.fail("Voice audio stopped. Connect again to retry.");
      };
      if (this.stream) {
        this.source = context.createMediaStreamSource(this.stream);
        this.source.connect(worklet);
      }
      this.updateMediaFocus();
      worklet.connect(context.destination);
    } catch (error) {
      if (!current()) return;
      this.fail(error instanceof Error ? error.message : "Could not connect voice audio.");
    }
  }

  private async attachMicrophone(generation: number) {
    if (this.pendingMicrophone || this.stream || !this.mediaFocused()) return;
    const attempt = ++this.microphoneAttempt;
    const current = () =>
      !this.disposed &&
      this.ownsCall &&
      generation === this.generation &&
      attempt === this.microphoneAttempt;
    this.microphoneConnecting = true;
    this.publishDevices();
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Microphone access is unavailable in this browser.");
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
          if (!this.ownsCall || generation !== this.generation) this.releaseOwnership();
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
          if (!current()) return;
          const message = "Microphone access ended. Connect the microphone again to retry.";
          if (this.worklet && !this.speakerStopped) {
            this.stopMicrophone();
            this.onStatus({ phase: "error", message });
          } else this.fail(message);
        };
      this.microphoneMuted = false;
      if (this.context && this.worklet) {
        this.source = this.context.createMediaStreamSource(stream);
        this.source.connect(this.worklet);
      }
      this.microphoneConnecting = false;
      this.updateMediaFocus();
    } catch (error) {
      if (!current()) return;
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in your browser, then run /voice again."
          : error instanceof Error
            ? error.message
            : "Could not connect voice audio.";
      this.microphoneConnecting = false;
      if (this.worklet) {
        this.stopMicrophone();
        this.onStatus({ phase: "error", message });
      } else this.fail(message);
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
    this.cancelStart();
    this.clearSound();
    this.cancelListenHere();
    this.generation++;
    this.microphoneConnecting = false;
    this.ownsCall = false;
    this.mediaPaused = undefined;
    this.playbackPaused = undefined;
    this.monitorPaused = undefined;
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
    this.publishDevices();
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
