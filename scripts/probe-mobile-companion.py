"""Real production mobile bundle + real desktop bridge + isolated work handlers.
No production DB, user browser, paid provider, physical microphone or OS settings.
"""
import asyncio
import datetime
import json
import os
from pathlib import Path
import subprocess

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ.get('KDA_MOBILE_EVIDENCE', 'evidence/mobile-companion-20261106/ui-v1')


async def main():
    checks, errors = [], []
    result = dict(status='RUNNING', checks=checks, pageErrors=errors, installed=False,
                  networkPublished=False, realPhoneQA=False, realVoiceQA=False,
                  media='Chromium synthetic microphone only',
                  startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    proc = await asyncio.create_subprocess_exec('node', 'scripts/mobile-fixture-host.mjs', cwd=ROOT,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                creationflags=subprocess.CREATE_NO_WINDOW)
    def check(name, condition):
        assert condition, name
        checks.append(name)
    try:
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=15)
        addresses = json.loads(line)
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True, args=[
                '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
            try:
                context = await browser.new_context(viewport={'width': 1180, 'height': 820})
                desktop = await context.new_page()
                desktop.on('pageerror', lambda e: errors.append('desktop: ' + str(e)))
                await desktop.goto(addresses['desktopOrigin'] + '/desktop.html')
                await desktop.get_by_label('휴대폰 접속 HTTPS 주소').fill(addresses['mobileOrigin'])
                await desktop.get_by_role('button', name='휴대폰 연결 켜기', exact=True).click()
                await desktop.locator('code').wait_for()
                code = await desktop.locator('code').inner_text()
                check('desktop settings enable loopback and expose single-use code', len(code) == 43)

                phone_context = await browser.new_context(viewport={'width': 390, 'height': 844},
                                                         is_mobile=True, has_touch=True, device_scale_factor=1)
                await phone_context.grant_permissions(['microphone'], origin=addresses['mobileOrigin'])
                phone = await phone_context.new_page()
                phone.on('pageerror', lambda e: errors.append('phone: ' + str(e)))
                # Every page request must remain local; audio devices are synthetic.
                await phone_context.route('**/*', lambda route: route.continue_() if route.request.url.startswith('http://127.0.0.1:') else route.abort())
                await phone.goto(addresses['mobileOrigin'])
                await phone.get_by_label('연결 코드', exact=True).fill('invalid')
                await phone.get_by_role('button', name='PC 연결하기').click()
                await phone.get_by_role('alert').filter(has_text='잘못된').wait_for()
                check('wrong pairing code remains on pairing screen', await phone.get_by_role('button', name='PC 연결하기').is_visible())
                await phone.get_by_label('연결 코드', exact=True).fill(code)
                await phone.get_by_role('button', name='PC 연결하기').click()
                await phone.get_by_label('명령할 대화', exact=True).wait_for()
                await phone.wait_for_function("() => document.querySelectorAll('#conversation option').length===3")
                check('real HTTP pair and desktop conversation relay', True)
                check('explicit target required before sending', await phone.get_by_role('button', name='명령 보내기').is_disabled())
                await phone.get_by_label('명령할 대화', exact=True).select_option('11111111-1111-4111-8111-111111111111')
                await phone.get_by_text('PC의 최근 결과 · 대화별 설정 유지', exact=True).wait_for()
                avatar = phone.locator('.companion-avatar')
                await phone.wait_for_function("() => document.querySelector('.companion-head-motion')!==null")
                check('layered avatar reused by phone in idle pose', await avatar.get_attribute('data-rig') == 'layered')
                loaded = await phone.evaluate("""async()=>{const layers=[...document.querySelectorAll('.companion-avatar .companion-pose:not(.is-leaving) .companion-layer')];
                  const urls=[...new Set(layers.map(e=>getComputedStyle(e).backgroundImage.match(/url\(\"?([^\")]+)/)?.[1]).filter(Boolean))];
                  const out=[];for(const u of urls){const r=await fetch(u);
                    const ok=await new Promise(res=>{const i=new Image();i.onload=()=>res(i.naturalWidth);i.onerror=()=>res(0);i.src=u;});
                    out.push({u:u.split('/').pop(),status:r.status,type:r.headers.get('content-type'),width:ok});}return out;}""")
                result_layers = loaded
                check('phone avatar layer images load (HTTP 200, image/webp, decoded, one resolution tier)', len(loaded) >= 3 and all(x['status'] == 200 and x['type'] == 'image/webp' and x['width'] in (1500, 1020, 690, 480) for x in loaded) and len({x['width'] for x in loaded}) == 1)
                await phone.get_by_label('텍스트로 명령').fill('휴대폰 연결 검증')
                await phone.get_by_role('button', name='명령 보내기').click()
                await phone.get_by_text('모의 PC 결과: 휴대폰 연결 검증', exact=True).wait_for(timeout=15000)
                trace = await desktop.evaluate('window.fixtureTrace')
                check('one remote send reaches shared desktop handler once', len(trace) == 1 and trace[0]['id'].startswith('11111111') and trace[0]['mode'] == 'queue')
                await phone.screenshot(path=str(OUT / 'mobile-390.png'), full_page=True)
                for width, height in [(320, 780), (430, 932), (844, 390)]:
                    await phone.set_viewport_size({'width': width, 'height': height})
                    check(f'no horizontal clipping at {width}x{height}', await phone.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                await phone.set_viewport_size({'width': 390, 'height': 844})
                avatar = phone.locator('.companion-avatar')
                check('working pose keeps the tablet in a front layer', await avatar.locator('.companion-pose:not(.is-leaving) .companion-front').count() == 1)
                await phone.get_by_text('목소리와 움직임', exact=True).click()
                await phone.get_by_label('아바타 움직임', exact=True).uncheck()
                await phone.wait_for_function("() => document.querySelector('.companion-avatar').dataset.motion==='off'")
                check('motion off stops phone avatar', True)
                await phone.get_by_label('아바타 움직임', exact=True).check()
                await phone.get_by_label('음성 변조', exact=True).select_option('robot')
                check('six existing voice effect choices', await phone.locator('#effect option').count() == 6)

                await phone.get_by_label('명령할 대화', exact=True).select_option('22222222-2222-4222-8222-222222222222')
                await phone.get_by_label('텍스트로 명령').fill('승인 확인 <img src=x onerror=alert(1)>')
                await phone.get_by_role('button', name='명령 보내기').click()
                await phone.get_by_text('PC에서 확인이 필요한 요청이 있습니다.', exact=False).wait_for(timeout=15000)
                trace = await desktop.evaluate('window.fixtureTrace')
                check('target switch stays bound to chosen conversation', trace[-1]['id'].startswith('22222222'))
                check('result HTML rendered as text, not executable markup', await phone.locator('.answer img').count() == 0 and '<img' in await phone.locator('.answer').inner_text())
                check('approval is visible and not bypassed by phone', await phone.get_by_text('PC에서 확인이 필요한 요청이 있습니다.', exact=False).is_visible())
                await phone.get_by_role('button', name='현재 작업 정지', exact=True).click()
                await phone.get_by_text('현재 대화 작업 정지를 확인했습니다.', exact=False).wait_for()
                trace = await desktop.evaluate('window.fixtureTrace')
                check('stop routes through desktop conversation stop handler', trace[-1] == {'action': 'stop', 'id': '22222222-2222-4222-8222-222222222222'})

                await phone.get_by_role('button', name='음성으로 대화', exact=True).click()
                await phone.get_by_text('격리 시험: 실제 음성 엔진은 연결하지 않았습니다.', exact=False).wait_for(timeout=20000)
                check('synthetic mic voice offer and owned error return over real transport', True)
                await phone.reload()
                await phone.get_by_label('명령할 대화', exact=True).wait_for()
                check('tab reload restores bounded session without reusing pairing secret', await phone.locator('#pair-code').count() == 0)
                await desktop.get_by_role('button', name='모든 휴대폰 연결 해제', exact=True).click()
                await phone.get_by_role('alert').filter(has_text='PC에 연결할 수 없습니다.').wait_for(timeout=15000)
                check('PC disable closes transport and disables command controls', await phone.get_by_role('button', name='현재 작업 정지').is_disabled() and await phone.get_by_role('button', name='음성으로 대화').is_disabled())
                await desktop.get_by_role('button', name='휴대폰 연결 켜기', exact=True).click()
                await phone.get_by_role('button', name='PC 연결하기').wait_for(timeout=15000)
                check('re-enabled PC rejects old session and requires new pairing', await phone.locator('#command').count() == 0)
                await desktop.get_by_role('button', name='모든 휴대폰 연결 해제', exact=True).click()
                await desktop.screenshot(path=str(OUT / 'desktop-connection.png'), full_page=True)
                check('no browser runtime errors', not errors)
                result['status'] = 'PASS'
                await phone_context.close()
            except Exception:
                if 'phone' in locals():
                    await phone.screenshot(path=str(OUT / 'failure.png'), full_page=True)
                    (OUT / 'failure-body.txt').write_text(await phone.locator('body').inner_text(), encoding='utf-8')
                    trace_response = await desktop.request.get(addresses['desktopOrigin'] + '/fixture/trace')
                    (OUT / 'failure-trace.json').write_text(await trace_response.text(), encoding='utf-8')
                raise
            finally:
                await browser.close()
    except Exception as e:
        result['status'] = 'FAIL'; result['error'] = repr(e)
        raise
    finally:
        if proc.returncode is None:
            proc.terminate()
        await proc.wait()
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (OUT / 'ui-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': result['status'], 'checks': len(checks), 'errors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
