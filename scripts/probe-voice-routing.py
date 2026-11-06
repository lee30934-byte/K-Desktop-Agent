"""Actual widget/session routing with synthetic media and native stubs only."""
import asyncio
import datetime
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/voice-routing-20261106/widget'


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, errors = [], []
    result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': checks,
              'hardwareAudioUsed': False, 'nativeTransport': 'fixture', 'installed': False}
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                context = await browser.new_context(viewport={'width': 1440, 'height': 960})
                await context.add_init_script("""
                  window.fixtureTracks=[];
                  navigator.mediaDevices.getUserMedia=async()=>{
                    const t={enabled:true,readyState:'live',stop(){this.readyState='ended'}};
                    window.fixtureTracks.push(t);return {getTracks:()=>[t],getAudioTracks:()=>[t]};
                  };
                  navigator.mediaDevices.enumerateDevices=async()=>[];
                  window.RTCPeerConnection=class {
                    constructor(){window.fixturePeer=this;this.connectionState='new';this.iceGatheringState='complete';this.channel={readyState:'open',close(){}};}
                    addTrack(){} createDataChannel(){return this.channel;}
                    async createOffer(){return {type:'offer',sdp:'v=0'};}
                    async setLocalDescription(d){this.localDescription=d;}
                    async setRemoteDescription(d){this.remoteDescription=d;}
                    close(){this.connectionState='closed';}
                  };
                  window.Audio=class {pause(){} async play(){}};
                """)
                page = await context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.goto(f'http://127.0.0.1:{server.server_port}/review.html')
                await page.evaluate("""() => {
                  const original=window.dotInvoke;window.nativeCalls=[];
                  window.dotInvoke=async(command,args)=>{if(command==='voice_control')window.nativeCalls.push(args);return original(command,args)};
                }""")
                await page.get_by_role('button', name='통화하기', exact=True).click()
                await page.wait_for_function("window.nativeCalls.some(c=>c.action==='start')")
                await page.evaluate("""() => {
                  const peer=window.fixturePeer;peer.connectionState='connected';peer.onconnectionstatechange();
                  window.voiceData=e=>peer.channel.onmessage({data:JSON.stringify(e)});
                  window.voiceData({type:'session.started'});
                  window.command=(command,token=crypto.randomUUID())=>{
                    const sessionId=window.nativeCalls.find(c=>c.action==='start').sessionId;
                    window.voiceListener({payload:{type:'voice_event',sessionId,kind:'command',token,createdAt:Date.now(),command}});
                  };
                  window.utter=(text,id=crypto.randomUUID())=>{
                    window.voiceData({type:'input_transcript.added'});
                    window.voiceData({type:'turn.done',turn:{id,role:'user',transcript:text}});
                  };
                  window.answer=()=>window.voiceData({type:'turn.done',turn:{role:'assistant',transcript:'접수했습니다'}});
                }""")
                panel = page.get_by_role('region', name='AI 비서 음성통화')
                route = panel.get_by_role('combobox', name='음성 명령 대상', exact=True)
                assert await route.input_value() == ''
                checks.append('actual panel connects using synthetic media; follow-selection is the default')

                await page.evaluate("window.voiceData({type:'input_transcript.added'})")
                await page.evaluate("window.renderAssistantFixture('release-fixture')")
                await page.wait_for_function("document.querySelector('.assistant-widget-target strong').textContent==='KDA 연결 상태 점검'")
                assert '비서 화면 디자인' in await panel.locator('.voice-call-target').inner_text()
                assert await route.is_disabled()
                await page.evaluate("""() => {
                  window.voiceData({type:'turn.done',turn:{id:'first',role:'user',transcript:'이거 수정해줘'}});
                  window.command({action:'send',text:'이거 수정해줘'},'once');
                }""")
                await page.wait_for_function("window.actions.some(a=>a.text==='이거 수정해줘')")
                assert await page.evaluate("window.actions.find(a=>a.text==='이거 수정해줘').id") == '11111111-1111-4111-8111-111111111111'
                checks.append('browsing mid-utterance preserves the spoken target and disables manual retargeting')

                await page.evaluate("window.answer();window.utter('이 대화도 점검');window.command({action:'send',text:'이 대화도 점검'})")
                await page.wait_for_function("window.actions.some(a=>a.text==='이 대화도 점검')")
                assert await page.evaluate("window.actions.find(a=>a.text==='이 대화도 점검').id") == 'release-fixture'
                await page.evaluate("window.answer();window.command({action:'send',text:'중복 실행 금지'},'once')")
                assert not await page.evaluate("window.actions.some(a=>a.text==='중복 실행 금지')")
                checks.append('next utterance follows the new conversation; tokens cannot replay across targets')

                await page.evaluate("window.utter('Telegram 원격 대화에 요청');window.command({action:'send',target:'Telegram 원격 대화',text:'연결 점검'})")
                await page.wait_for_function("window.actions.some(a=>a.text==='연결 점검')")
                assert await page.evaluate("window.actions.find(a=>a.text==='연결 점검').id") == 'telegram-fixture'
                await page.wait_for_function("document.querySelector('[aria-label=\"음성 명령 대상\"]').value==='telegram-fixture'")
                await page.evaluate("window.answer();window.renderAssistantFixture('11111111-1111-4111-8111-111111111111')")
                assert 'Telegram 원격 대화' in await panel.locator('.voice-call-target').inner_text()
                await page.get_by_role('button', name='통화 대화로 이동', exact=False).click()
                assert await page.evaluate("window.actions[window.actions.length-1].select") == 'telegram-fixture'
                checks.append('spoken name routes and pins the actual session; return-to-target navigation remains available')

                await route.select_option('release-fixture')
                await page.wait_for_function("document.querySelector('[aria-label=\"음성 명령 대상\"]').value==='release-fixture'")
                await route.select_option('')
                assert '현재 대화 따라가기' in await panel.locator('.voice-call-target').inner_text()
                assert await page.evaluate("window.nativeCalls.filter(c=>c.action==='start').length") == 1
                assert not await page.evaluate("window.nativeCalls.some(c=>c.action==='stop')")
                checks.append('manual routing and follow-selection never restart media or stop existing work')

                await page.screenshot(path=str(OUT / 'routing.png'))
                await page.set_viewport_size({'width': 390, 'height': 844})
                await route.scroll_into_view_if_needed()
                box = await route.bounding_box()
                assert box and box['width'] > 50 and box['x'] >= 0 and box['x'] + box['width'] <= 391
                checks.append('target selection remains reachable at a narrow viewport')
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()
                await page.wait_for_function("window.fixtureTracks.every(t=>t.readyState==='ended')")
                assert await page.evaluate("window.nativeCalls.filter(c=>c.action==='start').length") == 1
                checks.append('closing releases the synthetic input without reissuing commands')
                assert not errors, errors
                result.update(status='PASS', pageErrors=errors)
            finally:
                await browser.close()
    except Exception as e:
        result.update(status='FAIL', error=str(e), pageErrors=errors)
        raise
    finally:
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (OUT / 'routing-ui.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        server.shutdown()
    print(json.dumps({'status': result['status'], 'checks': len(checks)}))


asyncio.run(main())
