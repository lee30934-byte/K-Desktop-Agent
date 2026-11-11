"""Actual avatar/widget components, headless Edge, synthetic media, no account access."""
import asyncio
import datetime
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path(__file__).resolve().parents[1] / 'evidence/avatar-motion-20261106'


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    checks, errors = [], []
    result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'checks': checks, 'nativeTransport': 'fixture', 'installed': False, 'hardwareAudioUsed': False}
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                page = await browser.new_page(viewport={'width': 1440, 'height': 900})
                page.on('pageerror', lambda e: errors.append(str(e)))
                base = f'http://127.0.0.1:{server.server_port}'
                await page.goto(base + '/review.html')
                await page.locator('.assistant-avatar').first.wait_for()
                assert await page.locator('.assistant-avatar').count() == 4
                await page.screenshot(path=str(OUT / 'avatars.png'))
                for kind in ['robot', 'cat', 'sprout', 'cloud']:
                    a = page.locator('.avatar-' + kind)
                    for reaction in ['wave', 'happy', 'curious', 'sleepy']:
                        await a.click()
                        assert await a.get_attribute('data-reaction') == reaction
                checks.append('four original SVGs render and all sixteen click reactions are reachable')
                for mood in ['working', 'connecting', 'listening', 'thinking', 'speaking', 'muted', 'error', 'idle']:
                    await page.get_by_label('미리보기 상태', exact=True).select_option(mood)
                    assert await page.locator(f'.assistant-avatar[data-mood="{mood}"]').count() == 4
                await page.wait_for_timeout(2700)
                before = await page.locator('.avatar-cat .avatar-tail').evaluate('(e)=>getComputedStyle(e).transform')
                await page.wait_for_timeout(400)
                after = await page.locator('.avatar-cat .avatar-tail').evaluate('(e)=>getComputedStyle(e).transform')
                assert before != after, (before, after)
                checks.append('eight preview states and actual idle tail movement render')
                await page.emulate_media(reduced_motion='reduce')
                assert await page.evaluate('document.getAnimations().length') == 0
                await page.screenshot(path=str(OUT / 'reduced-motion.png'))
                checks.append('OS reduced-motion removes all running avatar animations')
                await page.emulate_media(reduced_motion='no-preference')
                await page.get_by_role('checkbox').uncheck()
                assert await page.evaluate('document.getAnimations().length') == 0
                await page.set_viewport_size({'width': 390, 'height': 844})
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                await page.screenshot(path=str(OUT / 'gallery-mobile.png'), full_page=True)
                checks.append('gallery motion toggle and narrow viewport work without horizontal overflow')

                await page.set_viewport_size({'width': 1440, 'height': 900})
                await page.add_init_script("""
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
                await page.goto(base + '/ui/review.html')
                avatar = page.locator('.assistant-avatar')
                await avatar.wait_for()
                widget = page.get_by_role('complementary', name='O2 비서', exact=True)
                original_position = await widget.bounding_box()
                await avatar.click()
                assert await avatar.get_attribute('data-reaction') == 'wave'
                assert await widget.bounding_box() == original_position
                await page.get_by_text('아바타 꾸미기', exact=True).click()
                choices = page.get_by_role('group', name='아바타 선택', exact=True)
                for name, kind in [('로봇', 'robot'), ('고양이', 'cat'), ('새싹', 'sprout'), ('구름', 'cloud')]:
                    button = choices.get_by_role('button').filter(has_text=name)
                    await button.click()
                    assert await button.get_attribute('aria-pressed') == 'true'
                    assert 'avatar-' + kind in await avatar.get_attribute('class')
                await page.get_by_role('checkbox', name='대기모션·리액션 움직임', exact=True).uncheck()
                await page.reload()
                await page.wait_for_function("document.querySelector('.assistant-avatar')?.dataset.motion==='off'")
                assert 'avatar-cloud' in await avatar.get_attribute('class')
                await avatar.click()
                assert await page.evaluate('document.getAnimations().length') == 0
                checks.append('avatar clicks never drag; four selections and motion preference persist across reload')
                await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                assert 'is-compact' in await avatar.get_attribute('class')
                await avatar.click()
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).click()
                await page.get_by_text('아바타 꾸미기', exact=True).click()
                await page.get_by_role('checkbox', name='대기모션·리액션 움직임', exact=True).check()
                await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))")
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.motion==='off'")
                await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))")
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.motion==='on'")
                await page.evaluate('window.renderAssistantFixture(undefined,false,true)')
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.mood==='working'")
                checks.append('compact avatar, hidden-document pause, and actual running-task state work')
                await page.get_by_text('아바타 꾸미기', exact=True).click()
                await page.evaluate("""() => {
                  const original=window.dotInvoke;
                  window.nativeCalls=[];
                  window.dotInvoke=async(cmd,args)=>{
                    if(cmd==='voice_control') {
                      window.nativeCalls.push(args);
                      if(args.action==='extend')window.voiceListener({payload:{type:'voice_event',sessionId:args.sessionId,kind:'lease',token:args.token,expiresAt:Date.now()+600000}});
                    }
                    return original(cmd,args);
                  };
                }""")
                await page.get_by_role('button', name='통화하기', exact=True).click()
                await page.wait_for_function("window.nativeCalls.some(c=>c.action==='start')")
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.mood==='connecting'")
                await page.evaluate("""() => {
                  const peer=window.fixturePeer;peer.connectionState='connected';peer.onconnectionstatechange();
                  window.voiceData=e=>peer.channel.onmessage({data:JSON.stringify(e)});
                  window.voiceData({type:'session.started'});
                }""")
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.mood==='listening'")
                await page.get_by_role('button', name='음소거', exact=True).click()
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.mood==='muted'")
                await page.get_by_role('button', name='마이크 켜기', exact=True).click()
                await page.evaluate("window.voiceData({type:'input_transcript.added'});window.voiceData({type:'turn.done',turn:{id:'u',role:'user',transcript:'안녕'}})")
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.mood==='thinking'")
                await page.evaluate("window.voiceData({type:'output_transcript.added'})")
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.mood==='speaking'")
                assert await avatar.locator('.avatar-mouth').evaluate('(e)=>getComputedStyle(e).display') != 'none'
                await page.evaluate("window.voiceData({type:'turn.done',turn:{role:'assistant',transcript:'안녕하세요'}})")
                checks.append('actual voice lifecycle drives connecting, listening, muted, thinking and speaking expressions')
                await page.get_by_role('button', name='5분 연장', exact=True).click()
                await page.get_by_text('통화 시간이 연장됐어요.', exact=True).wait_for()
                assert await page.get_by_role('button', name='5분 연장', exact=True).is_disabled()
                assert await page.evaluate("window.nativeCalls.filter(c=>c.action==='start').length") == 1
                assert await page.evaluate("window.nativeCalls.filter(c=>c.action==='extend').length") == 1
                assert not await page.evaluate("window.nativeCalls.some(c=>c.action==='stop')")
                await page.screenshot(path=str(OUT / 'widget-voice.png'))
                checks.append('five-minute UI renewal is acknowledged without reconnect, duplicate click or work submission')
                await page.evaluate("""() => {const sessionId=window.nativeCalls[0].sessionId;window.voiceListener({payload:{type:'voice_event',sessionId,kind:'error',message:'fixture disconnect'}})}""")
                await page.wait_for_function("document.querySelector('.assistant-avatar').dataset.mood==='error'")
                assert await page.evaluate("window.fixtureTracks.every(t=>t.readyState==='ended')")
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()
                await page.set_viewport_size({'width': 360, 'height': 380})
                await page.wait_for_function("document.querySelector('.assistant-widget').getBoundingClientRect().bottom<=innerHeight")
                await page.get_by_role('button', name='통화하기', exact=True).scroll_into_view_if_needed()
                assert await page.get_by_role('button', name='통화하기', exact=True).is_visible()
                await page.screenshot(path=str(OUT / 'widget-small.png'))
                checks.append('disconnect displays error, releases media, and controls remain reachable on short screens')
                assert not errors, errors
                result.update(status='PASS', pageErrors=errors)
            finally:
                await browser.close()
    except Exception as e:
        result.update(status='FAIL', error=str(e), pageErrors=errors)
        raise
    finally:
        server.shutdown()
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (OUT / 'avatar-ui.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': result.get('status'), 'checks': len(checks)}))


if __name__ == '__main__':
    asyncio.run(main())
