"""Headless React integration checks; no installed desktop or live tools are controlled."""
from pathlib import Path
import argparse
import functools
import http.server
import json
import subprocess
import threading
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('--node', default='node')
args = parser.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
harness = out / 'harness.tsx'
harness.write_text('''import React,{useState,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import Requests from 'ROOT/src/components/ApprovalRequests';
import Toggle from 'ROOT/src/components/ApprovalToggle';
import {useApprovalShortcut} from 'ROOT/src/utils/useApprovalMode';
let seq=0;
function Harness({config}) {
 useApprovalShortcut();
 const [requests,setRequests]=useState(config.requests);
 return <><Toggle/><Toggle/><Requests requests={requests} activeConversationId={config.active??'a'}
  isLive={r=>r.id!=='stopped'&&r.conversation_id!=='forged'}
  respond={async(r,reply)=>{window.attempts++; if(window.failures-->0)throw Error('simulated');
    window.responses.push({token:r.token,...reply});}}
  onResolved={r=>setRequests(prev=>prev.filter(p=>p.token!==r.token))}
  onAudit={(r,result)=>window.audits.push(result)}/></>;
}
const app=createRoot(document.getElementById('root'));
window.show=config=>{window.responses=[];window.audits=[];window.attempts=0;window.failures=config.failures??0;
app.render(<StrictMode><div data-run={++seq}><Harness key={seq} config={config}/></div></StrictMode>);return seq;};
'''.replace('ROOT', root.as_posix()), encoding='utf-8')
build = out / 'bundle.mjs'
build.write_text("import {buildSync} from '" + (root/'node_modules/esbuild/lib/main.js').as_uri() + "';\n" +
    'buildSync('+json.dumps({'entryPoints': [str(harness)], 'bundle': True, 'jsx': 'automatic',
      'format': 'iife', 'outfile': str(out/'harness.js'), 'nodePaths': [str(root/'node_modules')]})+');', encoding='utf-8')
bundle = subprocess.run([args.node, str(build)], cwd=root, capture_output=True, text=True, encoding='utf-8')
(out/'bundle.log').write_text(bundle.stdout+bundle.stderr, encoding='utf-8')
if bundle.returncode:
    raise RuntimeError(f'UI bundle failed (exit {bundle.returncode}); see {out / "bundle.log"}')
