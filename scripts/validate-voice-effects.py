"""Durable validation of the current local voice effects candidate."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/voice-effects-20261106'
RUN = OUT / os.environ.get('KDA_EFFECT_VALIDATION_RUN', 'full-validation-v1')


def main():
    RUN.mkdir(exist_ok=False)
    paths = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8').splitlines()
    paths += ['src/voiceEffects.ts', 'src/voiceTransport.ts', 'src/components/CompanionAvatar.tsx',
              'src/components/CompanionAvatar.css', 'src/components/CompanionWidget.css', 'src/components/CompanionIcon.tsx',
              'src/components/CompanionVoice.tsx', 'public/audio/voicePitch.worklet.mjs', 'src/image-assets.d.ts',
              'src/assets/k-assistant-ceramic-v2.png', 'scripts/voice-effects.test.ts', 'scripts/voice-choice.test.ts',
              'scripts/build-voice-effects-fixture.mjs', 'scripts/probe-voice-effects.py',
              'scripts/probe-companion-effects.py', 'scripts/probe-companion-voice.py', 'scripts/probe-single-companion.py',
              'scripts/validate-voice-effects.py']

    def hashes():
        return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(paths))}

    state = dict(status='RUNNING', startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 sourceHashes=hashes(), checks=[], installed=False, published=False, hardwareAudioUsed=False)

    def save():
        (RUN / 'state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')

    try:
        for rel in ['ui-v2/ui-verification.json', 'ui-v2/voice-ui-verification.json',
                    'ui-v2/effect-ui-verification.json', 'audio-v3/effect-audio-verification.json', 'audio-v3/audio-verification.json']:
            receipt = json.loads((OUT / rel).read_text(encoding='utf-8'))
            if receipt.get('status') != 'PASS':
                raise RuntimeError(f'Prerequisite did not pass: {rel}')
        env = dict(os.environ, KDA_SIMPLE_UI_EVIDENCE=str(RUN.relative_to(ROOT) / 'simple-ui'))
        for name, command in [('voice-session-tests', ['node', 'sidecar/node_modules/tsx/dist/cli.mjs', '--test', 'scripts/voice.test.ts']),
                              ('simple-ui-fixture-build', ['node', 'scripts/build-simple-ui-fixture.mjs']),
                              ('release-gate', ['node', 'scripts/release-gate.mjs']),
                              ('diff-check', ['git', 'diff', '--check'])]:
            state['currentCheck'] = name
            save()
            log = RUN / f'{name}.log'
            with log.open('w', encoding='utf-8') as stream:
                proc = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
            state['checks'].append(dict(name=name, exitCode=proc.returncode, log=str(log)))
            save()
            if proc.returncode:
                raise RuntimeError(f'{name}: exit {proc.returncode}; inspect {log}')
        source = ROOT / 'public/audio/voicePitch.worklet.mjs'
        packaged = ROOT / 'dist/audio/voicePitch.worklet.mjs'
        state['packagedWorkletHashMatches'] = packaged.exists() and source.read_bytes() == packaged.read_bytes()
        state['sourceUnchangedDuringValidation'] = hashes() == state['sourceHashes']
        if not state['sourceUnchangedDuringValidation'] or not state['packagedWorkletHashMatches']:
            raise RuntimeError('Source changed or packaged worklet is missing/different')
        if (ROOT / 'dist/audio/failing-test-worklet.mjs').exists():
            raise RuntimeError('Evidence-only fault injector was included in production output')
        state['status'] = 'PASS'
    except Exception as error:
        state.update(status='FAIL', error=str(error))
    finally:
        state['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
        (RUN / 'validation.done.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if state['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
