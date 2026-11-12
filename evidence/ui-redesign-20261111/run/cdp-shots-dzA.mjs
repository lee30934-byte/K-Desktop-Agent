// dzA 캡처 보조 (cdp-shots-spB.mjs 확장): hover(마우스 이동) · tabs(Tab 키 n번) 지원. usage: node cdp-shots-dzA.mjs <jobs.json>
import { spawn } from "node:child_process";
import fs from "node:fs";
const jobs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const port = 9300 + Math.floor(Math.random() * 500);
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const p = spawn(edge, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}/edge-cdp-dzA-${port}`, "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {} await sleep(250); }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Page.enable");
for (const j of jobs) {
  await send("Emulation.setDeviceMetricsOverride", { width: j.w, height: j.h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: j.url });
  await sleep(j.wait ?? 7000);
  if (j.pre) { await evaluate(j.pre); await sleep(j.preWait ?? 800); }
  if (j.hover) { const [x, y] = await evaluate(j.hover); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await sleep(400); }
  if (j.tabs) { for (let i = 0; i < j.tabs; i++) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); } await sleep(400); }
  if (j.keys) { for (const k of j.keys) { await send("Input.dispatchKeyEvent", { type: "keyDown", ...k }); await send("Input.dispatchKeyEvent", { type: "keyUp", ...k }); } await sleep(j.preWait ?? 800); }
  if (j.probe) console.log(j.out, JSON.stringify(await evaluate(j.probe)));
  const s = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(j.out, Buffer.from(s.result.data, "base64"));
  console.log("shot", j.out);
}
ws.close(); p.kill();
process.exit(0);
