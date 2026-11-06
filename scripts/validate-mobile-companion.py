"""Frozen-source full gate and loopback UI verification; no install/publication."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/mobile-companion-20261106'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    run = OUT / ('validation-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    run.mkdir(exist_ok=False)
    tracked = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8').splitlines()
    extra = ['sidecar/src/mobile-host.ts', 'sidecar/test-mobile.mjs', 'scripts/mobile-host.test.ts',
             'scripts/build-mobile-fixture.mjs', 'scripts/mobile-fixture-host.mjs', 'scripts/probe-mobile-companion.py',
             'scripts/validate-mobile-companion.py', 'scripts/mobile-private-access.ps1', 'src/mobileControl.ts',
             'src/components/MobileSettings.tsx', 'src/components/MobileDesktopBridge.tsx', 'vite.mobile.config.ts',
             'mobile/index.html', 'docs/mobile-companion.md', 'src/assets/k-assistant-ceramic-v2.png',
             'public/audio/voicePitch.worklet.mjs']
    extra += [str(p.relative_to(ROOT)).replace('\\', '/') for p in (ROOT / 'src/mobile').rglob('*') if p.is_file()]
    paths = sorted(set(tracked + extra))

    def hashes():
        return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths}

    state = dict(status='RUNNING', phase='FULL_VALIDATION', startedAt=now(), source=str(ROOT),
                 baseline='cd70a4e / v0.7.76', sourceHashes=hashes(), checks=[], installed=False,
                 published=False, networkPublished=False, realPhoneQA=False, realVoiceQA=False,
                 nextAction='Inspect full gate and real loopback browser verification; do not enable ingress or install.')

    def save():
        payload = json.dumps(state, ensure_ascii=False, indent=2)
        (run / 'state.json').write_text(payload, encoding='utf-8')
        (OUT / 'state.json').write_text(payload, encoding='utf-8')

    try:
        for name, command in [
            ('release-gate', ['node', 'scripts/release-gate.mjs']),
            ('desktop-fixture', ['node', 'scripts/build-mobile-fixture.mjs']),
            ('mobile-ui', [sys.executable, 'scripts/probe-mobile-companion.py']),
            ('diff-check', ['git', 'diff', '--check']),
        ]:
            state['currentCheck'] = name; save()
            log = run / f'{name}.log'
            with log.open('w', encoding='utf-8') as stream:
                proc = subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
            state['checks'].append(dict(name=name, exitCode=proc.returncode, log=str(log))); save()
            if proc.returncode:
                raise RuntimeError(f'{name}: exit {proc.returncode}; inspect {log}')
        state['sourceUnchangedDuringValidation'] = hashes() == state['sourceHashes']
        if not state['sourceUnchangedDuringValidation']:
            raise RuntimeError('Sources changed during validation')
        for relative in ['dist/audio/voicePitch.worklet.mjs', 'sidecar/dist/mobile/audio/voicePitch.worklet.mjs']:
            if (ROOT / relative).read_bytes() != (ROOT / 'public/audio/voicePitch.worklet.mjs').read_bytes():
                raise RuntimeError(f'Worklet missing or mismatched: {relative}')
        if not (ROOT / 'sidecar/dist/mobile/index.html').is_file():
            raise RuntimeError('Packaged mobile HTML missing')
        ui = json.loads((OUT / 'ui-v1/ui-verification.json').read_text(encoding='utf-8'))
        if ui['status'] != 'PASS':
            raise RuntimeError('UI verification failed')
        state.update(status='PASS', phase='IMPLEMENTED_VERIFIED_NOT_DEPLOYED', uiChecks=len(ui['checks']),
                     uiVerification=str(OUT / 'ui-v1/ui-verification.json'),
                     packagedVoiceWorkletMatches=True,
                     nextAction='Review candidate. Separate approval required for private HTTPS8443 ingress and a new release tag. K installs manually; real phone/call QA remains unverified.')
    except Exception as error:
        state.update(status='FAIL', phase='VALIDATION_FAILED', error=str(error))
    finally:
        state['finishedAt'] = now(); save()
        (run / 'validation.done.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
        (OUT / 'validation.done.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: state[key] for key in ['status', 'phase', 'checks']}, ensure_ascii=False))
    return 0 if state['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
