import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
const out = process.env.KDA_EFFECT_EVIDENCE || 'evidence/voice-effects-20261106/audio-v1';
mkdirSync(`${out}/audio`, { recursive: true });
copyFileSync('public/audio/voicePitch.worklet.mjs', `${out}/audio/voicePitch.worklet.mjs`);
// Evidence-only fault injector, never copied into public/ or production output.
writeFileSync(`${out}/audio/failing-test-worklet.mjs`, `
  class DeliberateFailure extends AudioWorkletProcessor {
    static get parameterDescriptors(){return ['semitones','robot','drive'].map(name=>({name,defaultValue:0}));}
    process(){throw Error('deliberate isolated processor failure');}
  }
  registerProcessor('kda-voice-pitch',DeliberateFailure);
`);
await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  import * as outputModule from './src/voiceOutput';
  import * as effectsModule from './src/voiceEffects';
  import * as sessionModule from './src/voiceSession';
  window.outputModule=outputModule; window.effectsModule=effectsModule; window.sessionModule=sessionModule;
` }, bundle: true, format: 'iife', outfile: `${out}/output.js` });
writeFileSync(`${out}/output.html`, '<!doctype html><meta charset="utf-8"><title>Isolated KDA output graph verification</title><script src="output.js"></script>');
console.log(out);
