"""Verify the layered companion rig, motion, lip-sync, tones and widget layout.

Measured in a real Chromium (msedge) page with native stubs; no microphone/speaker.
Usage: KDA_WIDGET_EVIDENCE=<fixture dir> py -3 scripts/probe-companion-rig.py
"""
import asyncio
import colorsys
import datetime
import functools
import io
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ['KDA_WIDGET_EVIDENCE']
ATLAS = ROOT / 'src' / 'assets' / 'companion'

STUBS = """
  window.peers=[];
  navigator.mediaDevices.getUserMedia=async()=>{const t={enabled:true,readyState:'live',stop(){this.readyState='ended'}};return {getTracks:()=>[t],getAudioTracks:()=>[t]};};
  navigator.mediaDevices.enumerateDevices=async()=>[];
  window.RTCPeerConnection=class{constructor(){window.peers.push(this);this.connectionState='new';this.iceGatheringState='complete';this.channel={readyState:'open',close(){}};}
    addTrack(){} addTransceiver(){} createDataChannel(){return this.channel;} async createOffer(){return {type:'offer',sdp:'v=0'};}
    async setLocalDescription(d){this.localDescription=d;} async setRemoteDescription(d){this.remoteDescription=d;} close(){this.connectionState='closed';}};
  window.Audio=class{pause(){} async play(){}};
  window.connectLatest=()=>{const p=window.peers[window.peers.length-1];p.connectionState='connected';p.onconnectionstatechange();p.channel.onmessage({data:JSON.stringify({type:'session.started'})});};
"""


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def png(b):
    return Image.open(io.BytesIO(b)).convert('RGB')


def changed(a, b, threshold=14):
    d = np.abs(np.asarray(a, np.int16) - np.asarray(b, np.int16)).max(axis=2)
    return int((d > threshold).sum())


def atlas_borders():
    """Transparent padding per cell. Reduced tiers (name.<tier>.webp) keep the same padding, scaled."""
    report = {}
    for f in sorted(ATLAS.glob('*.webp')):
        a = np.asarray(Image.open(f).convert('RGBA'))[..., 3]
        cell = a.shape[0] // 3
        k = cell / 500
        top, bottom, side = int(30 * k) - 1, int(20 * k) - 1, int(10 * k) - 1
        bad = 0
        for r in range(3):
            for c in range(3):
                x = a[r * cell:(r + 1) * cell, c * cell:(c + 1) * cell]
                bad += int((x[:top] > 8).sum() + (x[-bottom:] > 8).sum() + (x[:, :side] > 8).sum() + (x[:, -side:] > 8).sum())
        report[f.name] = bad
    return report


