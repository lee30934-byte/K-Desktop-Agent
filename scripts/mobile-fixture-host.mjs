import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { MobileHost } from '../sidecar/dist/mobile-host.js';
const fixtureRoot = new URL(`../${process.env.KDA_MOBILE_EVIDENCE || 'evidence/mobile-companion-20261106/ui-v1'}/`, import.meta.url);
const reserve = net.createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const mobilePort = reserve.address().port;
await new Promise(r => reserve.close(r));
const events = []; const voice = [];
const host = new MobileHost(e => { events.push(e); }, m => voice.push(m));
const server = http.createServer(async(req,res)=>{
  const url = new URL(req.url,'http://localhost');
  const json = v => {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
  if(url.pathname==='/fixture/setup')return json({mobilePort});
  if(url.pathname==='/fixture/events')return json({cursor:events.length,events:events.slice(Number(url.searchParams.get('after'))||0)});
  if(url.pathname==='/fixture/native'&&req.method==='POST'){
    let body='';for await(const part of req)body+=part;const {command,args}=JSON.parse(body);
    if(command==='mobile_control')host.receive({type:'mobile_control',...args,...(args.action==='enable'?{port:mobilePort}:{})});
    else if(command==='voice_control'){
      voice.push(args);
      // Deny real hardware/provider use. Confirm relay and end with an explicit fixture error.
      if(args.action==='start')setTimeout(()=>host.publishVoice({type:'voice_event',sessionId:args.sessionId,kind:'error',message:'격리 시험: 실제 음성 엔진은 연결하지 않았습니다.'}),30);
      host.receive({type:'mobile_control',action:'reply',requestId:'unused',result:{}});
    }
    return json({ok:true});
  }
  if(url.pathname==='/fixture/trace')return json({voice,requests:events.filter(e=>e.type==='mobile_request').map(e=>({method:e.method,params:e.method==='voice'?{action:e.params.action}:e.params}))});
  if(url.pathname==='/fixture/close'){await host.close();res.end('closed');server.close();return;}
  const files={'/desktop.html':'desktop.html','/desktop.js':'desktop.js'};
  if(!files[url.pathname]){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});res.end(await readFile(new URL(files[url.pathname],fixtureRoot)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({desktopOrigin:`http://127.0.0.1:${server.address().port}`,mobileOrigin:`http://127.0.0.1:${mobilePort}`}));
