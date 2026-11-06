"""Real subscription WebRTC transport, synthetic media, fixture work handlers only."""
import asyncio
import argparse
import datetime
import functools
import json
import os
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/voice-implementation-20261106'

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--speech', default='synthetic-command.wav')
    parser.add_argument('--scenario', action='store_true')
    parser.add_argument('--expect-stop', action='store_true')
    parser.add_argument('--out-dir', type=Path, default=OUT)
    parser.add_argument('--diagnose-output', action='store_true')
    options = parser.parse_args()
    output_dir = options.out_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'provider': 'installed Codex subscription',
              'realMicrophone': False, 'realSpeakerPlayback': False, 'workHandlers': 'fixture', 'apiKeyExtracted': False}
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(output_dir)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    proc = await asyncio.create_subprocess_exec('node', str(ROOT / 'scripts/voice-probe-host.mjs'), cwd=ROOT,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    messages = []
    try:
        async with async_playwright() as pw:
            args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
            speech = OUT / options.speech
            if speech.exists():
                args.append('--use-file-for-fake-audio-capture='+str(speech))
                result['syntheticSpeech'] = str(speech)
            browser = await pw.chromium.launch(channel='msedge', headless=True, args=args)
            page = await browser.new_page()
            async def start(session_id, conversation_id, sdp):
                proc.stdin.write((json.dumps({'type': 'voice_start', 'sessionId': session_id, 'conversationId': conversation_id, 'sdp': sdp})+'\n').encode())
                await proc.stdin.drain()
            async def stop(session_id):
                proc.stdin.write((json.dumps({'type': 'voice_stop', 'sessionId': session_id})+'\n').encode())
                await proc.stdin.drain()
            async def reply(session_id, token, output):
                proc.stdin.write((json.dumps({'type': 'voice_reply', 'sessionId': session_id, 'token': token, 'result': output})+'\n').encode())
                await proc.stdin.drain()
            async def speak(session_id, text):
                proc.stdin.write((json.dumps({'type': 'voice_speak', 'sessionId': session_id, 'text': text})+'\n').encode())
                await proc.stdin.drain()
            async def pump():
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        return
                    event = json.loads(line)
                    messages.append({k: v for k, v in event.items() if k not in ('sdp', 'sessionId')})
                    await page.evaluate('(e)=>window.voiceEvent?.(e)', event)
            await page.expose_function('nativeStart', start)
            await page.expose_function('nativeStop', stop)
            await page.expose_function('nativeReply', reply)
            await page.expose_function('nativeSpeak', speak)
            await page.goto(f'http://127.0.0.1:{server.server_port}/voice-fixture.html')
            await page.wait_for_function('!!window.voiceStart')
            await page.evaluate('''() => {
              window.playbackSamples=[];
              let stream,context,analyser;
              window.playbackProbe=setInterval(()=>{
                const voice=window.voice,audio=voice?.audio;
                if(!audio?.srcObject)return;
                if(stream!==audio.srcObject){
                  stream=audio.srcObject;
                  context=new AudioContext();analyser=context.createAnalyser();
                  analyser.fftSize=1024;context.createMediaStreamSource(stream).connect(analyser);
                  void context.resume();window.playbackProbeContext=context;
                }
                const a=new Float32Array(1024);analyser.getFloatTimeDomainData(a);
                const rms=Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
                if(window.playbackSamples.length<2400)window.playbackSamples.push({
                  at:Math.round(performance.now()),rms,muted:audio.muted,paused:audio.paused,
                  userSpeaking:voice.userSpeaking,suppressed:voice.suppressed,
                  responseActive:voice.responseActive,context:voice.output?.context.state,
                  silenceUntilUser:voice.silenceUntilUser});
              },50);
            }''')
            task = asyncio.create_task(pump())
            await page.evaluate('window.voiceStart()')
            try:
                await page.wait_for_function("window.views.some(v=>['connected','error'].includes(v.phase))", timeout=70000)
            except Exception:
                pass
            result['views'] = await page.evaluate('window.views')
            result['events'] = await page.evaluate('window.rawEvents')
            result['messages'] = messages
            result['connected'] = any(v['phase'] == 'connected' for v in result['views'])
            if result['connected']:
                try:
                    condition = "window.voiceReplies.length>0 && window.views.some(v=>v.lines.some(l=>l.role==='assistant'&&/37|진행|빌드/.test(l.text)))"
                    if options.scenario:
                        condition = "window.actions.some(a=>a.action==='send')&&window.actions.some(a=>a.action==='stop')&&window.views.some(v=>v.lines.some(l=>l.role==='assistant'&&/멈췄|멈춘|정지했|정지됐|중단했|중단됐/.test(l.text)))"
                    elif options.expect_stop:
                        condition = "window.actions.some(a=>a.action==='stop')&&window.views.some(v=>v.lines.some(l=>l.role==='assistant'&&/멈췄|멈춘|정지했|정지됐|중단했|중단됐/.test(l.text)))"
                    await page.wait_for_function(condition, timeout=85000 if options.scenario else 45000)
                    # A final transcript can arrive ahead of its audio packets.
                    await page.wait_for_timeout(3000)
                except Exception:
                    pass
                result['actions'] = await page.evaluate('window.actions')
                result['replies'] = await page.evaluate('window.voiceReplies')
                result['views'] = await page.evaluate('window.views')
                result['events'] = await page.evaluate('window.rawEvents')
                result['rtcStats'] = await page.evaluate("""async()=>{
                    const stats=await window.voice.peer.getStats();
                    return [...stats.values()].filter(s=>s.type==='inbound-rtp'&&s.kind==='audio').map(s=>({bytesReceived:s.bytesReceived,packetsReceived:s.packetsReceived,audioLevel:s.audioLevel,totalAudioEnergy:s.totalAudioEnergy,totalSamplesDuration:s.totalSamplesDuration}));
                }""")
                result['meaningfulFeedback'] = any(l['role'] == 'assistant' and any(w in l['text'] for w in ['37', '진행', '빌드']) for v in result['views'] for l in v['lines'])
                result['queuedWork'] = any(a['action'] == 'send' and a.get('mode') == 'queue' for a in result['actions'])
                result['stoppedWork'] = any(a['action'] == 'stop' for a in result['actions'])
                result['noUnsolicitedSteer'] = not any(a.get('mode') == 'steer' for a in result['actions'])
                if options.diagnose_output:
                    result['beforeActivationSamples'] = await page.evaluate('window.playbackSamples.slice()')
                    await page.evaluate('''async()=>{
                      const source=window.voice.output?.source?.mediaStream;
                      if(!source)throw Error('No remote stream to diagnose');
                      const activation=window.remoteActivation=new Audio();
                      activation.volume=0;activation.srcObject=source;await activation.play();
                      await window.voice.transport.speak(window.voice.id,'음성 출력 점검입니다. 하나 둘 셋 넷.');
                    }''')
                    await page.wait_for_timeout(8000)
                    await page.evaluate('window.remoteActivation.pause();window.remoteActivation.srcObject=null')
            result['playbackSamples'] = await page.evaluate('window.playbackSamples')
            result['renderedAudioSamples'] = sum(1 for s in result['playbackSamples'] if s['rms'] > 0.00005)
            result['unmutedAudioSamples'] = sum(1 for s in result['playbackSamples'] if s['rms'] > 0.00005 and not s['muted'] and not s['paused'] and s.get('context') == 'running')
            await page.evaluate('clearInterval(window.playbackProbe);void window.playbackProbeContext?.close()')
            await page.evaluate('window.voice.end()')
            result['tracksReleased'] = await page.evaluate("window.voice.stream?.getTracks().every(t=>t.readyState==='ended')??true")
            result['status'] = 'PASS' if (result.get('connected') and
                (result.get('stoppedWork') if options.scenario or options.expect_stop else result.get('meaningfulFeedback')) and
                result.get('noUnsolicitedSteer') and result.get('tracksReleased') and
                result.get('unmutedAudioSamples', 0) >= 5 and not any(e.get('kind') == 'error' for e in messages)) else 'FAIL'
            task.cancel()
            await browser.close()
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            proc.kill()
        server.shutdown()
        path = output_dir / ('native-probe-' + datetime.datetime.now().strftime('%H%M%S%f') + '.json')
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'path':str(path),'connected':result.get('connected'),'meaningfulFeedback':result.get('meaningfulFeedback'),'queuedWork':result.get('queuedWork'),'stoppedWork':result.get('stoppedWork'),'noUnsolicitedSteer':result.get('noUnsolicitedSteer'),'tracksReleased':result.get('tracksReleased'),'renderedAudioSamples':result.get('renderedAudioSamples'),'unmutedAudioSamples':result.get('unmutedAudioSamples'),'errors':[e for e in messages if e.get('kind')=='error']},ensure_ascii=True))
    if result.get('status') != 'PASS':
        raise SystemExit(1)

if __name__ == '__main__':
    asyncio.run(main())
