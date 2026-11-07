"""Check real elapsed animation and pause feedback with isolated native stubs."""
import asyncio
import datetime
import functools
import io
import json
import os
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageChops
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
    result = dict(status='RUNNING', checks=checks, pageErrors=errors, installed=False,
                  published=False, hardwareMediaUsed=False,
                  startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                context = await browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='no-preference')
                page = await context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.goto(f'http://127.0.0.1:{server.server_port}/review.html')
                avatar = page.locator('.companion-avatar')
                await page.wait_for_function('()=>document.querySelector(".companion-avatar")?.dataset.motionState==="playing"')
                await page.wait_for_timeout(300)
                first = await avatar.screenshot(animations='allow')
                initial = await avatar.evaluate('e=>e.getAnimations({subtree:true}).filter(a=>a.animationName!=="companion-pose-in").map(a=>({name:a.animationName,time:a.currentTime,state:a.playState}))')
                await page.wait_for_timeout(800)
                second = await avatar.screenshot(animations='allow')
                later = await avatar.evaluate('e=>e.getAnimations({subtree:true}).filter(a=>a.animationName!=="companion-pose-in").map(a=>({name:a.animationName,time:a.currentTime,state:a.playState}))')
                assert initial and all(a['state'] == 'running' for a in initial), initial
                assert all(a['time'] > b['time'] + 500 for a, b in zip(later, initial)), (initial, later)
                delta = ImageChops.difference(Image.open(io.BytesIO(first)).convert('RGB'), Image.open(io.BytesIO(second)).convert('RGB'))
                pixels = delta.tobytes()
                changed = sum(max(pixels[i:i + 3]) > 12 for i in range(0, len(pixels), 3))
                assert changed > 600, changed
                result['elapsedPixelChange'] = changed
                (OUT / 'elapsed-first.png').write_bytes(first)
                (OUT / 'elapsed-second.png').write_bytes(second)
                checks.append('default idle moves in actual elapsed time, including visible pixel change')
                await page.wait_for_function('()=>document.querySelector(".companion-avatar").dataset.frame!=="0"', timeout=15500)
                checks.append('automatic idle reaction appears within the randomized 7-14 second window without any click')

                await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                await page.get_by_role('button', name='꾸미기', exact=True).click()
                toggle = page.get_by_role('checkbox', name='대기모션·리액션 움직임', exact=True)
                await page.get_by_text('고개·눈·몸 움직임 켜짐', exact=True).wait_for()
                await toggle.uncheck()
                await page.get_by_text('움직임 꺼짐', exact=True).wait_for()
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') == 0
                await page.reload()
                await page.wait_for_function('()=>document.querySelector(".companion-avatar")?.dataset.motionState==="disabled"')
                await page.get_by_role('button', name='비서 메뉴', exact=True).click()
                await page.get_by_role('button', name='꾸미기', exact=True).click()
                assert not await toggle.is_checked()
                await toggle.check()
                await page.get_by_text('고개·눈·몸 움직임 켜짐', exact=True).wait_for()
                checks.append('explicit off persists and reports its state; enabling resumes animation')

                await page.emulate_media(reduced_motion='reduce')
                await page.wait_for_function('()=>document.querySelector(".companion-avatar").dataset.osReducedMotion==="true"')
                await page.get_by_text('고개·눈·몸 움직임 켜짐', exact=True).wait_for()
                assert await toggle.is_checked()
                assert await avatar.get_attribute('data-motion') == 'on'
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') > 0
                for name in ['인사', '기쁨', '갸웃']:
                    assert await page.get_by_role('button', name=name, exact=True).is_enabled()
                await page.screenshot(path=str(OUT / 'reduced-motion-override.png'))
                checks.append('switch ON overrides OS reduced motion (Windows animation effects off): rig animates, reactions enabled')
                await page.emulate_media(reduced_motion='no-preference')
                await page.get_by_text('고개·눈·몸 움직임 켜짐', exact=True).wait_for()
                await page.get_by_role('button', name='인사', exact=True).click()
                await page.wait_for_function('()=>document.querySelector(".companion-avatar").dataset.frame==="4"')
                assert await avatar.locator('.companion-pose:not(.is-leaving) .companion-head-motion').evaluate('e=>getComputedStyle(e).animationName') == 'companion-head-greet'
                checks.append('returning from reduced motion resumes the rig and greeting')

                await page.evaluate('()=>{Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));}')
                await page.get_by_text('화면을 다시 열면 움직여요', exact=True).wait_for()
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') == 0
                await page.evaluate('()=>{Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));}')
                await page.get_by_text('고개·눈·몸 움직임 켜짐', exact=True).wait_for()
                checks.append('hidden pause reports its reason and visibility resumes motion')
                await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') > 0
                await page.reload()
                await page.wait_for_function('()=>document.querySelector(".companion-avatar")?.dataset.motionState==="playing"')
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') > 0
                checks.append('compact mode and restored preferences keep the rig moving')
                assert not await page.evaluate('window.actions.some(a=>a.voice==="start"||a.voice==="preview"||a.text)'), 'unexpected media/work call'
                assert not errors, errors
                result['status'] = 'PASS'
            finally:
                await browser.close()
    except Exception as e:
        result.update(status='FAIL', error=str(e))
        raise
    finally:
        server.shutdown()
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (OUT / 'motion-state-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(status=result['status'], checks=len(checks))))


if __name__ == '__main__':
    asyncio.run(main())
