"""Detached, durable validation; no installation, publication or live media."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/single-companion-20261106'
RUN = OUT / 'full-validation-v1'
DONE = RUN / 'validation.done.json'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    RUN.mkdir(exist_ok=False)
    state_path = OUT / 'status.json'
    state = json.loads(state_path.read_text(encoding='utf-8'))
    state.update(phase='VALIDATING', validationStartedAt=now(), validationRoot=str(RUN),
                 installed=False, published=False, checks=[])
    paths = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8').splitlines()
    paths += ['src/components/CompanionAvatar.tsx', 'src/components/CompanionAvatar.css',
              'src/components/CompanionWidget.css', 'design/companion/k-assistant-ceramic-v2.png',
              'src/image-assets.d.ts', 'scripts/probe-single-companion.py',
              'scripts/validate-single-companion.py']

    def hashes():
        return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(paths))}

    def save():
        payload = json.dumps(state, ensure_ascii=False, indent=2)
        state_path.write_text(payload, encoding='utf-8')
        (RUN / 'state.json').write_text(payload, encoding='utf-8')

    try:
        state['sourceHashes'] = hashes()
        ui_path = OUT / 'validation-v5/ui-verification.json'
        ui = json.loads(ui_path.read_text(encoding='utf-8'))
        if ui.get('status') != 'PASS':
            raise RuntimeError('The companion UI verification is not PASS')
        state.update(uiVerification=str(ui_path), uiChecks=len(ui['checks']),
                     hardwareCallBeyondFiveMinutesVerified=False)
        save()
        env = dict(os.environ, KDA_SIMPLE_UI_EVIDENCE=str(RUN.relative_to(ROOT) / 'simple-ui'))
        commands = [
            ('simple-ui-fixture-build', ['node', 'scripts/build-simple-ui-fixture.mjs']),
            ('release-gate', ['node', 'scripts/release-gate.mjs']),
            ('diff-check', ['git', 'diff', '--check']),
        ]
        for name, command in commands:
            state['currentCheck'] = name
            save()
            log = RUN / f'{name}.log'
            with log.open('w', encoding='utf-8') as stream:
                proc = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
            state['checks'].append(dict(name=name, exitCode=proc.returncode, log=str(log)))
            save()
            if proc.returncode:
                raise RuntimeError(f'{name} failed with exit {proc.returncode}; inspect {log}')
        state['sourceUnchangedDuringValidation'] = hashes() == state['sourceHashes']
        if not state['sourceUnchangedDuringValidation']:
            raise RuntimeError('Candidate source changed while validation was running')
        state.update(status='PASS', phase='SOURCE_VERIFIED_NOT_RELEASED',
                     nextAction='Review candidate UI. No new release/tag/install authorization inferred.')
    except Exception as error:
        state.update(status='FAIL', phase='VALIDATION_FAILED', error=str(error),
                     nextAction='Inspect preserved validation evidence and repair the failing check.')
    finally:
        state['validationFinishedAt'] = now()
        save()
        DONE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if state.get('status') == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
