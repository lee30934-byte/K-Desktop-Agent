"""Measure the real packaged worklet and local received RTC stream. No hardware media."""
import asyncio
import functools
import json
import os
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ.get('KDA_EFFECT_EVIDENCE', 'evidence/voice-effects-20261106/audio-v1')


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    result = dict(status='RUNNING', hardwareAudioUsed=False, installed=False, published=False)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True,
                                             args=['--autoplay-policy=no-user-gesture-required', '--mute-audio'])
            try:
                page = await browser.new_page()
                await page.goto(f'http://127.0.0.1:{server.server_port}/output.html')
                result.update(await page.evaluate('''async () => {
                  const {VoiceOutput}=window.outputModule;
                  const {VOICE_EFFECT_PRESETS}=window.effectsModule;
                  navigator.mediaDevices.getUserMedia=()=>{throw Error('Hardware media prohibited')};
                  const wait=ms=>new Promise(r=>setTimeout(r,ms));
                  const source=new AudioContext(),osc=source.createOscillator(),level=source.createGain();
                  const tx=source.createMediaStreamDestination();level.gain.value=.05;osc.frequency.value=220;
                  osc.connect(level).connect(tx);osc.start();await source.resume();
                  const warnings=[],output=new VoiceOutput(1,undefined,m=>warnings.push(m));
                  const stream=output.attach(tx.stream);await output.resume();
                  const meter=new AudioContext(),analyser=meter.createAnalyser();analyser.fftSize=32768;analyser.smoothingTimeConstant=0;
                  meter.createMediaStreamSource(stream).connect(analyser);await meter.resume();
                  async function measure(target=analyser){
                    await wait(850);const data=new Float32Array(target.fftSize),spectrum=new Float32Array(target.frequencyBinCount);
                    target.getFloatTimeDomainData(data);target.getFloatFrequencyData(spectrum);
                    let peak=-Infinity,frequency=0;
                    for(let i=Math.floor(100*target.fftSize/meter.sampleRate);i<Math.ceil(500*target.fftSize/meter.sampleRate);i++)
                      if(spectrum[i]>peak){peak=spectrum[i];frequency=i*meter.sampleRate/target.fftSize;}
                    return {frequency,rms:Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length),finite:data.every(Number.isFinite)};
                  }
                  const profiles=[];
                  for(const p of VOICE_EFFECT_PRESETS){await output.setEffect({preset:p.id,strength:1});profiles.push({preset:p.id,semitones:p.semitones,...await measure()});}
                  await output.setEffect({preset:'bright',strength:0});const zeroStrength=await measure();
                  output.close();const closed=stream.getTracks().every(t=>t.readyState==='ended');

                  // A real processor exception is stronger evidence than a synthetic DOM event.
                  const crashWarnings=[],crash=new VoiceOutput(1,undefined,m=>crashWarnings.push(m));
                  const crashStream=crash.attach(tx.stream);await crash.resume();
                  const crashMeter=meter.createAnalyser();crashMeter.fftSize=32768;crashMeter.smoothingTimeConstant=0;
                  meter.createMediaStreamSource(crashStream).connect(crashMeter);
                  const crashLoad=crash.context.audioWorklet.addModule.bind(crash.context.audioWorklet);
                  crash.context.audioWorklet.addModule=()=>crashLoad(new URL('./audio/failing-test-worklet.mjs',document.baseURI));
                  await crash.setEffect({preset:'robot',strength:1});
                  const processorFailure=await measure(crashMeter),failureWarning=crashWarnings[crashWarnings.length-1];
                  const processorActuallyFailed=crash.effects.broken;
                  await crash.setEffect({preset:'natural',strength:.6});const warningCleared=crashWarnings[crashWarnings.length-1]==='';
                  crash.close();

                  // Race: an effect requested before its module is ready cannot win over a later bypass.
                  let releaseLoad;const raceWarnings=[],race=new VoiceOutput(1,undefined,m=>raceWarnings.push(m));
                  const raceStream=race.attach(tx.stream);await race.resume();
                  const originalLoad=race.context.audioWorklet.addModule.bind(race.context.audioWorklet);
                  race.context.audioWorklet.addModule=url=>new Promise((resolve,reject)=>releaseLoad=()=>originalLoad(url).then(resolve,reject));
                  const pending=race.setEffect({preset:'robot',strength:1});
                  await race.setEffect({preset:'natural',strength:.6});
                  releaseLoad();await pending;
                  const raceBypass=race.effects.dry.gain.value>.99&&race.effects.wet.gain.value<.01;
                  race.close();

                  // A packaged asset failure keeps the output alive and informs the user.
                  const failedWarnings=[],failed=new VoiceOutput(1,undefined,m=>failedWarnings.push(m));
                  const failedStream=failed.attach(tx.stream);await failed.resume();
                  failed.context.audioWorklet.addModule=async()=>{throw Error('deliberate module load fault')};
                  await failed.setEffect({preset:'bright',strength:1});
                  const loadFailureWarning=failedWarnings[failedWarnings.length-1];
                  const loadFailureBypass=failed.effects.dry.gain.value>.99&&failed.effects.wet.gain.value<.01;
                  failed.close();

                  // A late module resolution after closing cannot construct nodes or report stale warnings.
                  let finishClosed;const closingWarnings=[],closing=new VoiceOutput(1,undefined,m=>closingWarnings.push(m));
                  closing.context.audioWorklet.addModule=()=>new Promise(r=>finishClosed=r);
                  const closingPending=closing.setEffect({preset:'deep',strength:1});closing.close();
                  const warningCount=closingWarnings.length;finishClosed();await closingPending;
                  const closedRaceSafe=!closing.effects.processor&&closingWarnings.length===warningCount;

                  // Actual RTC receive decoding with effect changes on the same peer.
                  const send=new RTCPeerConnection(),receive=new RTCPeerConnection(),iceErrors=[];
                  send.onicecandidate=e=>{if(e.candidate)void receive.addIceCandidate(e.candidate).catch(e=>iceErrors.push(String(e)))};
                  receive.onicecandidate=e=>{if(e.candidate)void send.addIceCandidate(e.candidate).catch(e=>iceErrors.push(String(e)))};
                  const remoteTrack=new Promise(resolve=>receive.ontrack=e=>resolve(e.streams[0]||new MediaStream([e.track])));
                  tx.stream.getTracks().forEach(t=>send.addTrack(t,tx.stream));
                  await send.setLocalDescription(await send.createOffer());await receive.setRemoteDescription(send.localDescription);
                  await receive.setLocalDescription(await receive.createAnswer());await send.setRemoteDescription(receive.localDescription);
                  const rx=await Promise.race([remoteTrack,new Promise((_,reject)=>setTimeout(()=>reject(Error('RTC timeout')),8000))]);
                  const received=new VoiceOutput(1),rendered=received.attach(rx);await received.resume();
                  const rtcMeter=meter.createAnalyser();rtcMeter.fftSize=2048;meter.createMediaStreamSource(rendered).connect(rtcMeter);
                  const rtc=[];
                  for(const preset of ['bright','deep','robot','natural']){
                    await received.setEffect({preset,strength:.6});await wait(700);
                    const data=new Float32Array(2048);rtcMeter.getFloatTimeDomainData(data);
                    rtc.push({preset,rms:Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length),connected:receive.connectionState==='connected'});
                  }
                  const sourceSilent=received.sourcePlayback.volume===0&&!received.sourcePlayback.paused;
                  received.close();const rxSurvives=rx.getTracks().every(t=>t.readyState==='live');
                  send.close();receive.close();osc.stop();tx.stream.getTracks().forEach(t=>t.stop());await source.close();await meter.close();
                  return {profiles,zeroStrength,processorFailure,processorActuallyFailed,failureWarning,warningCleared,closed,raceBypass,
                    loadFailureWarning,loadFailureBypass,closedRaceSafe,rtc,sourceSilent,rxSurvives,iceErrors,
                    workletUrl:new URL('./audio/voicePitch.worklet.mjs',document.baseURI).href};
                }'''))
                for profile in result['profiles']:
                    expected = 220 * 2 ** (profile['semitones'] / 12)
                    assert abs(profile['frequency'] - expected) < 12, profile
                    assert profile['rms'] > 0.002 and profile['finite'], profile
                assert abs(result['zeroStrength']['frequency'] - 220) < 4
                assert result['processorFailure']['rms'] > 0.002 and abs(result['processorFailure']['frequency'] - 220) < 4
                assert result['processorActuallyFailed'] and result['failureWarning'] and result['warningCleared']
                for name in ['closed', 'raceBypass', 'loadFailureBypass', 'closedRaceSafe', 'sourceSilent', 'rxSurvives']:
                    assert result[name], name
                assert result['loadFailureWarning']
                assert all(v['rms'] > 0.002 and v['connected'] for v in result['rtc']), result['rtc']
                assert not result['iceErrors']
                result['status'] = 'PASS'
            finally:
                await browser.close()
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        raise
    finally:
        server.shutdown()
        (OUT / 'effect-audio-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(status=result['status'], profiles=len(result.get('profiles', [])), hardwareAudioUsed=False)))


if __name__ == '__main__':
    asyncio.run(main())
