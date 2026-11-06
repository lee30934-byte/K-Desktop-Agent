/** Two overlapping fractional delay taps. Fixed-size memory, no per-sample allocation. */
export class StreamingPitch {
  constructor(rate) {
    this.rate = rate;
    this.window = Math.max(128, Math.round(rate * 0.06));
    this.size = 2 ** Math.ceil(Math.log2(this.window + 512));
    this.mask = this.size - 1;
    this.buffer = new Float32Array(this.size);
    this.write = 0; this.phase = 0; this.ringPhase = 0;
  }
  read(delay) {
    const position = this.write - delay, index = Math.floor(position), fraction = position - index;
    return this.buffer[index & this.mask] * (1 - fraction) + this.buffer[(index + 1) & this.mask] * fraction;
  }
  process(input, output, semitones = 0, robot = 0, drive = 0) {
    const ratio = 2 ** (Math.min(4, Math.max(-4, semitones)) / 12);
    const step = (1 - ratio) / this.window;
    for (let i = 0; i < output.length; i++) {
      const raw = Number.isFinite(input?.[i]) ? input[i] : 0;
      this.buffer[this.write] = raw;
      let sample = raw;
      if (Math.abs(semitones) > 0.005) {
        const other = (this.phase + 0.5) % 1;
        const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase);
        sample = this.read(2 + this.phase * this.window) * weight + this.read(2 + other * this.window) * (1 - weight);
      }
      this.phase = (this.phase + step + 1) % 1;
      this.ringPhase = (this.ringPhase + 2 * Math.PI * 68 / this.rate) % (2 * Math.PI);
      sample *= 1 - robot + robot * Math.cos(this.ringPhase);
      if (drive > 0) sample = Math.tanh(sample * (1 + drive * 4)) / (1 + drive * 2);
      output[i] = Number.isFinite(sample) ? sample : 0;
      this.write = (this.write + 1) & this.mask;
    }
  }
}

// The export also allows the exact DSP to be tested outside an AudioWorklet.
if (typeof registerProcessor === 'function') {
  class VoicePitchProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'semitones', defaultValue: 0, minValue: -4, maxValue: 4, automationRate: 'k-rate' },
        { name: 'robot', defaultValue: 0, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
        { name: 'drive', defaultValue: 0, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
      ];
    }
    constructor() {
      super(); this.dsp = new StreamingPitch(sampleRate); this.closed = false;
      this.port.onmessage = e => { if (e.data === 'close') this.closed = true; };
    }
    process(inputs, outputs, parameters) {
      if (this.closed) return false;
      this.dsp.process(inputs[0]?.[0], outputs[0][0], parameters.semitones[0], parameters.robot[0], parameters.drive[0]);
      return true;
    }
  }
  registerProcessor('kda-voice-pitch', VoicePitchProcessor);
}
