"""Actual React component in a disposable headless page; native transport is a fixture."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    evidence=Path(__file__).resolve().parents[1]/'evidence/dot-bridge-20261105'
    checks=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(channel='msedge',headless=True)
        try:
            page=await browser.new_page(viewport={'width':1100,'height':650})
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            await page.set_content('<html><meta charset="utf-8"><body style="background:#141820;color:#e0e5ee;font:15px sans-serif"><div id="root"></div></body></html>')
            await page.evaluate('''() => {
              window.actions=[];window.requests=[];window.replies=[];window.running=false;
              window.info={enabled:false,conversationId:null,session:null,root:'C:/fixture/dot-bridge',adapterPath:null};
              window.dotInvoke=async (command,args) => {
                if(command==='dot_bridge_info')return {...window.info};
                if(command==='dot_bridge_pair') {
                  window.info=args.conversationId ? {...window.info,enabled:true,conversationId:args.conversationId,
                    session:'22222222-2222-4222-8222-222222222222',adapterPath:'C:/fixture/adapter.mjs'} : {...window.info,enabled:false,conversationId:null,session:null};
                  return {...window.info};
                }
                if(command==='dot_bridge_poll')return window.requests.splice(0);
                if(command==='dot_bridge_reply'){window.replies.push(args);return null;}
                throw Error('unexpected native command: '+command);
              };
            }''')
            await page.add_script_tag(path=str(evidence/'ui-fixture.js'))
            await page.get_by_text('DOT 연결 · 꺼짐',exact=True).wait_for()
            await page.locator('summary').click()
            await page.get_by_role('button',name='현재 대화 연결',exact=True).click()
            await page.get_by_text('DOT 연결 · 켜짐',exact=True).wait_for()
            checks.append('default off and explicit pairing')
            await page.evaluate("window.renderDotFixture('33333333-3333-4333-8333-333333333333')")
            assert await page.evaluate('window.info.conversationId')=='11111111-1111-4111-8111-111111111111'
            checks.append('tab changes preserve paired conversation')
            await page.evaluate('''() => window.requests.push({id:'send-1',session:window.info.session,conversationId:window.info.conversationId,createdAt:Date.now(),action:'send',text:'fixture instruction',mode:'steer'})''')
            await page.wait_for_function('window.replies.length===1')
            assert await page.evaluate('window.actions[0].id')=='11111111-1111-4111-8111-111111111111'
            assert await page.evaluate('window.replies[0].result.state')=='submitted'
            checks.append('real component dispatches to pinned id and reports submitted, not completed')
            await page.evaluate('''() => window.requests.push({id:'stop-1',session:window.info.session,conversationId:window.info.conversationId,createdAt:Date.now(),action:'stop'})''')
            await page.wait_for_function('window.replies.length===2')
            assert await page.evaluate('window.running') is False
            assert await page.evaluate('window.replies[1].result.state')=='stopped'
            checks.append('stop waits for handler acknowledgement')
            await page.evaluate('''() => window.requests.push({id:'foreign-1',session:window.info.session,conversationId:'other',createdAt:Date.now(),action:'send',text:'must not run',mode:'steer'})''')
            await page.wait_for_function('window.replies.length===3')
            assert await page.evaluate('window.replies[2].result.state')=='failed'
            assert await page.evaluate('window.actions.length')==2
            checks.append('foreign conversation rejected before mutation')
            await page.screenshot(path=str(evidence/'ui-paired.png'))
            await page.get_by_role('button',name='연결 끄기',exact=True).click()
            await page.get_by_text('DOT 연결 · 꺼짐',exact=True).wait_for()
            assert await page.evaluate('window.info.enabled') is False
            assert not errors,errors
            checks.append('disconnect and no page errors')
            (evidence/'ui-verification.json').write_text(json.dumps({'status':'PASS','checks':checks,'nativeTransport':'fixture','liveDot':False},ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps({'status':'PASS','checks':len(checks)}))
        finally:
            await browser.close()

asyncio.run(main())
