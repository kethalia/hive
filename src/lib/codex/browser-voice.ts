export type VoiceState = "connecting" | "connected" | "ended";
let activeVoice: BrowserVoice | null = null;

/** Own all browser media resources, including permission grants arriving after Stop. */
export class BrowserVoice {
  private abort = new AbortController();
  private peer: RTCPeerConnection | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private stopped = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private signalingTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private onState: (state: VoiceState) => void,
    private onError: (message: string) => void,
  ) {}

  async start(workspaceId: string, threadId: string) {
    try {
      if (activeVoice && activeVoice !== this)
        throw new Error("End the other Hive voice call first.");
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !window.RTCPeerConnection
      ) {
        throw new Error("Voice needs HTTPS and a browser with microphone and WebRTC support.");
      }
      activeVoice = this;
      this.onState("connecting");
      this.timeout = setTimeout(() => this.fail("Voice connection timed out. Try again."), 45_000);
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (this.stopped) {
        for (const track of microphone.getTracks()) track.stop();
        return;
      }
      this.microphone = microphone;
      for (const track of microphone.getTracks()) track.onended = () => this.stop();
      const peer = new RTCPeerConnection();
      this.peer = peer;
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      peer.ontrack = ({ track, streams }) => {
        if (this.stopped) return;
        audio.srcObject = streams[0] ?? new MediaStream([track]);
        void audio
          .play()
          .catch(() =>
            this.fail("Your browser blocked spoken replies. Allow audio playback and try again."),
          );
      };
      peer.onconnectionstatechange = () => {
        if (this.stopped) return;
        if (peer.connectionState === "connected") {
          clearTimeout(this.timeout);
          this.onState("connected");
        } else if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          this.fail("Voice disconnected. Start again to reconnect.");
        }
      };
      for (const track of microphone.getTracks()) peer.addTrack(track, microphone);
      // Codex negotiates the Realtime events channel along with audio.
      peer.createDataChannel("oai-events");
      await peer.setLocalDescription(await peer.createOffer());
      if (this.stopped) return;
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, sdp: peer.localDescription?.sdp }),
        signal: this.abort.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "The voice prototype is disabled on this Hive server."
            : "Could not start Codex voice. Check the workspace session and voice availability.",
        );
      if (!response.body) throw new Error("Voice signaling is unavailable.");
      const receivedSignal = () => {
        clearTimeout(this.signalingTimeout);
        this.signalingTimeout = setTimeout(
          () => this.fail("Voice signaling stopped responding. Start again to reconnect."),
          25_000,
        );
      };
      receivedSignal();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        receivedSignal();
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 128 * 1024) throw new Error("Invalid voice signaling response.");
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const event = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (event.type === "sdp" && typeof event.sdp === "string") {
            await peer.setRemoteDescription({ type: "answer", sdp: event.sdp });
          } else if (event.type === "error") {
            throw new Error(
              typeof event.message === "string" ? event.message : "Codex voice failed.",
            );
          } else if (event.type === "closed") {
            this.stop();
            return;
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (!this.stopped) this.fail("Voice signaling disconnected. Start again to reconnect.");
    } catch (error) {
      if (this.stopped) return;
      this.fail(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in your browser and try again."
          : error instanceof Error
            ? error.message
            : "Could not start voice.",
      );
    }
  }

  mute(muted: boolean) {
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  private fail(message: string) {
    this.onError(message);
    this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timeout);
    clearTimeout(this.signalingTimeout);
    this.abort.abort();
    for (const track of this.microphone?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    if (this.peer) {
      this.peer.onconnectionstatechange = null;
      this.peer.ontrack = null;
      this.peer.close();
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    if (activeVoice === this) activeVoice = null;
    this.onState("ended");
  }
}
