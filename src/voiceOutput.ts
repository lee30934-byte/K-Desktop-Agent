import { rmsToLevel } from './voiceLevel';
import { VoiceEffectRack, voiceEffect, effectEnabled, DEFAULT_VOICE_EFFECT, type VoiceEffectPreference } from './voiceEffects';

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
  private analyser: AnalyserNode;
  private samples: Float32Array<ArrayBuffer>;
  private source?: MediaStreamAudioSourceNode;
  private sourcePlayback?: HTMLAudioElement;
  private effects?: VoiceEffectRack;
  private closed = false;
  constructor(value: number, effect = DEFAULT_VOICE_EFFECT, private warning: (message: string) => void = () => {}) {
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
    // Side tap for the avatar's mouth; it is not connected to any output.
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0;
    this.limiter.connect(this.analyser);
    this.samples = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.gain.gain.value = voiceGain(value);
    void this.setEffect(effect);
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
    this.source.connect(this.effects?.input ?? this.gain);
    return this.destination.stream;
  }
  /** Current output loudness 0..1 (after gain/effects), for lip-sync only. */
  level() {
    if (this.closed) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
    return rmsToLevel(Math.sqrt(sum / this.samples.length));
  }
  setGain(value: number) {
    this.gain.gain.setTargetAtTime(voiceGain(value), this.context.currentTime, 0.02);
  }
  async setEffect(value: VoiceEffectPreference) {
    if (this.closed) return;
    const effect = voiceEffect(value);
    if (!this.effects && !effectEnabled(effect)) { this.warning(''); return; }
    if (!this.effects && effectEnabled(effect)) {
      try {
        this.effects = new VoiceEffectRack(this.context, this.warning);
        this.effects.output.connect(this.gain);
        this.source?.disconnect(); this.source?.connect(this.effects.input);
      } catch { this.warning('음성 효과 초기화에 실패해 원음으로 재생하고 있어요.'); return; }
    }
    await this.effects?.setEffect(effect);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.effects?.close();
    if (this.sourcePlayback) { this.sourcePlayback.pause(); this.sourcePlayback.srcObject = null; this.sourcePlayback = undefined; }
    this.source?.disconnect(); this.gain.disconnect(); this.limiter.disconnect(); this.analyser.disconnect();
    this.destination.stream.getTracks().forEach(track => track.stop());
    void this.context.close().catch(() => {});
  }
}
