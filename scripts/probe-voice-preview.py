"""Real subscription preview, isolated work handlers and headless audio measurement."""
import argparse
import asyncio
import datetime
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--voice', default='')
    args = parser.parse_args()
    out = args.out_dir.resolve()
    assert (out / 'voice-fixture.html').is_file()
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(out)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    result = dict(startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  realMicrophone=False, realSpeakerPlayback=False, provider='installed Codex subscription',
                  workHandlers='isolated fixture', status='FAIL')
    proc = await asyncio.create_subprocess_exec('node', str(ROOT / 'scripts/voice-probe-host.mjs'), cwd=ROOT,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    pump_task = None
    events = []
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel='msedge', headless=True,
                args=['--autoplay-policy=no-user-gesture-required'])
            page = await browser.new_page()
            async def write(message):
                proc.stdin.write((json.dumps(message) + '\n').encode())
                await proc.stdin.drain()
            async def start(sid, target, sdp, options):
                await write(dict(type='voice_start', sessionId=sid, conversationId=target, sdp=sdp, **options))
            async def stop(sid):
                await write(dict(type='voice_stop', sessionId=sid))
            async def speak(sid, text):
                await write(dict(type='voice_speak', sessionId=sid, text=text))
            async def pump():
                while line := await proc.stdout.readline():
                    event = json.loads(line)
                    events.append({k: v for k, v in event.items() if k not in ('sdp', 'sessionId', 'token', 'command')})
                    await page.evaluate('(e)=>window.voiceEvent?.(e)', event)
            await page.expose_function('nativeStart', start)
            await page.expose_function('nativeStop', stop)
            await page.expose_function('nativeSpeak', speak)
            await page.goto(f'http://127.0.0.1:{server.server_port}/voice-fixture.html')
            await page.wait_for_function('!!window.voiceStart')
            await page.evaluate('''() => {
              window.previewSamples=[];window.microphoneRequests=0;
              navigator.mediaDevices.getUserMedia=()=>{window.microphoneRequests++;throw Error('Preview opened microphone');};
              let stream,context,analyser;
              window.sampleTimer=setInterval(()=>{
                const v=window.voice,a=v?.audio;if(!a?.srcObject)return;
                if(stream!==a.srcObject){stream=a.srcObject;context=new AudioContext();analyser=context.createAnalyser();
                  analyser.fftSize=1024;context.createMediaStreamSource(stream).connect(analyser);void context.resume();window.measurementContext=context;}
                const data=new Float32Array(1024);analyser.getFloatTimeDomainData(data);
                window.previewSamples.push({rms:Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length),
                  muted:a.muted,paused:a.paused,context:v.output?.context.state});
              },50);
            }''')
            pump_task = asyncio.create_task(pump())
            await page.evaluate('(voice)=>window.voiceStart({preview:true,voice})', args.voice)
            try:
                await page.wait_for_function("window.views.some(v=>['ended','error'].includes(v.phase))", timeout=75000)
            except Exception as error:
                result['waitError'] = type(error).__name__
            result.update(await page.evaluate('''()=>({views:window.views,events:window.rawEvents,
              actions:window.actions,microphoneRequests:window.microphoneRequests,samples:window.previewSamples})'''))
            result['providerEvents'] = events
            result['connected'] = any(v['phase'] == 'connected' for v in result['views'])
            result['unmutedAudioSamples'] = sum(s['rms'] > 0.00005 and not s['muted'] and not s['paused'] and s['context'] == 'running' for s in result['samples'])
            result['status'] = 'PASS' if (result['connected'] and result['unmutedAudioSamples'] >= 5
                and result['microphoneRequests'] == 0 and not result['actions']
                and not any(e.get('kind') == 'error' for e in events)) else 'FAIL'
            await page.evaluate('window.voice.end();clearInterval(window.sampleTimer);void window.measurementContext?.close()')
            result['inputReleased'] = await page.evaluate("window.voice.stream?.getTracks().every(t=>t.readyState==='ended')??true")
            result['inputContextClosed'] = await page.evaluate("!window.voice.audioContext || window.voice.audioContext.state==='closed'")
            if not result['inputReleased'] or not result['inputContextClosed']:
                result['status'] = 'FAIL'
            pump_task.cancel()
            await browser.close()
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'[:500]
    finally:
        if pump_task:
            pump_task.cancel()
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        server.shutdown()
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        path = out / 'preview-result.json'
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({k: v for k, v in result.items() if k not in ('samples', 'views', 'events', 'providerEvents')}, ensure_ascii=True))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