def sharpness(img):
    """Mean |Laplacian|: invariant to rigid motion, so its variation over time = resampling shimmer."""
    g = np.asarray(img.convert('L'), np.float32)
    return float(np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]).mean())


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/review.html'
    checks, errors, metrics = [], [], {}
    result = dict(status='RUNNING', checks=checks, metrics=metrics, pageErrors=errors, installed=False, published=False,
                  hardwareMediaUsed=False, startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    try:
        borders = atlas_borders()
        metrics['atlasBorderPixels'] = borders
        assert borders and all(v == 0 for v in borders.values()), borders
        assert len(borders) == 44, sorted(borders)
        checks.append('atlas: every pose cell keeps transparent padding (top 30px, bottom 20px, sides 10px; scaled in tiers) in all 44 sheets')

        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                context = await browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='no-preference')
                await context.add_init_script(STUBS)
                page = await context.new_page()
                page.set_default_timeout(10000)
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.goto(url)
                await page.wait_for_function('()=>document.querySelector(".companion-avatar")?.dataset.motionState==="playing"')

                # --- antenna never clipped by an ancestor or the viewport (closed / open / minimized)
                clip_js = """()=>{const g=[...document.querySelectorAll('.companion-widget .companion-pose:not(.is-leaving)')].pop();
                  const rig=g.closest('.companion-rig').getBoundingClientRect();const glow=g.querySelector('.companion-antenna-glow').getBoundingClientRect();
                  const clips=[];for(let e=g.parentElement;e;e=e.parentElement){const s=getComputedStyle(e);
                    if(s.overflow!=='visible'||s.clipPath!=='none'){const r=e.getBoundingClientRect();
                      if(rig.top<r.top||rig.left<r.left||rig.right>r.right||rig.bottom>r.bottom)clips.push(e.className||e.tagName);}}
                  return {glowTop:glow.top,glowLeft:glow.left,glowRight:glow.right,rigTop:rig.top,clips,vw:innerWidth};}"""
                states = {}
                for name, action in [('closed', None), ('open', 'open'), ('minimized', 'min')]:
                    if action == 'open':
                        await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                    if action == 'min':
                        await page.get_by_role('button', name='비서 기능 접기', exact=True).click()
                        await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                    await page.wait_for_timeout(250)
                    info = await page.evaluate(clip_js)
                    states[name] = info
                    assert not info['clips'], (name, info)
                    assert info['glowTop'] >= 0 and info['glowLeft'] >= 0 and info['glowRight'] <= info['vw'], (name, info)
                    await page.locator('.companion-widget').screenshot(path=str(OUT / f'widget-{name}.png'))
                metrics['antennaClip'] = states
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).click()
                checks.append('widget: antenna glow stays inside the viewport and no ancestor clips the rig (closed, open, minimized)')

                # --- widget layout: no duplicate bubble, controls below the figure, chat avoids the widget
                layout_js = """()=>{const w=document.querySelector('.companion-widget').getBoundingClientRect();
                  const m=document.querySelector('.messages');const ms=getComputedStyle(m);const mr=m.getBoundingClientRect();
                  const c=document.querySelector('.composer-wrapper').getBoundingClientRect();
                  const a=document.querySelector('.companion-widget .companion-avatar').getBoundingClientRect();
                  const k=document.querySelector('.companion-controls').getBoundingClientRect();
                  return {widgetLeft:w.left,widgetBottom:w.bottom,messagesContentRight:mr.right-parseFloat(ms.paddingRight),
                    composerRight:c.right,composerTop:c.top,avatarTop:a.top,avatarBottom:a.bottom,controlsTop:k.top,
                    bubble:!!document.querySelector('.companion-bubble'),reserve:document.documentElement.hasAttribute('data-companion-reserve')};}"""
                closed = await page.evaluate(layout_js)
                assert closed['bubble'] and closed['reserve'], closed
                assert closed['messagesContentRight'] <= closed['widgetLeft'], closed
                assert closed['controlsTop'] >= closed['avatarTop'] + 0.9 * (closed['avatarBottom'] - closed['avatarTop']), closed
                await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                await page.wait_for_timeout(250)
                opened = await page.evaluate(layout_js)
                assert not opened['bubble'], opened
                assert opened['messagesContentRight'] <= opened['widgetLeft'], opened
                if opened['widgetBottom'] > opened['composerTop']:
                    assert opened['composerRight'] <= opened['widgetLeft'], opened
                metrics['layout'] = {'closed': closed, 'open': opened}
                await page.screenshot(path=str(OUT / 'page-open.png'))
                checks.append('widget: open panel hides the duplicate bubble; messages and composer end left of the widget')
                checks.append('widget: quick controls sit below the figure (not on the torso)')

                # --- dangerous call button needs a second press
                await page.get_by_role('button', name='음성으로 이야기하기').click()
                await page.wait_for_function('window.peers.length===1')
                await page.evaluate('window.connectLatest()')
                stop_all = page.locator('.voice-call-stop-all')
                await stop_all.wait_for()
                await page.wait_for_function('!document.querySelector(".voice-call-stop-all").disabled')
                bg_all = await stop_all.evaluate('e=>getComputedStyle(e).backgroundColor')
                bg_status = await page.get_by_role('button', name='상태 묻기').evaluate('e=>getComputedStyle(e).backgroundColor')
                assert bg_all != bg_status, (bg_all, bg_status)
                await stop_all.click()
                await page.wait_for_timeout(200)
                assert not await page.evaluate('window.actions.some(a=>a.stopAll)')
                assert '한 번 더' in await stop_all.inner_text()
                await page.wait_for_timeout(4200)
                assert '한 번 더' not in await stop_all.inner_text()
                await stop_all.click(); await stop_all.click()
                await page.wait_for_function('window.actions.some(a=>a.stopAll)')
                metrics['stopAllColours'] = {'stopAll': bg_all, 'status': bg_status}
                await page.locator('.voice-call').screenshot(path=str(OUT / 'call-panel.png'))
                checks.append('call: "전체 작업 정지" is styled apart from status, needs a second press within 4s, and expires back')
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()

                # --- per-state motion at the smallest size (112px), real elapsed time
                moods = ['idle', 'listening', 'thinking', 'speaking', 'working', 'connecting', 'muted', 'error']
                await page.evaluate('items=>window.renderAvatarGallery(items,true)', [{'mood': m} for m in moods])
                await page.wait_for_timeout(700)
                figs = page.locator('#avatar-gallery figure .companion-avatar')
                first = [png(await figs.nth(i).screenshot(animations='allow')) for i in range(len(moods))]
                await page.wait_for_timeout(900)
                second = [png(await figs.nth(i).screenshot(animations='allow')) for i in range(len(moods))]
                motion = {m: changed(a, b) for m, a, b in zip(moods, first, second)}
                heads = await page.evaluate("""()=>[...document.querySelectorAll('#avatar-gallery .companion-avatar')].map(a=>
                  [...a.querySelectorAll('.companion-pose:not(.is-leaving) .companion-head-motion')].map(h=>h.getAnimations()[0]?.animationName||'none')[0])""")
                metrics['compactMotionChangedPixels'] = motion
                metrics['headAnimations'] = dict(zip(moods, heads))
                assert all(v >= 250 for v in motion.values()), motion
                assert all(h and h != 'none' for h in heads), heads
                assert metrics['headAnimations']['working'] == 'companion-head-read'
                assert metrics['headAnimations']['thinking'] == 'companion-head-think'
                checks.append('motion: every state (incl. working/thinking/connecting) moves the head and changes >=250 px at 112px in 0.9s')

                # --- anti-shimmer: resolution tier, no filter in the animated subtree, composited layers, stable sharpness
                render = await page.evaluate("""()=>{const a=document.querySelector('#avatar-gallery .companion-avatar');const rig=a.querySelector('.companion-rig');
                  const els=[...a.querySelectorAll('.companion-rig, .companion-rig *')];
                  return {cell:+rig.dataset.sheetCell,width:rig.getBoundingClientRect().width*devicePixelRatio,
                    filtered:els.filter(e=>getComputedStyle(e).filter!=='none').map(e=>e.className),
                    notComposited:[...a.querySelectorAll('.companion-head-motion,.companion-eyes,.companion-gaze,.companion-layer')].filter(e=>getComputedStyle(e).willChange!=='transform').length}}""")
                metrics['renderTier'] = render
                assert render['cell'] == 160 and render['cell'] <= render['width'] * 1.55, render
                assert not render['filtered'] and render['notComposited'] == 0, render
                # Measure 'listening' (index 1): idle swaps to random reaction poses every 7-14 s and a pose
                # change alters sharpness itself, which read as shimmer (1.2 -> 4.8% inside one run).
                # Median of 3 windows guards against host CPU load;
                # the pre-fix shimmer was 4.5-5.9%, so the median keeps the gate discriminating.
                rounds = []
                for _ in range(3):
                    vals = []
                    for _ in range(20):
                        vals.append(sharpness(png(await figs.nth(1).screenshot(animations='allow'))))
                        await page.wait_for_timeout(60)
                    rounds.append(float(np.std(vals) / np.mean(vals) * 100))
                cv = float(np.median(rounds))
                metrics['compactShimmerCvPct'] = round(cv, 2)
                metrics['compactShimmerCvRoundsPct'] = [round(r, 2) for r in rounds]
                assert cv < 3.0, rounds
                checks.append('shimmer: 112px uses the 160px tier, no CSS filter in the rig, moving layers composited, sharpness CV median-of-3 < 3% while animating')

                # --- blink + gaze
                await page.evaluate('items=>window.renderAvatarGallery(items)', [{'mood': 'idle'}])
                closed_eye = await page.wait_for_function("""()=>{const e=document.querySelector('#avatar-gallery .companion-pose:not(.is-leaving) .companion-eyes');
                  const d=new DOMMatrix(getComputedStyle(e).transform).d;return d<0.5?d:false;}""", polling='raf', timeout=9000)
                min_scale = await closed_eye.json_value()
                await page.wait_for_function('document.querySelector("#avatar-gallery .companion-avatar").style.getPropertyValue("--cp-gaze-x")!==""', timeout=6000)
                metrics['blinkMinScaleY'] = min_scale
                assert min_scale < 0.5, min_scale
                checks.append('eyes: blink closes the eye layer (scaleY < 1) and idle gaze offsets are applied')

                # --- crossfade on pose change
                await page.evaluate('items=>window.renderAvatarGallery(items)', [{'mood': 'idle'}])
                await page.wait_for_timeout(200)
                await page.evaluate('items=>window.renderAvatarGallery(items)', [{'mood': 'working'}])
                leaving = await page.evaluate('document.querySelectorAll("#avatar-gallery .companion-pose.is-leaving").length')
                fade = await page.evaluate("""()=>document.querySelector('#avatar-gallery .companion-pose:not(.is-leaving)').getAnimations().map(a=>a.animationName)""")
                await page.wait_for_timeout(450)
                after = await page.evaluate('document.querySelectorAll("#avatar-gallery .companion-pose").length')
                assert leaving == 1 and 'companion-pose-in' in fade and after == 1, (leaving, fade, after)
                checks.append('transition: previous pose stays under the new pose while it fades in, then is removed')

                # --- lip-sync follows the output level
                await page.evaluate('items=>window.renderAvatarGallery(items)', [{'mood': 'speaking'}])
                mouth_js = """()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('#avatar-gallery .companion-pose:not(.is-leaving) .companion-mouth')).transform);
                  return {sy:m.d,src:document.querySelector('#avatar-gallery .companion-avatar').dataset.levelSource};}"""
                await page.evaluate('window.setFixtureLevel(0)'); await page.wait_for_timeout(500)
                quiet = await page.evaluate(mouth_js)
                await page.evaluate('window.setFixtureLevel(1)'); await page.wait_for_timeout(300)
                loud = await page.evaluate(mouth_js)
                await page.evaluate('window.setFixtureLevel(null)'); await page.wait_for_timeout(300)
                synth = await page.evaluate(mouth_js)
                metrics['lipSync'] = {'quiet': quiet, 'loud': loud, 'noOutput': synth}
                assert quiet['src'] == 'output' and loud['src'] == 'output' and synth['src'] == 'synthetic', metrics['lipSync']
                assert quiet['sy'] < 0.4 and loud['sy'] > 0.95, metrics['lipSync']
                checks.append('lip-sync: mouth opens with real output loudness (0 -> scaleY<0.4, 1 -> >0.95); synthetic only without output')

                # --- tones recolour the shell only
                await page.evaluate('items=>window.renderAvatarGallery(items)', [{'mood': 'idle', 'style': s, 'motion': False} for s in ['mint', 'pearl', 'rose']])
                await page.wait_for_timeout(500)
                tones = {}
                for i, s in enumerate(['mint', 'pearl', 'rose']):
                    img = png(await page.locator('#avatar-gallery figure .companion-avatar').nth(i).screenshot())
                    w, h = img.size
                    torso = np.asarray(img.crop((int(w * .42), int(h * .74), int(w * .58), int(h * .82)))).reshape(-1, 3).mean(0)
                    hh, ll, ss = colorsys.rgb_to_hls(*(torso / 255))
                    tones[s] = {'rgb': [round(v) for v in torso], 'hue': round(hh * 360), 'sat': round(ss, 3)}
                metrics['tones'] = tones
                assert 20 <= tones['mint']['hue'] <= 45, tones
                assert tones['pearl']['sat'] < 0.12, tones
                assert 300 <= tones['rose']['hue'] <= 345, tones
                await page.locator('#avatar-gallery').screenshot(path=str(OUT / 'tones.png'))
                checks.append('tones: rose shell is pink (hue 300-345), pearl is near-neutral, mint keeps the approved ceramic')
                await context.close()

                # --- idle reactions: irregular, never doze on a cycle; doze only after 3 min idle
                context = await browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='no-preference')
                page = await context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.clock.install()
                await page.goto(url)
                await page.evaluate('items=>window.renderAvatarGallery(items)', [{'mood': 'idle'}])
                await page.evaluate("""()=>{window.frameLog=[];const a=document.querySelector('#avatar-gallery .companion-avatar');
                  new MutationObserver(()=>window.frameLog.push([Date.now(),a.dataset.frame])).observe(a,{attributes:true,attributeFilter:['data-frame']});}""")
                for _ in range(120):
                    await page.clock.run_for(1000)
                log = await page.evaluate('window.frameLog')
                starts = [t for t, f in log if f != '0']
                gaps = [round((b - a) / 1000, 1) for a, b in zip(starts, starts[1:])]
                frames = sorted({f for _, f in log})
                metrics['reactions120s'] = {'count': len(starts), 'gapsSeconds': gaps, 'frames': frames}
                assert len(starts) >= 7 and '6' not in frames, metrics['reactions120s']
                assert len(set(gaps)) > 2, gaps
                for _ in range(65):
                    await page.clock.run_for(1000)
                doze = await page.evaluate('[document.querySelector("#avatar-gallery .companion-avatar").dataset.frame,document.querySelector("#avatar-gallery .companion-sleep")!==null]')
                await page.mouse.click(5, 5)
                await page.clock.run_for(300)
                woke = await page.evaluate('document.querySelector("#avatar-gallery .companion-avatar").dataset.frame')
                metrics['doze'] = {'after185s': doze, 'afterClick': woke}
                assert doze == ['6', True] and woke != '6', metrics['doze']
                checks.append('reactions: irregular gaps, no doze in the first 2 minutes; doze (with z) only after 3 min idle, any click wakes')
                await context.close()

                # --- reduced motion: static, no blink loop
                context = await browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
                page = await context.new_page()
                await page.goto(url)
                await page.evaluate('items=>window.renderAvatarGallery(items)', [{'mood': 'working'}])
                await page.wait_for_timeout(300)
                a = png(await page.locator('#avatar-gallery .companion-avatar').screenshot())
                await page.wait_for_timeout(1200)
                b = png(await page.locator('#avatar-gallery .companion-avatar').screenshot())
                state = await page.evaluate('[document.querySelector("#avatar-gallery .companion-avatar").dataset.motionState, document.querySelector("#avatar-gallery .companion-avatar").dataset.osReducedMotion]')
                metrics['reducedMotionChangedPixels'] = changed(a, b)
                assert state == ['playing', 'true'] and changed(a, b) >= 250, (state, changed(a, b))
                checks.append('OS reduced motion (Windows animation effects off): switch ON still animates (>=250 px in 1.2s)')
            finally:
                await browser.close()
        assert not errors, errors
        result['status'] = 'PASS'
    except Exception as e:
        result['status'] = 'FAIL'
        result['error'] = repr(e)
        raise
    finally:
        server.shutdown()
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (OUT / 'rig-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
        print(json.dumps({k: result[k] for k in ('status', 'checks')} | {'error': result.get('error')}, ensure_ascii=False, indent=1))


asyncio.run(main())