(out/'index.html').write_text('<meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>', encoding='utf-8')
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(out)))
threading.Thread(target=server.serve_forever, daemon=True).start()
checks = []
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel='msedge')
        page = browser.new_page(viewport={'width': 1100, 'height': 850})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{server.server_port}/')
        css = '\n'.join(x for x in (root/'src/index.css').read_text(encoding='utf-8').splitlines() if not x.startswith('@import'))
        page.add_style_tag(content=css+(root/'src/App.css').read_text(encoding='utf-8'))
        page.add_style_tag(content='*,*::before,*::after{animation:none!important;transition:none!important}')
        schema = {'type': 'object', 'properties': {'approve': {'type': 'boolean'}}, 'required': ['approve']}
        def request(token='one', **patch):
            return {'type': 'codex_elicitation_request', 'id': 'turn', 'token': token, 'threadId': 'thread',
                'turnId': None, 'conversation_id': 'a', 'serverName': 'fixture', 'message': 'Test confirmation',
                'schema': schema, 'expiresAt': page.evaluate('Date.now()+120000'), **patch}
        def show(requests, enabled=False, **patch):
            run = page.evaluate("c=>{localStorage.setItem('kda_auto_approve',c.enabled?'1':'0'); return window.show(c)}",
                {'requests': requests, 'enabled': enabled, **patch})
            page.wait_for_function('(run)=>document.querySelector("[data-run]")?.dataset.run===String(run)', arg=run)
        switch = page.get_by_role('switch', name='자동 승인').first
        show([request()])
        expect(page.get_by_role('dialog')).to_be_visible()
        expect(switch).to_have_attribute('aria-checked', 'false')
        page.get_by_role('combobox').select_option('true')
        page.get_by_role('button', name='이 요청만 승인', exact=True).click()
        page.wait_for_function('window.responses.length===1')
        assert page.evaluate('window.responses[0].content') == {'approve': True}
        checks.append('OFF manual approval executes once')
        show([request('pending')])
        page.get_by_role('dialog').get_by_role('switch', name='자동 승인').click()
        page.wait_for_function('window.responses.length===1')
        expect(page.get_by_role('dialog')).to_have_count(0)
        assert page.evaluate('window.attempts') == 1
        for item in page.get_by_role('switch').all():
            expect(item).to_have_attribute('aria-checked', 'true')
        assert page.evaluate("localStorage.getItem('kda_auto_approve')") == '1'
        checks.append('Toggle synchronizes all instances, saves setting and auto-resolves pending request once under StrictMode')
        show([request('background', conversation_id='b')], enabled=True)
        page.wait_for_function('window.responses.length===1')
        expect(page.get_by_role('dialog')).to_have_count(0)
        checks.append('ON background conversation proceeds without modal')
        show([request('bg-off', conversation_id='b')])
        page.wait_for_timeout(100)
        assert page.evaluate('window.attempts') == 0
        expect(page.get_by_role('dialog')).to_have_count(0)
        checks.append('OFF never borrows visible-conversation consent for background request')
        show([request('text', schema={'type': 'object', 'properties': {'answer': {'type': 'string'}}, 'required': ['answer']})], enabled=True)
        expect(page.get_by_role('dialog')).to_be_visible()
        assert page.evaluate('window.attempts') == 0
        checks.append('ON does not guess answers to input questions')
        show([request('retry')], enabled=True, failures=1)
        expect(page.get_by_role('dialog')).to_be_visible()
        expect(page.get_by_role('alert')).to_contain_text('전달 실패')
        page.get_by_role('combobox').select_option('true')
        page.get_by_role('button', name='이 요청만 승인', exact=True).click()
        page.wait_for_function('window.responses.length===1')
        assert page.evaluate('window.attempts') == 2
        checks.append('Failed automatic response falls back to usable manual form')
        show([request('twice')], enabled=True, failures=2)
        expect(page.get_by_role('dialog')).to_be_visible()
        page.get_by_role('combobox').select_option('true')
        accept=page.get_by_role('button', name='이 요청만 승인', exact=True)
        accept.click()
        expect(accept).to_be_enabled()
        accept.click()
        page.wait_for_function('window.responses.length===1')
        assert page.evaluate('window.attempts') == 3
        checks.append('Failed manual retry releases busy state and permits another attempt')
        execution = request('command', type='codex_approval_request', turnId='turn', itemId='item', kind='command', command='Get-Item fixture', cwd='C:/fixture', changes=None)
        show([execution])
        expect(page.get_by_role('dialog')).to_be_visible()
        page.screenshot(path=str(out/'manual-command.png'))
        page.get_by_role('button', name='거절', exact=True).click()
        page.wait_for_function('window.responses.length===1')
        assert page.evaluate('window.responses[0].action') == 'decline'
        checks.append('Command OFF uses nonblocking manual dialog')
        show([{**execution,'token':'file','kind':'file','changes':[{'path':'fixture.txt','kind':'update','diff':'+ok'}]}], enabled=True)
        page.wait_for_function('window.responses.length===1')
        expect(page.get_by_role('dialog')).to_have_count(0)
        checks.append('File approval ON executes without modal')
        show([request('expired',expiresAt=0),request('stop',id='stopped'),request('forged',conversation_id='forged')], enabled=True)
        page.wait_for_timeout(100)
        assert page.evaluate('window.attempts') == 0
        expect(page.get_by_role('dialog')).to_have_count(0)
        checks.append('Expired, stopped and mismatched requests never execute')
        show([], enabled=True)
        switch.click()
        expect(switch).to_have_attribute('aria-checked','false')
        show([request('off-again')])
        expect(page.get_by_role('dialog')).to_be_visible()
        assert page.evaluate('window.attempts') == 0
        checks.append('Turning OFF restores manual review')
        page.keyboard.press('Control+Alt+a')
        page.wait_for_function('window.responses.length===1')
        expect(switch).to_have_attribute('aria-checked','true')
        page.keyboard.press('Control+Alt+a')
        expect(switch).to_have_attribute('aria-checked','false')
        page.keyboard.press('Control+Alt+Shift+a')
        expect(switch).to_have_attribute('aria-checked','false')
        checks.append('Ctrl+Alt+A works through modal and restores OFF; Shift variant does not toggle')
        assert not errors, errors
        browser.close()
    result = {'status':'PASS', 'scope':'Headless rendered React components, not installed GUI', 'checks':checks, 'page_errors':errors}
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
finally:
    server.shutdown()
    server.server_close()
