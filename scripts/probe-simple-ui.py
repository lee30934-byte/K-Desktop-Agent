"""Verify the real UI components in headless Edge with blocked native/media access."""
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
OUT = ROOT / os.environ.get('KDA_SIMPLE_UI_EVIDENCE', 'evidence/simple-ui-20261106')


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, errors = [], []
    result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': checks,
              'installed': False, 'nativeTransport': 'fixture', 'hardwareAudioUsed': False}
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                context = await browser.new_context(viewport={'width': 1440, 'height': 900})
                # Never access the user's devices, clipboard, account or native database.
                await context.add_init_script("""navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('fixture denied','NotAllowedError')};
                    navigator.mediaDevices.enumerateDevices=async()=>[{kind:'audioinput',deviceId:'fixture-mic',groupId:'fixture',label:'예시 마이크'}];
                    navigator.clipboard.writeText=async text=>{window.copied=text};""")
                page = await context.new_page()
                page.set_default_timeout(10000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.route('https://fonts.googleapis.com/**', lambda route: route.abort())
                await page.goto(f'http://127.0.0.1:{server.server_port}/review.html')
                widget = page.get_by_role('complementary', name='K 비서', exact=True)
                await widget.wait_for()
                await page.locator('.main-chat').get_by_text('자주 쓰는 기능만 보여주고 나머지는 접어두자.', exact=True).wait_for()
                assert await page.get_by_role('button', name='통화하기', exact=True).is_visible()
                assert await page.get_by_title('전체 백업', exact=True).count() == 1
                assert not await page.get_by_title('전체 백업', exact=True).is_visible()
                assert not await page.get_by_role('button', name='도구 호출 보기', exact=True).is_visible()
                assert not await widget.get_by_role('button', name='현재 대화 연결', exact=True).is_visible()
                checks.append('primary call and target visible; backup, tools and connection controls collapsed')
                await page.screenshot(path=str(OUT / 'default.png'))

                await page.get_by_label('대화 옵션', exact=True).click()
                await page.get_by_role('button', name='복사', exact=False).click()
                assert '자주 쓰는 기능' in await page.evaluate('window.copied')
                await page.get_by_role('button', name='도구 호출 보기', exact=True).click()
                await page.get_by_role('button', name='도구 호출 숨기기', exact=True).wait_for()
                assert await page.evaluate("localStorage.getItem('kda_show_tool_cards')") == '1'
                await page.locator('.msg-tool-compact').wait_for()
                await page.get_by_role('button', name='도구 호출 숨기기', exact=True).click()
                assert await page.evaluate("localStorage.getItem('kda_show_tool_cards')") == '0'
                await page.locator('.msg-tool-compact').wait_for(state='detached')
                await page.get_by_label('대화 옵션', exact=True).click()
                checks.append('chat options retain real copy and tool-visibility toggle paths')

                backup = page.locator('.sidebar-backup')
                await backup.locator('summary').focus()
                await page.keyboard.press('Enter')
                await page.get_by_title('전체 백업', exact=True).wait_for()
                await backup.locator('summary').click()
                checks.append('backup disclosure is keyboard-accessible and restores every action')

                await page.get_by_role('button', name='통화하기', exact=True).click()
                voice = page.get_by_role('region', name='AI 비서 음성통화')
                await voice.get_by_role('alert').wait_for()
                assert not await page.get_by_role('combobox', name='통화 마이크', exact=True).is_visible()
                await voice.get_by_text('음성·장치 설정', exact=True).click()
                assert await page.get_by_role('combobox', name='통화 마이크', exact=True).is_visible()
                gain = page.get_by_role('slider', name='KDA 음성 크기')
                assert await gain.get_attribute('max') == '500'
                await gain.fill('200')
                assert await page.evaluate("localStorage.getItem('kda_voice_output_gain')") == '2'
                await gain.fill('500')
                assert await page.evaluate("localStorage.getItem('kda_voice_output_gain')") == '5'
                assert await voice.locator('.voice-call-volume output').inner_text() == '500%'
                checks.append('device controls open on demand and output-gain adjustment persists')

                await page.evaluate("window.renderSimpleUI('other')")
                await voice.locator('.voice-call-target').filter(has_text='다른 대화').wait_for()
                assert '현재 대화 따라가기' in await voice.locator('.voice-call-target').inner_text()
                route = page.get_by_role('combobox', name='음성 명령 대상', exact=True)
                assert await route.input_value() == ''
                assert await route.locator('option').count() == 3
                await page.screenshot(path=str(OUT / 'voice-target.png'))
                await page.get_by_role('button', name='음성통화 닫기', exact=True).click()
                assert not await voice.count()
                checks.append('default routing follows the visible conversation and exposes explicit target choices')

                more = widget.locator('.assistant-widget-more')
                await more.locator(':scope > summary').click()
                bridge = widget.locator('.assistant-widget-connection details')
                await bridge.locator('summary').click()
                await page.get_by_role('button', name='현재 대화 연결', exact=True).click()
                await page.get_by_text('DOT 연결 · 켜짐', exact=True).wait_for()
                await more.locator(':scope > summary').click()
                await page.evaluate("window.requests.push({id:'collapsed-request',session:window.info.session,conversationId:'other',createdAt:Date.now(),action:'send',text:'fixture',mode:'queue'})")
                await page.wait_for_function('window.replies.length===1')
                assert await page.evaluate('window.replies[0].result.state') == 'submitted'
                assert await page.evaluate("window.actions.some(a=>a.id==='other'&&a.text==='fixture')")
                checks.append('collapsed activity/connection controls preserve dispatcher and paired destination')

                await page.get_by_role('button', name='비서 창 최소화', exact=True).click()
                assert not await page.get_by_role('button', name='통화하기', exact=True).is_visible()
                await page.get_by_role('button', name='비서 창 펼치기', exact=True).click()
                checks.append('widget minimize/restore remains available')
                for width, height in [(360, 380), (1024, 650)]:
                    await page.set_viewport_size({'width': width, 'height': height})
                    await page.wait_for_function("""() => {const b=document.querySelector('.assistant-widget').getBoundingClientRect();
                        return b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;}""")
                    await page.screenshot(path=str(OUT / f'viewport-{width}.png'))
                checks.append('assistant controls fit both short/narrow and desktop viewports')
                assert not errors, errors
                result['status'] = 'PASS'
            finally:
                await browser.close()
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        raise
    finally:
        server.shutdown()
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        result['pageErrors'] = errors
        (OUT / 'ui-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': result.get('status'), 'checks': len(checks)}))


if __name__ == '__main__':
    asyncio.run(main())
