"""Measure the actual output graph using a synthetic remote stream; no hardware audio."""
import asyncio
import argparse
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
    parser = argparse.ArgumentParser()
    parser.add_argument('--out-dir', type=Path, default=OUT)
    output_dir = parser.parse_args().out_dir.resolve()
    result = {'status': 'RUNNING', 'realHardwareVerified': False}
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(output_dir)))
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

              // A local WebRTC pair exercises received-track decoding. A directly
              // created MediaStream alone cannot detect the Chromium playback bug.
              const send=new RTCPeerConnection(),receive=new RTCPeerConnection();
              const tone=new AudioContext(),wave=tone.createOscillator(),level=tone.createGain();
              const tx=tone.createMediaStreamDestination();level.gain.value=0.025;
              wave.connect(level).connect(tx);wave.start();await tone.resume();
              const remoteTrack=new Promise(resolve=>receive.ontrack=e=>resolve(e.streams[0]||new MediaStream([e.track])));
              const iceErrors=[];
              send.onicecandidate=e=>{if(e.candidate)void receive.addIceCandidate(e.candidate).catch(e=>iceErrors.push(String(e)))};
              receive.onicecandidate=e=>{if(e.candidate)void send.addIceCandidate(e.candidate).catch(e=>iceErrors.push(String(e)))};
              tx.stream.getTracks().forEach(t=>send.addTrack(t,tx.stream));
              await send.setLocalDescription(await send.createOffer());
              await receive.setRemoteDescription(send.localDescription);
              await receive.setLocalDescription(await receive.createAnswer());
              await send.setRemoteDescription(receive.localDescription);
              const rx=await Promise.race([remoteTrack,new Promise((_,reject)=>setTimeout(()=>reject(Error('WebRTC track timeout')),8000))]);
              const amplified=new VoiceOutput(1.5),rendered=amplified.attach(rx);await amplified.resume();
              const meter=new AudioContext(),rmsMeter=meter.createAnalyser();rmsMeter.fftSize=2048;
              meter.createMediaStreamSource(rendered).connect(rmsMeter);await meter.resume();
              const signal=[];
              for(let i=0;i<30;i++){
                await new Promise(r=>setTimeout(r,100));
                const a=new Float32Array(2048);rmsMeter.getFloatTimeDomainData(a);
                signal.push(Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length));
              }
              const rtcRmsMax=Math.max(...signal),rtcSignalSamples=signal.filter(v=>v>0.001).length;
              const silentSource=amplified.sourcePlayback;
              const sourceVolume=silentSource.volume,sourcePlaying=!silentSource.paused;
              amplified.close();
              const sourceReleased=silentSource.paused&&silentSource.srcObject===null;
              const remoteTrackPreserved=rx.getTracks().every(t=>t.readyState==='live');
              send.close();receive.close();wave.stop();tx.stream.getTracks().forEach(t=>t.stop());await tone.close();await meter.close();
              return {defaultGain,savedGain,invalidGain,low:voiceGain(-10),high:voiceGain(99),
                baseline,boosted,ratio:boosted/baseline,muted,sourceSurvives,outputReleased,
                rtcRmsMax,rtcSignalSamples,sourceVolume,sourcePlaying,sourceReleased,remoteTrackPreserved,iceErrors};
            }''')
            await browser.close()
        assert result['defaultGain'] == 1.5 and result['savedGain'] == 2 and result['invalidGain'] == 1.5
        assert result['low'] == 0 and result['high'] == 3
        assert result['baseline'] > 0.001 and 1.9 < result['ratio'] < 2.1
        assert result['muted'] < 0.00001
        assert result['sourceSurvives'] and result['outputReleased']
        assert result['rtcRmsMax'] > 0.001 and result['rtcSignalSamples'] >= 10
        assert result['sourceVolume'] == 0 and result['sourcePlaying']
        assert result['sourceReleased'] and result['remoteTrackPreserved'] and not result['iceErrors']
        result.update(status='PASS', realHardwareVerified=False, installed=False,
                      scope='Synthetic received stream only; no OS or microphone setting changes')
        print(json.dumps(result))
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        raise
    finally:
        (output_dir / 'audio-verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        server.shutdown()


asyncio.run(main())
