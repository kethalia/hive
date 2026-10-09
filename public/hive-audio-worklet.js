/* Fixed 48 kHz mono PCM frames. Audio is buffered briefly and never recorded. */
class HiveTerminalAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capture = new Int16Array(480);
    this.captureAt = 0;
    this.playback = new Float32Array(4800);
    this.head = 0;
    this.count = 0;
    this.port.onmessage = ({ data }) => {
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
    for (let i = 0; i < output.length; i++) {
      output[i] = this.count ? this.playback[this.head] : 0;
      if (this.count) {
        this.head = (this.head + 1) % this.playback.length;
        this.count--;
      }
      if (input) {
        this.capture[this.captureAt++] = Math.round(
          Math.max(-1, Math.min(1, input[i] ?? 0)) * 32767,
        );
        if (this.captureAt === this.capture.length) {
          // Encode explicitly so the wire format is independent of CPU endian.
          const packet = new ArrayBuffer(960);
          const samples = new DataView(packet);
          for (let j = 0; j < this.capture.length; j++)
            samples.setInt16(j * 2, this.capture[j], true);
          this.port.postMessage(packet, [packet]);
          this.captureAt = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("hive-terminal-audio", HiveTerminalAudio);
