"""Exercise the single companion in headless Edge; no real media or native access."""
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
OUT = ROOT / os.environ['KDA_WIDGET_EVIDENCE']


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, errors = [], []
    result = dict(startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), checks=checks,
                  nativeTransport='fixture', hardwareAudioUsed=False, installed=False, published=False)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                context = await browser.new_context(viewport={'width': 1440, 'height': 900})
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
                page.set_default_timeout(10000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(f'http://127.0.0.1:{server.server_port}/review.html')
                widget = page.get_by_role('complementary', name='K 비서', exact=True)
                avatar = widget.locator('.companion-avatar')
                await avatar.wait_for()
                assert await avatar.count() == 1
                assert await widget.locator('.assistant-avatar').count() == 0
                assert not await widget.locator('.companion-popover').is_visible()
                sprite = await avatar.locator('.companion-sprite').evaluate("e=>getComputedStyle(e).backgroundImage")
                assert 'k-assistant-ceramic' in sprite
                checks.append('one bitmap companion renders with its menu initially closed')
                await page.screenshot(path=str(OUT / 'idle.png'))

                await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                await page.get_by_role('button', name='꾸미기', exact=True).click()
                await page.get_by_role('button', name='로즈 세라믹', exact=True).click()
                await page.get_by_role('checkbox', name='대기모션·리액션 움직임', exact=True).uncheck()
                await page.reload()
                await page.wait_for_function("document.querySelector('.companion-avatar')?.dataset.motion==='off'")
                assert 'tone-rose' in await avatar.get_attribute('class')
                await avatar.click()
                await page.get_by_role('button', name='꾸미기', exact=True).click()
                motion = page.get_by_role('checkbox', name='대기모션·리액션 움직임', exact=True)
                await motion.check()
                await page.get_by_role('button', name='기쁨', exact=True).click()
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.frame==='5'")
                await page.get_by_role('button', name='민트 세라믹', exact=True).click()
                checks.append('appearance and motion persist; requested reaction uses the same avatar')
                await page.screenshot(path=str(OUT / 'appearance.png'))
                await page.emulate_media(reduced_motion='reduce')
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='off'")
                await page.emulate_media(reduced_motion='no-preference')
                await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='off'")
                await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='on'")
                checks.append('reduced motion and hidden-document pause disable animation')

                await page.get_by_role('button', name='비서 기능 접기', exact=True).click()
                before = await widget.bounding_box()
                box = await avatar.bounding_box()
                await page.mouse.move(box['x'] + box['width']/2, box['y'] + 65)
                await page.mouse.down()
                await page.mouse.move(box['x'] + box['width']/2 - 260, box['y'] + 105, steps=8)
                await page.mouse.up()
                after = await widget.bounding_box()
                assert abs(after['x'] - (before['x'] - 260)) < 2, (before, after)
                assert not await widget.locator('.companion-popover').is_visible()
                await widget.locator('.companion-stage').focus()
                await page.keyboard.press('ArrowLeft')
                shifted = await widget.bounding_box()
                assert abs(shifted['x'] - after['x'] + 12) < 2
                await page.reload()
                await avatar.wait_for()
                restored = await widget.bounding_box()
                assert abs(restored['x'] - shifted['x']) < 2
                checks.append('real pointer drag suppresses menu activation; keyboard and saved position work')

                # SVG targets inside the body controls must remain independent of drag.
                await page.get_by_role('button', name='비서 메뉴', exact=True).locator('svg').click()
                await page.get_by_role('button', name='연결', exact=True).click()
                await widget.locator('.companion-connections details > summary').click()
                await page.get_by_role('button', name='현재 대화 연결', exact=True).click()
                await page.get_by_text('DOT 연결 · 켜짐', exact=True).wait_for()
                await page.get_by_role('button', name='비서 기능 접기', exact=True).click()
                await page.evaluate("window.requests.push({id:'hidden-send',session:window.info.session,conversationId:window.info.conversationId,createdAt:Date.now(),action:'send',text:'fixture',mode:'queue'})")
                await page.wait_for_function('window.replies.length===1')
                assert await page.evaluate('window.replies[0].result.state') == 'submitted'
                checks.append('inline SVG button opens menu without dragging; hidden DOT dispatcher still executes')

                await page.evaluate("""() => {
                  const original=window.dotInvoke;window.nativeCalls=[];
                  window.dotInvoke=async(cmd,args)=>{
                    if(cmd==='voice_control'){
                      window.nativeCalls.push(args);
                      if(args.action==='extend')window.voiceListener({payload:{sessionId:args.sessionId,kind:'lease',token:args.token,expiresAt:Date.now()+600000}});
                    }
                    return original(cmd,args);
                  };
                }""")
                await page.get_by_role('button', name='통화하기', exact=True).locator('svg').click()
                await page.wait_for_function("window.nativeCalls.some(c=>c.action==='start')")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.mood==='connecting'")
                assert await widget.locator('.companion-bubble small span').inner_text() == '연결 중'
                await page.evaluate("const peer=window.fixturePeer;peer.connectionState='connected';peer.onconnectionstatechange();window.voiceData=e=>peer.channel.onmessage({data:JSON.stringify(e)});window.voiceData({type:'session.started'});")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.mood==='listening'")
                assert await widget.locator('.companion-bubble small span').inner_text() == '통화 중'
                await page.get_by_role('button', name='음소거', exact=True).click()
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.mood==='muted'")
                await page.get_by_role('button', name='마이크 켜기', exact=True).click()
                await page.evaluate("window.voiceData({type:'input_transcript.added'});window.voiceData({type:'turn.done',turn:{id:'u',role:'user',transcript:'안녕'}})")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.mood==='thinking'")
                await page.evaluate("window.voiceData({type:'output_transcript.added'})")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.mood==='speaking'")
                await page.evaluate("window.voiceData({type:'turn.done',turn:{role:'assistant',transcript:'안녕하세요'}})")
                checks.append('call button connects the real session controller and drives listening/mute/speaking states')

                await page.get_by_role('button', name='5분 연장', exact=True).click()
                await page.wait_for_function("window.nativeCalls.some(c=>c.action==='extend')")
                await page.get_by_role('button', name='연결', exact=True).click()
                await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                assert await page.evaluate("window.fixtureTracks.every(t=>t.readyState==='live')")
                assert await page.evaluate("window.nativeCalls.filter(c=>c.action==='stop').length") == 0
                await page.get_by_role('button', name='통화 조작 열기', exact=True).click()
                await page.get_by_role('button', name='통화 종료', exact=True).wait_for()
                assert await page.evaluate("window.nativeCalls.filter(c=>c.action==='start').length") == 1
                checks.append('extension, tab hiding and minimize preserve one active call and its media tracks')
                await page.screenshot(path=str(OUT / 'call.png'))
                await page.get_by_role('button', name='통화 종료', exact=True).click()
                await page.wait_for_function("window.fixtureTracks.every(t=>t.readyState==='ended')")
                assert await page.evaluate("window.nativeCalls.filter(c=>c.action==='stop').length") == 1
                if await page.get_by_role('button', name='비서 창 펼치기', exact=True).count():
                    await page.get_by_role('button', name='비서 창 펼치기', exact=True).click()
                assert await widget.locator('.companion-bubble small span').inner_text() == '통화 종료'
                checks.append('explicit call end stops tracks and dispatches one native stop')
                await page.get_by_role('button', name='통화 조작 열기', exact=True).click()
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()

                for width, height in [(360, 380), (390, 844), (1024, 650)]:
                    await page.set_viewport_size({'width': width, 'height': height})
                    if await page.get_by_role('button', name='비서 창 펼치기', exact=True).count():
                        await page.get_by_role('button', name='비서 창 펼치기', exact=True).click()
                    if not await widget.locator('.companion-popover').is_visible():
                        await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                    await page.wait_for_function("""() => {const b=document.querySelector('.companion-widget').getBoundingClientRect();return b.x>=7&&b.y>=7&&b.right<=innerWidth-7&&b.bottom<=innerHeight-7;}""")
                    await page.get_by_role('button', name='꾸미기', exact=True).click()
                    # A visible element can still be clipped by its scroll container.
                    # Actual clicks must reach and change the setting on each viewport.
                    await motion.uncheck()
                    await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='off'")
                    await motion.check()
                    await page.screenshot(path=str(OUT / f'viewport-{width}.png'))
                checks.append('expanded menu and appearance controls remain reachable in short/narrow viewports')
                assert not errors, errors
                result['status'] = 'PASS'
            finally:
                await browser.close()
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        raise
    finally:
        server.shutdown()
        result.update(finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), pageErrors=errors)
        (OUT / 'ui-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(status=result.get('status'), checks=len(checks))))


if __name__ == '__main__':
    asyncio.run(main())
