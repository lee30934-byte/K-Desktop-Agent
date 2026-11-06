"""Record source hashes and the existing release/voice/control gates durably."""
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/simple-ui-20261106'
OUT.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
run = OUT / ('validation-' + stamp)
run.mkdir(exist_ok=False)
paths = ['src/App.css', 'src/components/AssistantWidget.tsx', 'src/components/AssistantWidget.css',
         'src/components/VoiceCallPanel.tsx', 'src/components/VoiceCallPanel.css', 'src/components/Sidebar.tsx',
         'src/components/MainChat.tsx', 'src/voiceSession.ts', 'src/voiceOutput.ts']


def hashes():
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths}


result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceHashes': hashes(),
          'checks': [], 'installed': False, 'published': False, 'realHardwareVoiceVerified': False}
for name, command in [
    ('release-gate', ['node', 'scripts/release-gate.mjs']),
    ('voice-tests', ['node', 'sidecar/node_modules/tsx/dist/cli.mjs', '--test', 'scripts/voice.test.ts']),
    ('dot-control-tests', ['node', 'sidecar/node_modules/tsx/dist/cli.mjs', '--test', 'scripts/dot-bridge.test.ts']),
]:
    log = run / (name + '.log')
    result['currentCheck'] = name
    (run / 'progress.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    with log.open('w', encoding='utf-8') as handle:
        proc = subprocess.run(command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
    result['checks'].append({'name': name, 'exitCode': proc.returncode, 'log': str(log)})
result['sourceUnchanged'] = hashes() == result['sourceHashes']
result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
result['status'] = 'PASS' if result['sourceUnchanged'] and all(c['exitCode'] == 0 for c in result['checks']) else 'FAIL'
(run / 'validation.done.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps({'status': result['status'], 'receipt': str(run / 'validation.done.json')}))
sys.exit(0 if result['status'] == 'PASS' else 1)
