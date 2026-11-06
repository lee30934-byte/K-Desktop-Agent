"""User-visible effect preferences and the live session controller, with synthetic media only."""
import asyncio
import functools
import json
import os
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ.get('KDA_WIDGET_EVIDENCE', 'evidence/voice-effects-20261106/ui-v1')


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    result = dict(status='RUNNING', checks=[], hardwareAudioUsed=False, installed=False, published=False)
    checks = result['checks']
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True,
                                             args=['--autoplay-policy=no-user-gesture-required', '--mute-audio'])
            try:
                context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
                await context.add_init_script('''
                  window.peers=[];window.microphoneRequests=0;
                  window.effectNodes=[];const NativeWorklet=window.AudioWorkletNode;
                  window.AudioWorkletNode=class extends NativeWorklet {constructor(...args){super(...args);window.effectNodes.push(this);}};
                  navigator.mediaDevices.getUserMedia=async()=>{window.microphoneRequests++;throw Error('Hardware media prohibited')};
                  navigator.mediaDevices.enumerateDevices=async()=>[];
                  window.RTCPeerConnection=class{
                    constructor(){window.peers.push(this);this.connectionState='new';this.iceGatheringState='complete';this.channel={readyState:'open',close(){}};}
                    addTrack(){}addTransceiver(){}createDataChannel(){return this.channel;}
                    async createOffer(){return {type:'offer',sdp:'v=0'};}
                    async setLocalDescription(d){this.localDescription=d;}
                    async setRemoteDescription(d){this.remoteDescription=d;}
                    close(){this.connectionState='closed';}
                  };
                  window.connectPreview=async()=>{
                    window.toneContext=new AudioContext();const osc=window.toneContext.createOscillator();
                    const level=window.toneContext.createGain(),dest=window.toneContext.createMediaStreamDestination();
                    osc.frequency.value=220;level.gain.value=.03;osc.connect(level).connect(dest);osc.start();
                    window.syntheticStream=dest.stream;await window.toneContext.resume();
                    const peer=window.peers[window.peers.length-1];peer.ontrack({streams:[dest.stream]});
                    peer.connectionState='connected';peer.onconnectionstatechange();peer.channel.onmessage({data:JSON.stringify({type:'session.started'})});
                  };
                ''')
                page = await context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(f'http://127.0.0.1:{server.server_port}/review.html')

                async def appearance():
                    if not await page.locator('.companion-popover').is_visible():
                        await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                    await page.get_by_role('button', name='꾸미기', exact=True).click()

                await appearance()
                strength = page.get_by_role('slider', name='음성 변조 강도', exact=True)
                assert await strength.is_disabled()
                await page.get_by_role('button', name='작은 로봇', exact=True).click()
                await strength.fill('75')
                await page.reload()
                await appearance()
                assert await page.get_by_role('button', name='작은 로봇', exact=True).get_attribute('aria-pressed') == 'true'
                assert await strength.input_value() == '75'
                checks.append('original voice is the default; preset and strength survive reload')

                # Real output processing attached to the same receive-only preview session.
                await page.get_by_role('button', name='목소리 미리듣기', exact=True).click()
                await page.wait_for_function("window.actions.some(a=>a.action==='start'&&a.preview)")
                await page.evaluate('window.connectPreview()')
                await page.wait_for_function("window.actions.some(a=>a.action==='speak')")
                assert await page.evaluate('window.microphoneRequests') == 0
                await page.get_by_role('button', name='발랄하게', exact=True).click()
                await strength.fill('40')
                await page.wait_for_function("window.effectNodes.length&&Math.abs(window.effectNodes[window.effectNodes.length-1].parameters.get('semitones').value-1.2)<.02")
                assert await page.evaluate("window.actions.filter(a=>a.action==='start').length") == 1
                assert await page.evaluate("window.peers[0].connectionState") == 'connected'
                await page.get_by_role('button', name='미리듣기 중지', exact=True).click()
                checks.append('preview uses synthetic receive audio; changing effects preserves its peer and requests no microphone')
                await page.get_by_role('button', name='원음', exact=True).click()
                assert await strength.is_disabled()
                checks.append('one-click original voice disables modulation strength')

                # Exercise a live VoiceSession through the real product UI.
                await page.evaluate('''() => {
                  navigator.mediaDevices.getUserMedia=async()=>window.syntheticStream;
                }''')
                await page.get_by_role('button', name='통화하기', exact=True).click()
                await page.wait_for_function("window.actions.some(a=>a.action==='start'&&!a.preview)")
                await page.evaluate('''() => {
                  const peer=window.peers[window.peers.length-1];peer.ontrack({streams:[window.syntheticStream]});
                  peer.connectionState='connected';peer.onconnectionstatechange();peer.channel.onmessage({data:JSON.stringify({type:'session.started'})});
                }''')
                await appearance()
                await page.get_by_role('button', name='차분하게', exact=True).click()
                await strength.fill('65')
                await page.wait_for_function("window.effectNodes.length===2&&Math.abs(window.effectNodes[1].parameters.get('semitones').value+1.95)<.02")
                await page.get_by_text('음색·강도는 지금 통화에 바로 적용돼요.', exact=True).wait_for()
                assert await page.evaluate("window.actions.filter(a=>a.action==='start'&&!a.preview).length") == 1
                assert await page.evaluate("window.peers[window.peers.length-1].connectionState") == 'connected'
                assert await page.evaluate("window.actions.filter(a=>a.action==='stop').length") == 1  # ended preview only
                checks.append('live call accepts effect changes without a restart or native stop')
                await page.get_by_role('button', name='대화·작업', exact=True).click()
                await page.get_by_role('button', name='통화 종료', exact=True).click()
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()
                await appearance()
                await page.get_by_role('button', name='작은 로봇', exact=True).click()
                await page.locator('.companion-voice-card').scroll_into_view_if_needed()
                await page.screenshot(path=str(OUT / 'voice-effects-settings.png'))
                for width, height in [(390, 844), (360, 480)]:
                    await page.set_viewport_size({'width': width, 'height': height})
                    await page.get_by_role('button', name='무전기', exact=True).click()
                    await strength.fill('35')
                    assert await strength.input_value() == '35'
                    await page.screenshot(path=str(OUT / f'voice-effects-{width}.png'))
                checks.append('effect buttons and strength remain reachable in narrow windows')
                assert not errors, errors
                result.update(status='PASS', pageErrors=errors)
            finally:
                await browser.close()
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        raise
    finally:
        server.shutdown()
        (OUT / 'effect-ui-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(status=result['status'], checks=len(checks))))


if __name__ == '__main__':
    asyncio.run(main())
