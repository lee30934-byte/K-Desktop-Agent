"""Isolated browser: real localStorage/reload and real button events, fake Bot/RPC transport."""
import argparse
import functools
import http.server
import json
from pathlib import Path
import subprocess
import threading
from playwright.sync_api import sync_playwright

p=argparse.ArgumentParser();p.add_argument('--out',required=True);args=p.parse_args()
root=Path(__file__).resolve().parents[1];out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
entry=out/'browser-harness.ts'
entry.write_text('''
import { TelegramHub } from "ROOT/src/telegramHub";
import { RemoteApprovalDispatcher } from "ROOT/src/remoteApproval";
let now = Number(localStorage.getItem('probe-clock')) || Date.now(), mid=100;
const chat='7203583138', conv='dddd1111-desktop';
const responses=[], sent=[];
const hub=new TelegramHub({
 api:{call:async(method,payload)=>{const message_id=++mid;sent.push({method,payload,message_id});
   if(method==='sendMessage'&&payload.reply_markup){
     document.querySelector('#phone').innerHTML='';
     for(const row of payload.reply_markup.inline_keyboard)for(const button of row){
       const b=document.createElement('button');b.textContent=button.text;
       b.onclick=()=>hub.handleUpdate({callback_query:{id:'cq',data:button.callback_data,message:{message_id,chat:{id:chat}}}});
       document.querySelector('#phone').appendChild(b);
     }
   }return {ok:true,result:{message_id}};},sendFile:async()=>({}),download:async()=>'',oneshot:async()=>''},
 startTurn:async()=>{throw Error('Must not launch an extra turn');},targets:()=>[],defaultTarget:()=>({convId:'default1',label:'Telegram'}),
 settings:()=>({routing:true,digest:true,buttons:true,progress:true,inbox:true,approvals:true,quiet:{enabled:false,startHour:23,endHour:7},pcName:''}),
 now:()=>now,log:()=>{},store:{get:k=>localStorage.getItem(k),set:(k,v)=>localStorage.setItem(k,v)},
 activeConversations:()=>[{convId:conv,label:'Desktop existing work'}],allowedChat:c=>c===chat,
 setTimeout:()=>0,
});
const dispatcher=new RemoteApprovalDispatcher();
Object.assign(window,{
 probe:{responses,sent,enable:()=>hub.handleUpdate({message:{chat:{id:chat},text:'/부재 36'}}),
 connected:()=>hub.chatFor(conv,now),clock:(value)=>{now=value;localStorage.setItem('probe-clock',String(now));},
 now:()=>now,request:()=>dispatcher.start({type:'codex_approval_request',id:'turn',token:'fake-rpc',threadId:'thread',
 turnId:'engine-turn',itemId:'item',kind:'command',command:['echo','safe'],cwd:'C:/fixture',conversation_id:conv,expiresAt:Date.now()+120000},
 chat,hub,()=>true,async reply=>{responses.push(reply);document.querySelector('#result').textContent=reply.action;},()=>{throw Error('Failed');})}
});
'''.replace('ROOT',root.as_posix()),encoding='utf-8')
build=out/'build-browser.mjs'
build.write_text("import { build } from "+json.dumps((root/'node_modules/esbuild/lib/main.js').as_uri())+";\nawait build({entryPoints:["+json.dumps(str(entry))+"],outfile:"+json.dumps(str(out/'harness.js'))+",bundle:true,format:'iife',platform:'browser',logLevel:'error'});",encoding='utf-8')
result=subprocess.run(['node',str(build)],cwd=root,capture_output=True)
(out/'browser-build.log').write_bytes(result.stdout+result.stderr)
if result.returncode:raise RuntimeError('Browser harness build failed')
(out/'index.html').write_text('<meta charset="utf-8"><div id="phone"></div><div id="result"></div><script src="harness.js"></script>',encoding='utf-8')
class QuietHandler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*_args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(out)))
threading.Thread(target=server.serve_forever,daemon=True).start()
checks=[]
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,channel='msedge')
  page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(f'http://127.0.0.1:{server.server_port}/')
  assert page.evaluate('probe.connected()') is None;checks.append('new browser: absence default OFF')
  page.evaluate('probe.enable()');assert page.evaluate('probe.connected()')=='7203583138'
  checks.append('explicit command subscribes desktop work')
  page.evaluate('probe.clock(probe.now()+30*3600000)');page.reload()
  assert page.evaluate('probe.connected()')=='7203583138';checks.append('real localStorage reload at 30h restores binding')
  page.evaluate('probe.request()');page.get_by_role('button',name='✅ 승인',exact=True).click()
  page.wait_for_function('probe.responses.length===1')
  assert page.locator('#result').inner_text()=='accept';checks.append('DOM phone button -> hub -> dispatcher -> exact RPC reply')
  assert page.evaluate('probe.responses[0].content') is None
  page.get_by_role('button',name='✅ 승인',exact=True).click()
  assert page.evaluate('probe.responses.length')==1;checks.append('duplicate DOM click cannot send RPC twice')
  page.evaluate('probe.clock(probe.now()+7*3600000)');page.reload()
  assert page.evaluate('probe.connected()') is None;checks.append('expired subscription stays OFF after reload')
  assert not errors,errors
  page.screenshot(path=str(out/'isolated-browser.png'))
  browser.close()
finally:server.shutdown()
receipt={'status':'PASS','checks':checks,'browser':'isolated Edge headless','realBotAPI':False,'realInstalledApp':False,
 'scope':'Actual browser storage/reload/DOM events; mocked Telegram API and native response transport'}
(out/'browser-verification.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(receipt,ensure_ascii=False))
