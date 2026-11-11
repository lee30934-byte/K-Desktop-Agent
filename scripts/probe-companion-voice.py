"""Headless fixture verification. No hardware microphone, speaker or native call."""
import asyncio
import datetime
import functools
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ.get('KDA_WIDGET_EVIDENCE', 'evidence/companion-voice-20261106/ui')


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, errors = [], []
    result = dict(hardwareAudioUsed=False, nativeTransport='fixture', checks=checks,
                  installed=False, published=False, startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                context = await browser.new_context(viewport={'width': 1440, 'height': 900})
                await context.add_init_script("""
                  window.microphoneRequests=0;window.fixtureTracks=[];window.peers=[];
                  navigator.mediaDevices.getUserMedia=async()=>{
                    window.microphoneRequests++;
                    const t={enabled:true,readyState:'live',stop(){this.readyState='ended'}};
                    window.fixtureTracks.push(t);return {getTracks:()=>[t],getAudioTracks:()=>[t]};
                  };
                  navigator.mediaDevices.enumerateDevices=async()=>[];
                  window.RTCPeerConnection=class {
                    constructor(){window.peers.push(this);this.connectionState='new';this.iceGatheringState='complete';this.channel={readyState:'open',close(){}};}
                    addTrack(track){this.tracks??=[];this.tracks.push(track);} addTransceiver(kind,init){this.direction=init.direction;}
                    createDataChannel(){return this.channel;}
                    async createOffer(){return {type:'offer',sdp:'v=0'};}
                    async setLocalDescription(d){this.localDescription=d;}
                    async setRemoteDescription(d){this.remoteDescription=d;}
                    close(){this.connectionState='closed';}
                  };
                  window.Audio=class {pause(){} async play(){}};
                  window.connectLatest=()=>{const p=window.peers[window.peers.length-1];p.connectionState='connected';p.onconnectionstatechange();p.channel.onmessage({data:JSON.stringify({type:'session.started'})});};
                """)
                page = await context.new_page()
                page.set_default_timeout(10000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(f'http://127.0.0.1:{server.server_port}/review.html')

                async def appearance():
                    if not await page.locator('.companion-popover').is_visible():
                        await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                    await page.get_by_role('button', name='꾸미기', exact=True).click()

                # Opening appearance for the first time during a call used to skip
                # the catalog entirely, leaving only the engine-default option.
                await page.get_by_role('button', name='통화하기', exact=True).click()
                await page.wait_for_function('window.peers.length===1')
                await page.evaluate('window.connectLatest()')
                await appearance()
                await page.wait_for_function("document.querySelector('.companion-voice select').options.length===4")
                assert await page.get_by_role('button', name='목록 새로고침', exact=True).is_enabled()
                assert await page.get_by_role('button', name='목소리 미리듣기', exact=True).is_disabled()
                await page.get_by_role('button', name='목록 새로고침', exact=True).click()
                await page.wait_for_function("window.actions.filter(a=>a.action==='list').length===2")
                assert await page.evaluate("window.peers[0].connectionState==='connected'")
                checks.append('first appearance during an active call loads and refreshes voices without changing the peer')
                await page.get_by_role('button', name='대화·작업', exact=True).click()
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()
                await page.reload()

                await appearance()
                choice = page.get_by_role('combobox', name='비서 목소리', exact=True)
                await page.wait_for_function("document.querySelector('[aria-label=\"비서 목소리\"]').options.length===4")
                await choice.select_option('cedar')
                await page.reload()
                await appearance()
                await page.wait_for_function("!document.querySelector('[aria-label=\"비서 목소리\"]').disabled")
                assert await choice.input_value() == 'cedar'
                checks.append('runtime catalog loads and chosen voice survives reload')

                # Regression (K 2026-11-07, installed v0.7.79): opening the menu from the minimized
                # companion never requested the catalog, leaving only the engine default.
                await page.evaluate("localStorage.setItem('kda_companion_layout_v1', JSON.stringify({minimized:true}))")
                await page.reload()
                before = await page.evaluate("window.actions.filter(a=>a.action==='list').length")
                if await page.get_by_role('button', name='비서 창 펼치기', exact=True).count() == 0:
                    await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).wait_for()
                await page.get_by_role('button', name='O2 비서 아바타 · 기능 열기', exact=True).click()
                await page.get_by_role('button', name='꾸미기', exact=True).click()
                await page.wait_for_function(f"window.actions.filter(a=>a.action==='list').length>{before}")
                await page.wait_for_function("document.querySelector('[aria-label=\"비서 목소리\"]').options.length===4")
                await page.get_by_role('button', name='비서 기능 접기', exact=True).click()
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).click()
                checks.append('menu opened from the minimized companion still loads the voice catalog')
                await appearance()
                await page.wait_for_function("!document.querySelector('[aria-label=\"비서 목소리\"]').disabled")

                await page.get_by_role('button', name='목소리 미리듣기', exact=True).click()
                await page.wait_for_function("window.actions.some(a=>a.action==='start'&&a.preview)")
                assert await page.evaluate('window.microphoneRequests') == 0
                assert await page.evaluate("window.peers[0].tracks.length===1 && window.peers[0].tracks[0].kind==='audio'")
                assert await page.evaluate("window.actions.find(a=>a.action==='start').voice") == 'cedar'
                await page.evaluate('window.connectLatest()')
                await page.wait_for_function("window.actions.some(a=>a.action==='speak')")
                await page.evaluate("window.peers[0].channel.onmessage({data:JSON.stringify({type:'output_transcript.added'})})")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.mood==='speaking'")
                checks.append('preview forwards selected voice, sends synthetic silence, opens no microphone and animates the avatar')
                await page.get_by_role('button', name='비서 기능 접기', exact=True).click()
                await page.wait_for_function("window.peers[0].connectionState==='closed'")
                assert await page.evaluate("window.peers[0].tracks.every(t=>t.readyState==='ended')")
                checks.append('closing the menu tears down preview resources')

                await appearance()
                await page.get_by_role('button', name='목소리 미리듣기', exact=True).click()
                await page.wait_for_function('window.peers.length===2')
                await page.get_by_role('button', name='통화하기', exact=True).click()
                await page.wait_for_function("window.actions.some(a=>a.action==='start'&&!a.preview)")
                assert await page.evaluate('window.peers[1].connectionState') == 'closed'
                assert await page.evaluate('window.microphoneRequests') == 1
                await page.evaluate('window.connectLatest()')
                await appearance()
                assert await page.get_by_role('button', name='목소리 미리듣기', exact=True).is_disabled()
                await choice.select_option('coral')
                assert await page.evaluate("window.actions.filter(a=>a.action==='start'&&!a.preview).length") == 1
                assert await page.evaluate("window.actions.find(a=>a.action==='start'&&!a.preview).voice") == 'cedar'
                assert await page.evaluate('window.peers[2].connectionState') == 'connected'
                checks.append('starting a call cancels preview; changing voice during the call preserves the existing peer')
                await page.get_by_role('button', name='대화·작업', exact=True).click()
                await page.get_by_role('button', name='통화 종료', exact=True).click()
                await page.get_by_role('button', name='다시 연결', exact=True).click()
                await page.wait_for_function("window.actions.filter(a=>a.action==='start'&&!a.preview).length===2")
                assert await page.evaluate("window.actions.filter(a=>a.action==='start'&&!a.preview)[1].voice") == 'coral'
                checks.append('the newly selected voice takes effect on reconnect')
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()

                await appearance()
                await page.evaluate('window.voiceCatalogError=true')
                await page.get_by_role('button', name='목록 새로고침', exact=True).click()
                await page.get_by_role('alert').wait_for()
                assert 'fixture catalog unavailable' in await page.get_by_role('alert').inner_text()
                await page.evaluate('window.voiceCatalogError=false')
                await page.get_by_role('button', name='목록 새로고침', exact=True).click()
                await page.wait_for_function("!document.querySelector('[role=alert]')")
                checks.append('catalog failure is visible and explicit refresh recovers')
                await page.screenshot(path=str(OUT / 'voice-settings.png'))
                for width, height in [(390, 844), (360, 480)]:
                    await page.set_viewport_size({'width': width, 'height': height})
                    await choice.select_option('marin')
                    assert await choice.input_value() == 'marin'
                    await page.get_by_role('button', name='목소리 미리듣기', exact=True).click()
                    await page.get_by_role('button', name='미리듣기 중지', exact=True).click()
                    await page.screenshot(path=str(OUT / f'voice-settings-{width}.png'))
                checks.append('voice selection and preview controls remain usable at narrow sizes')
                assert not errors, errors
                result['status'] = 'PASS'
            finally:
                await browser.close()
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        raise
    finally:
        server.shutdown()
        result.update(pageErrors=errors, finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        (OUT / 'voice-ui-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': result.get('status'), 'checks': len(checks)}))


if __name__ == '__main__':
    asyncio.run(main())
