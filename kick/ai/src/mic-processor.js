class MicrophoneProcessor extends AudioWorkletProcessor {
  frames = [];
  length = 0;

  process(inputs) {
    const audio = inputs[0]?.[0];
    if (!audio) return true;
    this.frames.push(audio.slice());
    this.length += audio.length;
    if (this.length >= 1600) {
      const samples = new Float32Array(this.length);
      let offset = 0;
      for (const frame of this.frames) {
        samples.set(frame, offset);
        offset += frame.length;
      }
      this.port.postMessage(samples, [samples.buffer]);
      this.frames = [];
      this.length = 0;
    }
    return true;
  }
}

registerProcessor('microphone-frames', MicrophoneProcessor);
