/* Fixed 48 kHz mono PCM frames. Audio is buffered briefly and never recorded. */
class HiveTerminalAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capture = new Int16Array(480);
    this.captureAt = 0;
    this.playback = new Float32Array(4800);
    this.head = 0;
    this.count = 0;
    // Older open clients do not send focus controls. New clients send the
    // initial pause state before connecting their microphone and output.
    this.paused = false;
    this.playbackPaused = false;
    this.captureGeneration = null;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "pause" && typeof data.paused === "boolean") {
        this.paused = data.paused;
        this.playbackPaused = data.playbackPaused ?? data.paused;
        if (Number.isSafeInteger(data.generation) && data.generation > 0)
          this.captureGeneration = data.generation;
        this.captureAt = this.head = this.count = 0;
        return;
      }
      if (this.playbackPaused) return;
      if (!(data instanceof ArrayBuffer) || data.byteLength > 960 || data.byteLength % 2) return;
      const samples = new DataView(data);
      for (let i = 0; i < samples.byteLength; i += 2) {
        if (this.count === this.playback.length) {
          this.head = (this.head + 1) % this.playback.length;
          this.count--;
        }
        this.playback[(this.head + this.count++) % this.playback.length] =
          samples.getInt16(i, true) / 32768;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (this.paused && this.playbackPaused) {
      output.fill(0);
      return true;
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = this.count ? this.playback[this.head] : 0;
      if (this.count) {
        this.head = (this.head + 1) % this.playback.length;
        this.count--;
      }
      if (input && !this.paused) {
        this.capture[this.captureAt++] = Math.round(
          Math.max(-1, Math.min(1, input[i] ?? 0)) * 32767,
        );
        if (this.captureAt === this.capture.length) {
          // Encode explicitly so the wire format is independent of CPU endian.
          const packet = new ArrayBuffer(960);
          const samples = new DataView(packet);
          for (let j = 0; j < this.capture.length; j++)
            samples.setInt16(j * 2, this.capture[j], true);
          // Already-posted packets keep their creation generation while queued
          // on the main thread's MessagePort, even after these buffers reset.
          this.port.postMessage(
            this.captureGeneration === null
              ? packet
              : { pcm: packet, generation: this.captureGeneration },
            [packet],
          );
          this.captureAt = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("hive-terminal-audio", HiveTerminalAudio);
