"""Freeze release inputs and record full local validation; never install or publish."""
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/release-v0773-20261106'
STAMP = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
RUN = OUT / ('validation-' + STAMP)
RUN.mkdir(parents=True, exist_ok=False)
paths = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8', stderr=subprocess.DEVNULL).splitlines()
paths += ['src/voiceOutput.ts', 'src/voiceRouting.ts', 'scripts/build-simple-ui-fixture.mjs',
          'scripts/probe-simple-ui.py', 'scripts/probe-voice-output.py', 'scripts/probe-voice-routing.py',
          'scripts/validate-simple-ui.py', 'scripts/validate-voice-routing.py',
          'docs/kda-ui-simplification-20261106.md', 'docs/kda-voice-routing-20261106.md']


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(set(paths))}


result = {'version': '0.7.73', 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'sourceHashes': hashes(), 'checks': [], 'installed': False, 'installRequested': False,
          'realHardwareVoiceVerified': False, 'newRoutingSubscriptionSpeechVerified': False}
commands = [('release-gate', ['node', 'scripts/release-gate.mjs']),
            ('dot-control', ['node', 'sidecar/node_modules/tsx/dist/cli.mjs', 'scripts/dot-bridge.test.ts'])]
for name, command in commands:
    result['currentCheck'] = name
    (RUN / 'progress.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    log = RUN / (name + '.log')
    with log.open('w', encoding='utf-8') as handle:
        proc = subprocess.run(command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
    result['checks'].append({'name': name, 'exitCode': proc.returncode, 'log': str(log)})
for name, rel, count in [('routing-ui', 'widget/routing-ui.json', 7),
                         ('simple-ui', 'simple-ui/ui-verification.json', 8),
                         ('widget-regression', 'widget-regression/ui-verification.json', 16)]:
    path = ROOT / 'evidence/voice-routing-20261106' / rel
    record = json.loads(path.read_text(encoding='utf-8'))
    actual_count = len(record['checks'])
    result['checks'].append({'name': name, 'exitCode': 0 if record['status'] == 'PASS' and actual_count == count else 1,
                             'checks': actual_count, 'receipt': str(path)})
result['sourceUnchanged'] = hashes() == result['sourceHashes']
result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
result['status'] = 'PASS' if result['sourceUnchanged'] and all(c['exitCode'] == 0 for c in result['checks']) else 'FAIL'
(RUN / 'validation.done.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
(OUT / 'validation.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
(OUT / 'source-manifest.json').write_text(json.dumps(result['sourceHashes'], indent=2), encoding='utf-8')
print(json.dumps({'status': result['status'], 'receipt': str(RUN / 'validation.done.json')}))
sys.exit(0 if result['status'] == 'PASS' else 1)
