"""Measure the actual output graph using a synthetic remote stream; no hardware audio."""
import asyncio
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/voice-output-20261106'


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True,
                                             args=['--autoplay-policy=no-user-gesture-required'])
            page = await browser.new_page()
            await page.goto(f'http://127.0.0.1:{server.server_port}/output.html')
            result = await page.evaluate('''async () => {
              const {VoiceOutput,readVoiceGain,voiceGain,VOICE_OUTPUT_KEY}=window.outputModule;
              localStorage.removeItem(VOICE_OUTPUT_KEY);
              const defaultGain=readVoiceGain();
              localStorage.setItem(VOICE_OUTPUT_KEY,'2');
              const savedGain=readVoiceGain();
              localStorage.setItem(VOICE_OUTPUT_KEY,'oops');
              const invalidGain=readVoiceGain();
              const input=new AudioContext(), oscillator=input.createOscillator(), quiet=input.createGain();
              const remote=input.createMediaStreamDestination();quiet.gain.value=0.02;
              oscillator.connect(quiet).connect(remote);oscillator.start();await input.resume();
              const output=new VoiceOutput(1);const stream=output.attach(remote.stream);await output.resume();
              const measure=new AudioContext(), analyser=measure.createAnalyser();analyser.fftSize=2048;
              measure.createMediaStreamSource(stream).connect(analyser);await measure.resume();
              const rms=async()=>{await new Promise(r=>setTimeout(r,350));let samples=[];
                for(let i=0;i<8;i++){const a=new Float32Array(2048);analyser.getFloatTimeDomainData(a);
                  samples.push(Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length));await new Promise(r=>setTimeout(r,20));}
                return samples.reduce((s,x)=>s+x,0)/samples.length;};
              const baseline=await rms();output.setGain(2);const boosted=await rms();
              output.setGain(0);const muted=await rms();output.close();
              const sourceSurvives=remote.stream.getTracks().every(t=>t.readyState==='live');
              const outputReleased=stream.getTracks().every(t=>t.readyState==='ended');
              oscillator.stop();remote.stream.getTracks().forEach(t=>t.stop());await input.close();await measure.close();
              return {defaultGain,savedGain,invalidGain,low:voiceGain(-10),high:voiceGain(99),
                baseline,boosted,ratio:boosted/baseline,muted,sourceSurvives,outputReleased};
            }''')
            await browser.close()
        assert result['defaultGain'] == 1.5 and result['savedGain'] == 2 and result['invalidGain'] == 1.5
        assert result['low'] == 0 and result['high'] == 3
        assert result['baseline'] > 0.001 and 1.9 < result['ratio'] < 2.1
        assert result['muted'] < 0.00001
        assert result['sourceSurvives'] and result['outputReleased']
        result.update(status='PASS', realHardwareVerified=False, installed=False,
                      scope='Synthetic received stream only; no OS or microphone setting changes')
        (OUT / 'audio-verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result))
    finally:
        server.shutdown()


asyncio.run(main())
