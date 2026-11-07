"""Durable validation of the voice selection candidate; no publication or installation."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/companion-voice-20261106'
RUN = OUT / 'full-validation-v1'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    RUN.mkdir(exist_ok=False)
    paths = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8').splitlines()
    paths += ['src/voiceTransport.ts', 'src/components/CompanionVoice.tsx', 'scripts/voice-choice.test.ts',
              'scripts/probe-companion-voice.py', 'scripts/validate-companion-voice.py',
              'src/components/CompanionAvatar.tsx', 'src/components/CompanionAvatar.css', 'src/components/CompanionWidget.css',
              'design/companion/k-assistant-ceramic-v2.png', 'src/image-assets.d.ts', 'scripts/probe-single-companion.py']

    def hashes():
        return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(paths))}

    state = dict(phase='VALIDATING', startedAt=now(), sourceHashes=hashes(), checks=[],
                 installed=False, published=False, hardwareAudioUsed=False, hardwareCallBeyondFiveMinutesVerified=False)

    def save():
        (RUN / 'state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')

    try:
        for path in [OUT / 'live-catalog.json', OUT / 'ui/voice-ui-verification.json', OUT / 'ui/ui-verification.json']:
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('status') != 'PASS':
                raise RuntimeError(f'Required verification did not pass: {path}')
        env = dict(os.environ, KDA_SIMPLE_UI_EVIDENCE=str(RUN.relative_to(ROOT) / 'simple-ui'))
        for name, command in [('simple-ui-fixture-build', ['node', 'scripts/build-simple-ui-fixture.mjs']),
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
        state['sourceUnchangedDuringValidation'] = hashes() == state['sourceHashes']
        if not state['sourceUnchangedDuringValidation']:
            raise RuntimeError('Sources changed during validation')
        state.update(status='PASS', phase='VOICE_SELECTION_VERIFIED_NOT_RELEASED')
    except Exception as error:
        state.update(status='FAIL', phase='VALIDATION_FAILED', error=str(error))
    finally:
        state['finishedAt'] = now()
        save()
        status = OUT / 'status.json'
        shutil.copy2(status, RUN / 'status.before-validation.json')
        previous = json.loads(status.read_text(encoding='utf-8'))
        previous.update(state)
        status.write_text(json.dumps(previous, ensure_ascii=False, indent=2), encoding='utf-8')
        (RUN / 'validation.done.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if state.get('status') == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
