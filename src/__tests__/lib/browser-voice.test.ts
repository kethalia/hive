// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserVoice } from "@/lib/codex/browser-voice";

let current: BrowserVoice;
let microphone: { getTracks: () => unknown[]; getAudioTracks: () => unknown[] };
let track: { stop: ReturnType<typeof vi.fn>; enabled: boolean; onended: unknown };
let getUserMedia: ReturnType<typeof vi.fn>;
let peers: FakePeer[];
class FakePeer {
  localDescription = { sdp: "v=0\r\nm=audio" };
  connectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  ontrack: unknown;
  close = vi.fn();
  addTrack = vi.fn();
  createDataChannel = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "offer" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  constructor() {
    peers.push(this);
  }
}

beforeEach(() => {
  peers = [];
  track = { stop: vi.fn(), enabled: true, onended: null };
  microphone = { getTracks: () => [track], getAudioTracks: () => [track] };
  getUserMedia = vi.fn().mockResolvedValue(microphone);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      play = vi.fn().mockResolvedValue(undefined);
      srcObject = null;
      autoplay = false;
    },
  );
});
afterEach(() => {
  current?.stop();
  vi.unstubAllGlobals();
});

describe("browser voice resource ownership", () => {
  it("stops a late microphone permission grant after the user cancels", async () => {
    let grant: (value: unknown) => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    current = new BrowserVoice(vi.fn(), vi.fn());
    const started = current.start("workspace", "thread");
    current.stop();
    grant(microphone);
    await started;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peers).toHaveLength(0);
  });

  it("releases microphone and peer when signaling fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const error = vi.fn();
    current = new BrowserVoice(vi.fn(), error);
    await current.start("workspace", "thread");
    expect(error).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peers[0].close).toHaveBeenCalledOnce();
  });

  it("mutes locally and releases resources on signaling EOF", async () => {
    let close: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            close = () => controller.close();
          },
        }),
      }),
    );
    current = new BrowserVoice(vi.fn(), vi.fn());
    const started = current.start("workspace", "thread");
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    current.mute(true);
    expect(track.enabled).toBe(false);
    current.mute(false);
    expect(track.enabled).toBe(true);
    close();
    await started;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peers[0].close).toHaveBeenCalledOnce();
  });

  it("prevents two panes from opening microphones at once", async () => {
    getUserMedia.mockReturnValue(new Promise(() => {}));
    current = new BrowserVoice(vi.fn(), vi.fn());
    void current.start("workspace", "thread");
    const error = vi.fn();
    const second = new BrowserVoice(vi.fn(), error);
    await second.start("workspace", "other");
    expect(error).toHaveBeenCalledWith("End the other Hive voice call first.");
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});
