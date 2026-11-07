/**
 * Read-only loudness tap of the voice the assistant is currently speaking.
 * Only the received call/preview output registers here; the microphone never does.
 */
type LevelSource = () => number;
let source: LevelSource | null = null;
export function setVoiceLevelSource(next: LevelSource) {
  source = next;
  return () => { if (source === next) source = null; };
}
/** 0..1 loudness, or null when no assistant voice output exists. */
export function readVoiceLevel(): number | null {
  if (!source) return null;
  try {
    const value = source();
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  } catch { return null; }
}
/** Map RMS to 0..1 on a speech-friendly dB scale (-52 dB → 0, -14 dB → 1). */
export function rmsToLevel(rms: number) {
  if (!(rms > 0)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 52) / 38));
}
