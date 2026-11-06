export const VOICE_OUTPUT_KEY = 'kda_voice_output_gain';
export const DEFAULT_VOICE_GAIN = 1.5;
export const MAX_VOICE_GAIN = 5;
export function voiceGain(value: number) {
  return Number.isFinite(value) ? Math.min(MAX_VOICE_GAIN, Math.max(0, value)) : DEFAULT_VOICE_GAIN;
}
export function readVoiceGain() {
  try {
    const saved = localStorage.getItem(VOICE_OUTPUT_KEY);
    return saved === null ? DEFAULT_VOICE_GAIN : voiceGain(Number(saved));
  } catch { return DEFAULT_VOICE_GAIN; }
}

/** Only the received call stream enters this graph. Microphone and OS mixer stay untouched. */
export class VoiceOutput {
  private context: AudioContext;
  private gain: GainNode;
  private limiter: DynamicsCompressorNode;
  private destination: MediaStreamAudioDestinationNode;
  private source?: MediaStreamAudioSourceNode;
  private sourcePlayback?: HTMLAudioElement;
  constructor(value: number) {
    const ctx = this.context = new AudioContext();
    this.gain = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.destination = ctx.createMediaStreamDestination();
    this.gain.connect(this.limiter).connect(this.destination);
    this.gain.gain.value = voiceGain(value);
  }
  async resume() {
    // Chromium needs a media element consumer to decode a received WebRTC track.
    // The source consumer is silent; the amplified destination is the only output.
    await this.sourcePlayback?.play();
    await this.context.resume();
  }
  attach(stream: MediaStream) {
    if (this.sourcePlayback) { this.sourcePlayback.pause(); this.sourcePlayback.srcObject = null; }
    this.source?.disconnect();
    const playback = this.sourcePlayback = new Audio();
    playback.volume = 0;
    playback.srcObject = stream;
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.gain);
    return this.destination.stream;
  }
  setGain(value: number) {
    this.gain.gain.setTargetAtTime(voiceGain(value), this.context.currentTime, 0.02);
  }
  close() {
    if (this.sourcePlayback) { this.sourcePlayback.pause(); this.sourcePlayback.srcObject = null; this.sourcePlayback = undefined; }
    this.source?.disconnect(); this.gain.disconnect(); this.limiter.disconnect();
    this.destination.stream.getTracks().forEach(track => track.stop());
    void this.context.close().catch(() => {});
  }
}
