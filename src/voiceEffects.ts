export const VOICE_EFFECT_PRESETS = [
  { id: 'natural', name: '원음', description: '선택한 목소리 그대로', semitones: 0, bass: 0, treble: 0, highpass: 20, lowpass: 20000, robot: 0, drive: 0 },
  { id: 'warm', name: '포근하게', description: '살짝 낮고 따뜻한 톤', semitones: -1, bass: 3, treble: -2, highpass: 50, lowpass: 11000, robot: 0, drive: 0 },
  { id: 'bright', name: '발랄하게', description: '가볍고 밝은 캐릭터 톤', semitones: 3, bass: -2, treble: 2, highpass: 100, lowpass: 15000, robot: 0, drive: 0 },
  { id: 'robot', name: '작은 로봇', description: '은은한 전자음이 섞인 톤', semitones: 1.5, bass: -1, treble: 1, highpass: 180, lowpass: 9000, robot: 0.32, drive: 0 },
  { id: 'deep', name: '차분하게', description: '낮고 묵직한 톤', semitones: -3, bass: 2, treble: -1, highpass: 45, lowpass: 10000, robot: 0, drive: 0 },
  { id: 'radio', name: '무전기', description: '좁은 대역의 통신 효과', semitones: 0, bass: 0, treble: 0, highpass: 450, lowpass: 3300, robot: 0, drive: 0.4 },
] as const;
export type VoiceEffectId = typeof VOICE_EFFECT_PRESETS[number]['id'];
export interface VoiceEffectPreference { preset: VoiceEffectId; strength: number }
export const DEFAULT_VOICE_EFFECT: VoiceEffectPreference = { preset: 'natural', strength: 0.6 };
export function voiceEffect(value: unknown): VoiceEffectPreference {
  const p = value && typeof value === 'object' ? value as Partial<VoiceEffectPreference> : {};
  return { preset: VOICE_EFFECT_PRESETS.some(v => v.id === p.preset) ? p.preset! : 'natural',
    strength: typeof p.strength === 'number' && Number.isFinite(p.strength) ? Math.min(1, Math.max(0, p.strength)) : DEFAULT_VOICE_EFFECT.strength };
}
export function effectEnabled(value: VoiceEffectPreference) { return value.preset !== 'natural' && value.strength > 0; }

/** A bounded local effect graph. No microphone, network service or feedback loop. */
export class VoiceEffectRack {
  readonly input: GainNode;
  readonly output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private highpass: BiquadFilterNode;
  private bass: BiquadFilterNode;
  private treble: BiquadFilterNode;
  private lowpass: BiquadFilterNode;
  private processor?: AudioWorkletNode;
  private loading?: Promise<void>;
  private closed = false;
  private version = 0;
  private broken = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private cancelLoad?: () => void;
  constructor(private context: AudioContext, private warning: (message: string) => void) {
    this.input = context.createGain(); this.output = context.createGain();
    this.dry = context.createGain(); this.wet = context.createGain(); this.wet.gain.value = 0;
    this.highpass = context.createBiquadFilter(); this.highpass.type = 'highpass'; this.highpass.Q.value = 0.7;
    this.bass = context.createBiquadFilter(); this.bass.type = 'lowshelf'; this.bass.frequency.value = 240;
    this.treble = context.createBiquadFilter(); this.treble.type = 'highshelf'; this.treble.frequency.value = 2600;
    this.lowpass = context.createBiquadFilter(); this.lowpass.type = 'lowpass'; this.lowpass.Q.value = 0.7;
    this.input.connect(this.dry).connect(this.output);
    this.highpass.connect(this.bass).connect(this.treble).connect(this.lowpass).connect(this.wet).connect(this.output);
  }
  private bypass() {
    this.dry.gain.setTargetAtTime(1, this.context.currentTime, 0.015);
    this.wet.gain.setTargetAtTime(0, this.context.currentTime, 0.015);
  }
  private load() {
    return this.loading ??= new Promise<void>((resolve, reject) => {
      if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') { reject(Error('AudioWorklet unavailable')); return; }
      // A packaged, same-origin asset works with the existing application CSP.
      const url = new URL('./audio/voicePitch.worklet.mjs', document.baseURI).href;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(this.timeout); this.cancelLoad = undefined; reject(error);
      };
      this.cancelLoad = () => fail(Error('AudioWorklet closed'));
      this.timeout = setTimeout(() => fail(Error('AudioWorklet load timeout')), 4000);
      void this.context.audioWorklet.addModule(url).then(() => {
        if (this.closed || settled) return;
        const node = this.processor = new AudioWorkletNode(this.context, 'kda-voice-pitch', {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
        });
        node.onprocessorerror = () => {
          if (this.closed) return;
          this.broken = true; this.bypass();
          this.warning('음성 효과가 멈춰 원음으로 전환했어요. 효과를 다시 사용하려면 통화를 다시 연결하세요.');
        };
        this.input.connect(node).connect(this.highpass);
        settled = true; clearTimeout(this.timeout); this.cancelLoad = undefined; resolve();
      }).catch(fail);
    });
  }
  async setEffect(value: VoiceEffectPreference) {
    const version = ++this.version, effect = voiceEffect(value);
    if (this.closed) return;
    if (!effectEnabled(effect)) { this.bypass(); this.warning(''); return; }
    try {
      await this.load();
      if (this.closed || version !== this.version) return;
      if (this.broken) throw Error('Processor unavailable');
      const p = VOICE_EFFECT_PRESETS.find(p => p.id === effect.preset)!;
      const strength = effect.strength, time = this.context.currentTime;
      for (const [key, number] of [['semitones', p.semitones * strength], ['robot', p.robot * strength], ['drive', p.drive * strength]] as const)
        this.processor!.parameters.get(key)!.setTargetAtTime(number, time, 0.025);
      this.bass.gain.setTargetAtTime(p.bass * strength, time, 0.025);
      this.treble.gain.setTargetAtTime(p.treble * strength, time, 0.025);
      this.highpass.frequency.setTargetAtTime(20 * Math.pow(p.highpass / 20, strength), time, 0.025);
      const ceiling = Math.min(20000, this.context.sampleRate * 0.45);
      this.lowpass.frequency.setTargetAtTime(ceiling * Math.pow(Math.min(p.lowpass, ceiling) / ceiling, strength), time, 0.025);
      this.wet.gain.setTargetAtTime(1, time, 0.015); this.dry.gain.setTargetAtTime(0, time, 0.015);
      this.warning('');
    } catch {
      if (this.closed || version !== this.version) return;
      this.bypass(); this.warning('음성 효과를 불러오지 못해 원음으로 재생하고 있어요. 통화는 유지돼요.');
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.version++; this.cancelLoad?.(); clearTimeout(this.timeout);
    if (this.processor) { this.processor.onprocessorerror = null; this.processor.port.postMessage('close'); this.processor.port.close(); this.processor.disconnect(); }
    for (const node of [this.input, this.output, this.dry, this.wet, this.highpass, this.bass, this.treble, this.lowpass]) node.disconnect();
  }
}
