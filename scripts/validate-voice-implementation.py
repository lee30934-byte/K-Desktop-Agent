"""Durable local validation receipt. No release, installation or live media."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/voice-implementation-20261106'
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
run = OUT / ('validation-' + stamp)
run.mkdir(parents=True, exist_ok=False)
result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'root': str(ROOT), 'checks': []}
paths = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8').splitlines()
paths += ['sidecar/src/codex-voice.mjs', 'sidecar/src/codex-voice.d.mts', 'sidecar/src/voice-contract.mjs', 'sidecar/src/voice-contract.d.mts',
          'sidecar/test-voice.mjs', 'src/voiceControl.ts', 'src/voiceSession.ts', 'src/components/VoiceCallPanel.tsx', 'src/components/VoiceCallPanel.css',
          'scripts/voice.test.ts', 'scripts/probe-codex-voice.py', 'scripts/voice-probe-host.mjs', 'scripts/build-voice-fixture.mjs',
          'scripts/validate-voice-implementation.py', 'docs/kda-voice-implementation-20261106.md']
def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(set(paths))}
result['sourceHashes'] = hashes()
checks = [
    ('release-gate', ['node', 'scripts/release-gate.mjs']),
    ('dot-control-regression', ['node', 'sidecar/node_modules/tsx/dist/cli.mjs', 'scripts/dot-bridge.test.ts']),
]
for name, command in checks:
    log = run / (name + '.log')
    with log.open('w', encoding='utf-8') as f:
        p = subprocess.run(command, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, encoding='utf-8')
    result['checks'].append({'name': name, 'exitCode': p.returncode, 'log': str(log)})
    (run / 'state.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
result['status'] = 'PASS' if all(c['exitCode'] == 0 for c in result['checks']) else 'FAIL'
result['sourceUnchangedDuringValidation'] = hashes() == result['sourceHashes']
if not result['sourceUnchangedDuringValidation']:
    result['status'] = 'FAIL'
(run / 'validation.done.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps({'path':str(run / 'validation.done.json'),'status':result['status']}))
sys.exit(0 if result['status'] == 'PASS' else 1)
