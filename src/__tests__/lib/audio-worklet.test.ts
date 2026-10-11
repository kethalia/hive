// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function processor() {
  let Processor: new () => {
    port: { onmessage: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  };
  runInNewContext(readFileSync("public/hive-audio-worklet.js", "utf8"), {
    ArrayBuffer,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: vi.fn() };
    },
    registerProcessor: (_name: string, implementation: typeof Processor) => {
      Processor = implementation;
    },
  });
  return new Processor!();
}

describe("terminal audio focus pausing", () => {
  it("silences capture and playback while paused and discards old samples on resume", () => {
    const audio = processor();
    const speaker = new Int16Array(480).fill(8192).buffer;
    const tick = () => {
      const output = new Float32Array(128).fill(1);
      expect(audio.process([[new Float32Array(128).fill(0.5)]], [[output]])).toBe(true);
      return output;
    };
    const pause = (paused: boolean) => audio.port.onmessage({ data: { type: "pause", paused } });
    pause(true);
    audio.port.onmessage({ data: speaker });
    expect(tick().every((value) => value === 0)).toBe(true);
    expect(audio.port.postMessage).not.toHaveBeenCalled();
    pause(false);
    audio.port.onmessage({ data: speaker });
    expect(tick()[0]).toBe(0.25);
    // The worklet now holds both queued playback and a partial capture packet.
    pause(true);
    audio.port.onmessage({ data: speaker });
    for (let at = 0; at < 8; at++) expect(tick().every((value) => value === 0)).toBe(true);
    expect(audio.port.postMessage).not.toHaveBeenCalled();
    pause(false);
    for (let at = 0; at < 3; at++) expect(tick().every((value) => value === 0)).toBe(true);
    expect(audio.port.postMessage).not.toHaveBeenCalled();
    tick();
    const [packet] = audio.port.postMessage.mock.calls[0];
    expect(packet.byteLength).toBe(960);
    expect(new Int16Array(packet).every((value) => value === 16384)).toBe(true);
    audio.port.onmessage({ data: speaker });
    expect(tick()[0]).toBe(0.25);
  });
});
