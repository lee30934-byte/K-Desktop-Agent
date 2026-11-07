"""Checkpointed checks for the companion surface refinement; no install or release."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/companion-polish-20261106'
RUN = OUT / 'full-validation-v1'


def main():
    RUN.mkdir(exist_ok=False)
    paths = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8').splitlines()
    paths += ['src/components/CompanionIcon.tsx', 'src/components/CompanionWidget.css',
              'src/components/CompanionAvatar.tsx', 'src/components/CompanionAvatar.css',
              'src/components/CompanionVoice.tsx', 'src/voiceTransport.ts', 'src/image-assets.d.ts',
              'design/companion/k-assistant-ceramic-v2.png', 'scripts/probe-companion-voice.py',
              'scripts/probe-single-companion.py', 'scripts/validate-companion-polish.py']

    def hashes():
        return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(paths))}

    state = dict(status='RUNNING', startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 sourceHashes=hashes(), checks=[], installed=False, published=False, hardwareAudioUsed=False)

    def save():
        (RUN / 'state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')

    try:
        for name in ['ui-verification.json', 'voice-ui-verification.json']:
            data = json.loads((OUT / 'ui-v2' / name).read_text(encoding='utf-8'))
            if data.get('status') != 'PASS':
                raise RuntimeError(f'UI prerequisite did not pass: {name}')
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
            raise RuntimeError('Source changed during validation')
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
