"""Actual widget in an isolated headless browser; native actions are recorded fixtures."""
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
EVIDENCE = ROOT / os.environ.get('KDA_WIDGET_EVIDENCE', 'evidence/assistant-widget-20261105')
KEY = 'kda_assistant_widget_v1'


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    checks = []
    errors = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(EVIDENCE)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    record = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': checks,
              'nativeTransport': 'fixture', 'liveDot': False, 'installed': False}
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(channel='msedge', headless=True)
            try:
                page = await browser.new_page(viewport={'width': 1440, 'height': 900})
                await page.add_init_script("navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('fixture microphone denied','NotAllowedError')}")
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(f'http://127.0.0.1:{server.server_port}/review.html')
                widget = page.get_by_role('complementary', name='O2 비서', exact=True)
                handle = page.get_by_role('group', name='비서 창 이동 · 방향키 이동 · Home 기본 위치', exact=True)
                await widget.wait_for()
                await page.get_by_text('DOT 연결 · 꺼짐', exact=True).wait_for(state='attached')
                assert not await page.get_by_role('button', name='현재 대화 연결', exact=True).is_visible()
                box = await widget.bounding_box()
                assert box['x'] > 1000 and box['y'] == 24, box
                assert await page.get_by_role('button', name='Telegram', exact=True).count() == 1
                checks.append('default upper-right placement and Telegram action')
                await page.screenshot(path=str(EVIDENCE / 'expanded.png'))

                await page.get_by_role('button', name='통화하기', exact=False).click()
                await page.get_by_role('region', name='AI 비서 음성통화').wait_for()
                await page.get_by_role('alert').filter(has_text='마이크 사용이 차단됐습니다').wait_for()
                assert not await page.evaluate('window.actions.some(a=>a.open)')
                assert await page.get_by_role('button', name='다시 연결', exact=True).is_visible()
                await page.screenshot(path=str(EVIDENCE / 'voice-panel.png'))
                await page.evaluate("""() => {
                    window.fixtureDeviceReads = 0; window.fixtureCaptureCalls = 0; window.fixtureDevices = [];
                    navigator.mediaDevices.enumerateDevices = async () => { window.fixtureDeviceReads++; return window.fixtureDevices; };
                    navigator.mediaDevices.getUserMedia = async () => { window.fixtureCaptureCalls++; throw new DOMException('Requested device not found', 'NotFoundError'); };
                }""")
                await page.get_by_role('button', name='다시 연결', exact=True).click()
                await page.get_by_role('alert').filter(has_text='사용 가능한 기본 마이크').wait_for()
                assert '원격 데스크톱' in await page.get_by_role('alert').inner_text()
                await page.locator('.voice-call > small[role="status"]').filter(has_text='현재 앱에서 보이는 마이크가 없습니다.').wait_for()
                await page.get_by_text('음성·장치 설정', exact=True).click()
                capture_calls = await page.evaluate('window.fixtureCaptureCalls')
                await page.get_by_role('button', name='장치 새로고침', exact=True).click()
                await page.wait_for_function('window.fixtureDeviceReads >= 2')
                assert await page.evaluate('window.fixtureCaptureCalls') == capture_calls
                checks.append('missing default microphone explains Windows input and RDP recording; refresh never captures audio')

                await page.evaluate("""() => {
                    window.fixtureDevices = [{ kind:'audioinput', deviceId:'test-mic', groupId:'fixture', label:'시험 마이크' }];
                    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
                }""")
                microphone = page.get_by_role('combobox', name='통화 마이크', exact=True)
                await microphone.locator('option[value="test-mic"]').wait_for(state='attached')
                await microphone.select_option('test-mic')
                await page.evaluate("""() => { window.fixtureDevices = []; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); }""")
                await microphone.get_by_text('선택한 마이크 · 연결 확인 필요', exact=True).wait_for(state='attached')
                assert await microphone.input_value() == 'test-mic'
                assert await page.evaluate('window.fixtureCaptureCalls') == capture_calls
                checks.append('device plug/unplug refreshes options and retains explicit missing input without silently choosing another microphone')
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()
                checks.append('call opens internal voice controls; microphone failure is visible, resources close, and no external navigation occurs')

                await page.get_by_role('button', name='Telegram', exact=True).click()
                assert await page.evaluate('window.actions[window.actions.length-1].settings') is True
                await page.evaluate("localStorage.setItem('kda_telegram_conv_id','telegram-fixture')")
                await page.get_by_role('button', name='Telegram', exact=True).click()
                assert await page.evaluate('window.actions[window.actions.length-1].select') == 'telegram-fixture'
                checks.append('Telegram selects its existing conversation or opens settings')
                await widget.locator('.assistant-widget-more > summary').click()
                await page.get_by_role('button', name='KDA 연결 상태 점검 대화', exact=True).click()
                assert await page.evaluate('window.actions[window.actions.length-1].select') == 'release-fixture'
                await page.get_by_role('button', name='최근 답변', exact=False).click()
                assert await page.evaluate('window.actions[window.actions.length-1].select') == '11111111-1111-4111-8111-111111111111'
                checks.append('recent activity and latest answer target the correct conversation')

                # Real pointer sequence with capture; buttons in the header remain independent.
                origin = await widget.bounding_box()
                h = await handle.bounding_box()
                identity = await widget.locator('.assistant-widget-identity').bounding_box()
                await page.mouse.move(identity['x'] + 20, identity['y'] + 10)
                await page.mouse.down()
                await page.mouse.move(identity['x'] + 20 - 300, identity['y'] + 10 + 75, steps=8)
                await page.mouse.up()
                moved = await widget.bounding_box()
                assert abs(moved['x'] - (origin['x'] - 300)) < 2 and abs(moved['y'] - (origin['y'] + 75)) < 2, moved
                assert await page.get_by_role('button', name='비서 창 최소화', exact=True).is_visible()
                checks.append('expanded card drags without triggering minimize')
                await handle.focus()
                await page.keyboard.press('ArrowLeft')
                shifted = await widget.bounding_box()
                assert abs(shifted['x'] - (moved['x'] - 12)) < 2
                await page.reload()
                await widget.wait_for()
                restored = await widget.bounding_box()
                assert abs(restored['x'] - shifted['x']) < 2 and abs(restored['y'] - shifted['y']) < 2
                checks.append('keyboard positioning and persisted position survive reload')

                await widget.locator('.assistant-widget-more > summary').click()
                await widget.locator('.assistant-widget-connection summary').click()
                await page.get_by_role('button', name='현재 대화 연결', exact=True).click()
                await page.get_by_text('DOT 연결 · 켜짐', exact=True).wait_for()
                await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                assert not await page.get_by_role('button', name='Telegram', exact=True).is_visible()
                small = await widget.bounding_box()
                assert small['width'] <= 234 and small['height'] < 90, small
                checks.append('minimize collapses into a compact shortcut')
                await page.evaluate("window.renderAssistantFixture('other-tab')")
                await page.evaluate('''() => window.requests.push({id:'minimized-send',session:window.info.session,
                  conversationId:window.info.conversationId,createdAt:Date.now(),action:'send',text:'fixture',mode:'steer'})''')
                await page.wait_for_function('window.replies.length===1')
                assert await page.evaluate('window.replies[0].result.state') == 'submitted'
                assert await page.evaluate('window.actions[0].id') == '11111111-1111-4111-8111-111111111111'
                checks.append('minimized dispatcher remains mounted and preserves paired target across tabs')
                h = await handle.bounding_box()
                identity = await widget.locator('.assistant-widget-identity').bounding_box()
                await page.mouse.move(identity['x'] + 20, identity['y'] + 10)
                await page.mouse.down()
                await page.mouse.move(0, 0, steps=6)
                await page.mouse.up()
                small = await widget.bounding_box()
                assert small['x'] >= 8 and small['y'] >= 8, small
                checks.append('compact shortcut drags and clamps at viewport edge')
                await page.screenshot(path=str(EVIDENCE / 'minimized.png'))
                await page.reload()
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).wait_for()
                checks.append('minimized preference persists across reload')
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).click()
                await page.set_viewport_size({'width': 360, 'height': 380})
                await page.wait_for_function('''() => {const b=document.querySelector('.assistant-widget').getBoundingClientRect();
                  return b.x>=8 && b.y>=8 && b.right<=innerWidth-7 && b.bottom<=innerHeight-7;}''')
                # The body scrolls, retaining access to connection controls on short screens.
                await widget.locator('.assistant-widget-more > summary').click()
                await page.get_by_role('button', name='오른쪽 위로 되돌리기', exact=True).click()
                await page.wait_for_function("document.querySelector('.assistant-widget').getBoundingClientRect().top === 8")
                await page.screenshot(path=str(EVIDENCE / 'small-viewport.png'))
                checks.append('resize and expansion remain reachable in a short narrow viewport')
                await handle.focus()
                await page.keyboard.press('Home')
                saved = await page.evaluate(f'JSON.parse(localStorage.getItem({json.dumps(KEY)}))')
                assert saved['position'] is None
                checks.append('Home and reset action return to default placement')

                await page.set_viewport_size({'width': 1440, 'height': 900})
                await page.evaluate(f"localStorage.setItem({json.dumps(KEY)},'malformed')")
                await page.reload()
                await page.get_by_role('button', name='비서 창 최소화', exact=True).wait_for()
                await page.evaluate('window.renderAssistantFixture(null,true)')
                await page.get_by_text('아직 활동이 없습니다.', exact=True).wait_for(state='attached')
                await page.get_by_text('아직 결과물이 없습니다.', exact=True).wait_for()
                checks.append('malformed preferences and empty conversations recover safely')
                await page.add_init_script("Storage.prototype.getItem=function(){throw Error('disabled storage')};Storage.prototype.setItem=function(){throw Error('disabled storage')}")
                await page.reload()
                await page.get_by_role('button', name='비서 창 최소화', exact=True).wait_for()
                await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).wait_for()
                assert not errors, errors
                checks.append('widget works with browser storage disabled and no page errors')
                record['status'] = 'PASS'
            finally:
                await browser.close()
    except Exception as error:
        record.update(status='FAIL', error=str(error))
        raise
    finally:
        server.shutdown()
        record['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (EVIDENCE / 'ui-verification.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': record.get('status'), 'checks': len(checks)}))


if __name__ == '__main__':
    asyncio.run(main())
