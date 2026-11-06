"""Durable validation of the current candidate; does not install or publish."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/avatar-motion-20261106'
run = OUT / ('validation-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
run.mkdir(exist_ok=False)
status_path = OUT / 'status.json'
state = json.loads(status_path.read_text(encoding='utf-8'))
state.update(phase='VALIDATING', checks=[], validationRoot=str(run))
paths = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, encoding='utf-8').splitlines()
paths += ['src/components/AssistantAvatar.tsx', 'src/components/AssistantAvatar.css',
          'scripts/build-avatar-review.mjs', 'scripts/probe-avatar-motion.py', 'scripts/validate-avatar-motion.py',
          'docs/kda-avatar-motion-20261106.md']


def hashes():
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(paths))}


def save():
    text = json.dumps(state, ensure_ascii=False, indent=2)
    status_path.write_text(text, encoding='utf-8')
    (run / 'state.json').write_text(text, encoding='utf-8')


state['sourceHashes'] = hashes()
environment = dict(os.environ, KDA_WIDGET_EVIDENCE='evidence/avatar-motion-20261106/ui',
                   KDA_SIMPLE_UI_EVIDENCE='evidence/avatar-motion-20261106/simple-ui')
commands = [
    ('widget-fixture-build', ['node', 'scripts/build-assistant-widget-fixture.mjs']),
    ('gallery-build', ['node', 'scripts/build-avatar-review.mjs']),
    ('avatar-ui', [sys.executable, 'scripts/probe-avatar-motion.py']),
    ('widget-regression', [sys.executable, 'scripts/probe-assistant-widget.py']),
    ('simple-ui-build', ['node', 'scripts/build-simple-ui-fixture.mjs']),
    ('simple-ui-regression', [sys.executable, 'scripts/probe-simple-ui.py']),
    ('release-gate', ['node', 'scripts/release-gate.mjs']),
]
for name, command in commands:
    state['currentCheck'] = name
    save()
    log = run / (name + '.log')
    with log.open('w', encoding='utf-8') as stream:
        proc = subprocess.run(command, cwd=ROOT, env=environment, stdout=stream, stderr=subprocess.STDOUT)
    state['checks'].append({'name': name, 'exitCode': proc.returncode, 'log': str(log)})
    save()
    print(name, proc.returncode, flush=True)
    if proc.returncode:
        break
state['sourceUnchangedDuringValidation'] = hashes() == state['sourceHashes']
state['status'] = 'PASS' if len(state['checks']) == len(commands) and all(c['exitCode'] == 0 for c in state['checks']) and state['sourceUnchangedDuringValidation'] else 'FAIL'
state['phase'] = 'SOURCE_VERIFIED_NOT_RELEASED' if state['status'] == 'PASS' else 'VALIDATION_FAILED'
state['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
state['nextAction'] = 'Review the interactive avatar preview; release/tag/installation not authorized.' if state['status'] == 'PASS' else 'Inspect the failed check log; preserve existing evidence before retry.'
save()
(run / 'validation.done.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': state['status'], 'receipt': str(run / 'validation.done.json')}))
sys.exit(0 if state['status'] == 'PASS' else 1)
