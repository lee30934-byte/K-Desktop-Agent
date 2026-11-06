import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceEffect, effectEnabled } from '../src/voiceEffects.ts';
// @ts-ignore The standalone processor is packaged JavaScript.
import { StreamingPitch } from '../public/audio/voicePitch.worklet.mjs';

test('old or invalid preferences keep the original voice; strength is finite and bounded', () => {
  for (const value of [null, undefined, 'robot', { preset: 'unknown' }, []])
    assert.equal(effectEnabled(voiceEffect(value)), false);
  assert.deepEqual(voiceEffect({ preset: 'robot', strength: NaN }), { preset: 'robot', strength: 0.6 });
  assert.equal(voiceEffect({ preset: 'bright', strength: 9 }).strength, 1);
  assert.equal(effectEnabled(voiceEffect({ preset: 'robot', strength: -9 })), false);
});

function tone(semitones: number, rate = 48000) {
  const dsp = new StreamingPitch(rate), length = rate, result = new Float32Array(length);
  for (let offset = 0; offset < length; offset += 128) {
    const count = Math.min(128, length - offset), input = new Float32Array(count), output = new Float32Array(count);
    for (let i = 0; i < count; i++) input[i] = 0.1 * Math.sin(2 * Math.PI * 220 * (offset + i) / rate);
    dsp.process(input, output, semitones); result.set(output, offset);
  }
  return result;
}
function peak(samples: Float32Array, rate: number) {
  const start = Math.round(rate * 0.2), count = Math.round(rate * 0.6);
  let maximum = 0, frequency = 0;
  for (let hz = 160; hz <= 300; hz += 0.5) {
    let re = 0, im = 0;
    for (let i = 0; i < count; i++) {
      const a = 2 * Math.PI * hz * i / rate, window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / count);
      re += samples[start + i] * Math.cos(a) * window;
      im += samples[start + i] * Math.sin(a) * window;
    }
    if (re * re + im * im > maximum) { maximum = re * re + im * im; frequency = hz; }
  }
  return frequency;
}
for (const semitones of [-3, 3]) test(`streaming pitch shifts a tone ${semitones} semitones without changing its length`, () => {
  const samples = tone(semitones), measured = peak(samples, 48000), expected = 220 * 2 ** (semitones / 12);
  assert.ok(Math.abs(measured - expected) < 5, `expected ${expected} Hz, measured ${measured} Hz`);
  assert.equal(samples.length, 48000);
  assert.ok(samples.every(Number.isFinite));
  assert.ok(Math.max(...samples) <= 0.101);
});
test('zero semitones produces exact original samples, including block boundaries', () => {
  const dsp = new StreamingPitch(48000);
  for (let block = 0; block < 10; block++) {
    const input = Float32Array.from({ length: 128 }, (_, i) => Math.sin((block * 128 + i) * 0.17) * 0.2);
    const output = new Float32Array(128); dsp.process(input, output);
    assert.deepEqual(output, input);
  }
});
test('missing input and silence do not synthesize a voice or nonfinite samples', () => {
  const dsp = new StreamingPitch(48000), output = new Float32Array(128);
  for (let i = 0; i < 100; i++) { dsp.process(undefined, output, 3, 0.3, 0.4); assert.ok(output.every((v: number) => v === 0)); }
});
test('changing pitch and robotic color does not grow the delay buffer or produce invalid samples', () => {
  const dsp = new StreamingPitch(44100), buffer = dsp.buffer;
  const input = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 8) * 0.2), output = new Float32Array(128);
  for (let i = 0; i < 2000; i++) {
    dsp.process(input, output, i % 2 ? 3 : -3, 0.32, 0.4);
    assert.ok(output.every(Number.isFinite)); assert.ok(output.every((v: number) => Math.abs(v) < 1));
  }
  assert.equal(dsp.buffer, buffer);
});
