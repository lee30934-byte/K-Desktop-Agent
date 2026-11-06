"""Measure the rendered rig in headless Edge, without native or account access."""
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
OUT = ROOT / os.environ.get('KDA_MOTION_EVIDENCE', 'evidence/companion-articulation-20261106/motion-v1')


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT.parent)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, errors = [], []
    result = dict(status='RUNNING', checks=checks, pageErrors=errors,
                  startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  installed=False, published=False, hardwareMediaUsed=False)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                context = await browser.new_context(viewport={'width': 1180, 'height': 820},
                                                    record_video_dir=str(OUT / 'recording'),
                                                    record_video_size={'width': 1180, 'height': 820})
                page = await context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.goto(f'http://127.0.0.1:{server.server_port}/{OUT.name}/review.html')
                avatar = page.locator('.companion-avatar')
                await avatar.wait_for()
                await page.wait_for_function("document.images.length===0 && getComputedStyle(document.querySelector('.companion-head')).backgroundImage.includes('ceramic')")
                # Measure head motion with body/root paused, so whole-image sway
                # cannot pass a test intended to prove independent articulation.
                await avatar.evaluate("e=>{for(const a of e.getAnimations({subtree:true})){a.pause();a.currentTime=0;}}")
                async def head_at(time):
                    await avatar.evaluate("(e,t)=>{for(const a of e.getAnimations({subtree:true})){if(a.effect.target.classList.contains('companion-head-motion'))a.currentTime=t;}}", time)
                    await page.wait_for_timeout(60)
                    return await avatar.screenshot()

                left = await head_at(2700)
                right = await head_at(7100)
                (OUT / 'head-left.png').write_bytes(left)
                (OUT / 'head-right.png').write_bytes(right)
                delta = ImageChops.difference(Image.open(io.BytesIO(left)).convert('RGB'), Image.open(io.BytesIO(right)).convert('RGB'))
                w, h = delta.size
                head_delta = sum(1 for px in delta.crop((0, 0, w, int(h * .6))).getdata() if max(px) > 12)
                feet_delta = sum(1 for px in delta.crop((0, int(h * .8), w, h)).getdata() if max(px) > 12)
                assert head_delta > 600 and feet_delta == 0, (head_delta, feet_delta)
                result['headOnlyPixelMeasurement'] = dict(headChangedPixels=head_delta, feetChangedPixels=feet_delta)
                checks.append('head visibly turns while body/root are held still; feet remain unchanged')

                box = await avatar.bounding_box()
                await page.mouse.move(box['x'] + box['width'] * .2, box['y'] + box['height'] * .3)
                await page.wait_for_timeout(420)
                look_left = await page.locator('.companion-head-look').evaluate('e=>getComputedStyle(e).transform')
                await page.mouse.move(box['x'] + box['width'] * .8, box['y'] + box['height'] * .3)
                await page.wait_for_timeout(420)
                look_right = await page.locator('.companion-head-look').evaluate('e=>getComputedStyle(e).transform')
                assert look_left != look_right
                await page.mouse.move(24, 24)
                assert await avatar.evaluate("e=>e.style.getPropertyValue('--companion-look-x')") == ''
                checks.append('pointer movement changes head orientation and leaving recenters it')

                await page.get_by_label('움직임 켜기', exact=False).uncheck()
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='off'")
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') == 0
                assert await page.locator('.companion-head-look').evaluate('e=>getComputedStyle(e).transform') == 'none'
                checks.append('motion switch stops all rig animation and pointer offset')
                await page.get_by_label('움직임 켜기', exact=False).check()
                await page.emulate_media(reduced_motion='reduce')
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='off'")
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') == 0
                await page.emulate_media(reduced_motion='no-preference')
                await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='off'")
                assert await avatar.evaluate('e=>e.getAnimations({subtree:true}).length') == 0
                await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))")
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.motion==='on'")
                checks.append('OS reduced motion and hidden documents stop the rig; visibility resumes it')

                animation_names = {}
                for mood in ['listening', 'speaking', 'muted', 'error', 'idle']:
                    await page.get_by_label('미리보기 상태', exact=True).select_option(mood)
                    await page.wait_for_function('(m)=>document.querySelector(".companion-avatar").dataset.mood===m', arg=mood)
                    animation_names[mood] = await page.locator('.companion-head-motion').evaluate('e=>getComputedStyle(e).animationName')
                    await page.screenshot(path=str(OUT / f'{mood}.png'))
                assert len(set(animation_names.values())) == 5, animation_names
                result['headAnimations'] = animation_names
                checks.append('idle/listening/speaking/muted/error have distinct head motion')
                for mood in ['thinking', 'working']:
                    await page.get_by_label('미리보기 상태', exact=True).select_option(mood)
                    await page.wait_for_function('(m)=>document.querySelector(".companion-avatar").dataset.mood===m', arg=mood)
                    assert await avatar.get_attribute('data-rig') == 'whole'
                    assert await page.locator('.companion-head').count() == 0
                checks.append('crossing arms and tablet poses preserve the original complete image')

                await page.get_by_label('미리보기 상태', exact=True).select_option('idle')
                await page.get_by_role('button', name='인사', exact=True).click()
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.frame==='4'")
                assert await page.locator('.companion-head-motion').evaluate('e=>getComputedStyle(e).animationName') == 'companion-head-greet'
                await page.wait_for_function("document.querySelector('.companion-avatar').dataset.frame==='0'")
                checks.append('requested greeting articulates the head and returns to idle')
                for width in [390, 760, 1180]:
                    await page.set_viewport_size({'width': width, 'height': 820})
                    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                    await page.screenshot(path=str(OUT / f'review-{width}.png'))
                checks.append('motion review stays inside narrow and desktop viewports')

                await page.mouse.move(24, 24)
                await page.wait_for_timeout(10200)
                await context.close()
                await page.video.save_as(str(OUT / 'motion-preview.webm'))
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
        (OUT / 'motion-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(status=result['status'], checks=len(checks))))


if __name__ == '__main__':
    asyncio.run(main())
