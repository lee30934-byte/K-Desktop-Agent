"""Headless rendered component test; this is NOT the installed Tauri GUI."""
from pathlib import Path
import json
import subprocess
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
out = root / 'evidence' / 'elicitation-ui-20261007'
out.mkdir(parents=True, exist_ok=True)
harness = out / 'harness.tsx'
harness.write_text('''import React from 'react';
import {createRoot} from 'react-dom/client';
import Dialog from '../../src/components/CodexElicitationDialog';
let seq=0; const root=createRoot(document.getElementById('root'));
window.responses=[];
window.show=(schema,expires=Date.now()+120000)=>root.render(<Dialog key={++seq} request={{type:'codex_elicitation_request',id:'test',token:String(seq),threadId:'thread',turnId:null,conversation_id:'test',serverName:'Test MCP',message:'Read fixture windows? <script>not HTML</script>',schema,expiresAt:expires}} onResponse={async(r,action,content)=>{window.responses.push({token:r.token,action,content});}}/>);
''', encoding='utf-8')
subprocess.run(['node', str(root/'node_modules/esbuild/bin/esbuild'), str(harness), '--bundle', '--jsx=automatic', '--format=iife', '--outfile='+str(out/'harness.js')], check=True, cwd=root)
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='msedge')
    page = browser.new_page(viewport={'width': 1000, 'height': 850})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content('<meta charset="utf-8"><div id="root"></div>')
    css = (root/'src/index.css').read_text(encoding='utf-8')
    css = '\n'.join(line for line in css.splitlines() if not line.startswith('@import'))
    page.add_style_tag(content=css+(root/'src/App.css').read_text(encoding='utf-8'))
    page.add_style_tag(content='*, *::before, *::after { animation: none !important; transition: none !important; }')
    page.add_script_tag(path=str(out/'harness.js'))
    def show(expression, arg=None):
        previous = page.get_by_role('dialog').get_attribute('data-request-token') if page.get_by_role('dialog').count() else None
        page.evaluate(expression, arg)
        page.wait_for_function('(previous)=>document.querySelector("[data-request-token]")?.dataset.requestToken !== previous', arg=previous)
    boolean = {'type': 'object', 'properties': {'approve': {'type': 'boolean', 'title': '승인', 'default': True}}, 'required': ['approve']}
    show('(s)=>window.show(s)', boolean)
    accept = page.get_by_role('button', name='이 요청만 승인', exact=True)
    expect(accept).to_be_disabled()
    assert page.get_by_role('combobox').input_value() == ''
    assert page.evaluate('window.responses.length') == 0
    checks.append('No default or automatic approval')
    assert '<script>not HTML</script>' in page.get_by_role('dialog').inner_text()
    checks.append('Remote message rendered as plain text')
    page.get_by_role('combobox').select_option('false')
    expect(accept).to_be_enabled()
    page.screenshot(path=str(out/'form.png'))
    accept.click()
    page.wait_for_function('window.responses.length===1')
    assert page.evaluate('window.responses[0].content') == {'approve': False}
    expect(accept).to_be_disabled()
    checks.append('Explicit false value preserved; repeated submit disabled')
    for name, action in [('거절', 'decline'), ('취소', 'cancel')]:
        show('(s)=>window.show(s)', boolean)
        page.get_by_role('button', name=name, exact=True).click()
        page.wait_for_function('(a)=>window.responses.at(-1).action===a', arg=action)
        assert page.evaluate('window.responses.at(-1).content') is None
        checks.append(action)
    show('(s)=>window.show(s,Date.now()-10)', boolean)
    expect(accept).to_be_disabled()
    checks.append('Expired request cannot be accepted')
    show("window.show({type:'object',properties:{},allOf:[]})")
    expect(accept).to_be_disabled()
    checks.append('Unsupported schema cannot be accepted')
    show("window.show({type:'object',properties:{}})")
    expect(accept).to_be_enabled()
    assert page.evaluate('window.responses.length') == 3
    accept.click()
    page.wait_for_function('window.responses.length===4')
    assert page.evaluate('window.responses.at(-1).content') == {}
    checks.append('Empty approval form requires explicit click')
    show("window.show({type:'object',properties:{n:{type:'integer',minimum:1,maximum:3}},required:['n']})")
    page.get_by_role('spinbutton').fill('1.5')
    expect(accept).to_be_disabled()
    page.get_by_role('spinbutton').fill('2')
    expect(accept).to_be_enabled()
    checks.append('Numeric constraints enforced in rendered form')
    assert not errors, errors
    browser.close()
result = {'status': 'PASS', 'scope': 'Headless Edge rendered React component; not installed GUI', 'checks': checks, 'page_errors': errors}
(out/'rendered-ui.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
