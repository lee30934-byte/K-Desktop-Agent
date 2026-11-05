#!/usr/bin/env node
// Same-user local adapter. No network, OAuth credentials or model API calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function read(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function connect(root) {
  if (!root || !path.isAbsolute(root)) throw new Error('Use --root with the exact absolute DOT connection path shown in KDA.');
  const c = await read(path.join(root, 'connection.json'));
  if (!c.enabled || !uuid.test(c.session) || !uuid.test(c.conversationId)) throw new Error('KDA DOT connection is disabled. Pair a conversation in KDA.');
  if (!Number.isFinite(c.heartbeatMs) || Date.now() - c.heartbeatMs > 5000 || c.heartbeatMs > Date.now() + 2000) throw new Error('KDA connection is offline/stale. No command sent.');
  return c;
}
export async function receipt(root, session, id) {
  if (!uuid.test(id) || !uuid.test(session)) throw new Error('Invalid request/session id');
  try { return await read(path.join(root, session, `${id}.response.json`)); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    let claimed = false;
    try { await fs.stat(path.join(root, session, `${id}.claim.json`)); claimed = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { id, session, ok: false, state: claimed ? 'outcome_unknown' : 'pending',
      detail: 'No final receipt. Do not repeat a mutation with a new id; inspect KDA state.' };
  }
}
export async function request(root, input, { timeoutMs = 35_000 } = {}) {
  const c = await connect(root);
  const { action, text, mode = 'steer' } = input;
  if (!['status', 'send', 'stop'].includes(action)) throw new Error('Unsupported action');
  const conversationId = input.conversationId ?? (action === 'status' ? c.conversationId : null);
  if (conversationId !== c.conversationId) throw new Error('Explicit conversationId must match the conversation paired in KDA.');
  const id = input.id ?? (action === 'status' ? randomUUID() : null);
  if (!uuid.test(id ?? '')) throw new Error('Mutation requires a stable UUID request id. Reuse it on inspection; never auto-repeat with a new id.');
  if (action !== 'status' && input.session !== c.session) throw new Error('Explicit session must match status. Connection changed; inspect old receipt before considering new work.');
  if (action === 'send' && (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 12_000 || !['steer','queue'].includes(mode))) throw new Error('Invalid text or mode');
  const payload = { id, session: c.session, conversationId, action, ...(action === 'send' ? { text, mode } : {}) };
  const file = path.join(root, c.session, `${id}.request.json`);
  // Publish atomically using an exclusive hard link. Existing request ids cannot be overwritten.
  const temp = path.join(root, c.session, `${id}.${randomUUID()}.tmp`);
  let existing;
  try { existing = await read(file); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  if (existing) {
    if (JSON.stringify({ ...existing, createdAt: undefined }) !== JSON.stringify({ ...payload, createdAt: undefined })) throw new Error('Request id already belongs to another command.');
  } else {
    await fs.writeFile(temp, JSON.stringify({ ...payload, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
    try { await fs.link(temp, file); }
    catch(e) {
      if(e.code !== 'EEXIST') throw e;
      const other = await read(file);
      if (JSON.stringify({ ...other, createdAt: undefined }) !== JSON.stringify({ ...payload, createdAt: undefined })) throw new Error('Concurrent request id conflict.');
    }
    // The temp is our own unpublished link; never delete requests or receipts.
    finally { await fs.unlink(temp); }
  }
  const start = Date.now();
  do {
    const result = await receipt(root, c.session, id);
    if (result.ok || result.error) return { session: c.session, ...result };
    await delay(100);
  } while (Date.now() - start < timeoutMs);
  return receipt(root, c.session, id);
}
export const toolDefinitions = [
  { name: 'kda_status', description: 'Inspect ONLY the conversation paired in KDA. Distinguish latest answer from current job outcome.', inputSchema: { type:'object', properties:{}, additionalProperties:false }, annotations: { readOnlyHint:true } },
  { name: 'kda_send', description: 'Submit a user instruction to the explicitly paired KDA conversation. Requires a stable UUID requestId and session from status. Never retry with a new id after a timeout. Submitted is not completed.', inputSchema:{ type:'object', properties:{ session:{type:'string'}, conversationId:{type:'string'}, requestId:{type:'string'}, text:{type:'string',maxLength:12000}, mode:{type:'string',enum:['steer','queue'],default:'steer'} }, required:['session','conversationId','requestId','text'], additionalProperties:false }, annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true} },
  { name: 'kda_stop', description: 'Stop the explicitly paired KDA conversation and pause automatic continuation. Does not guarantee stopping detached external processes. Reuse requestId; do not auto-repeat.', inputSchema:{type:'object',properties:{session:{type:'string'},conversationId:{type:'string'},requestId:{type:'string'}},required:['session','conversationId','requestId'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true} },
  { name: 'kda_receipt', description: 'Read a prior receipt without submitting work, including after reconnect. Unknown means inspect state, not retry.', inputSchema:{type:'object',properties:{session:{type:'string'},requestId:{type:'string'}},required:['session','requestId'],additionalProperties:false},annotations:{readOnlyHint:true} },
];
export async function rpc(root, msg) {
  if (!Object.hasOwn(msg, 'id')) return null;
  const base={jsonrpc:'2.0',id:msg.id};
  if (msg.method==='initialize') return {...base,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'kda-dot-bridge',version:'1.0.0'}}};
  if (msg.method==='ping') return {...base,result:{}};
  if (msg.method==='tools/list') return {...base,result:{tools:toolDefinitions}};
  if (msg.method!=='tools/call') return {...base,error:{code:-32601,message:'Method not found'}};
  try {
    const {name,arguments:a={}}=msg.params ?? {};
    let value;
    if (name==='kda_receipt') value=await receipt(root,a.session,a.requestId);
    else {
      const action={kda_status:'status',kda_send:'send',kda_stop:'stop'}[name];
      if (!action) throw new Error('Unknown tool');
      value=await request(root,{action,session:a.session,conversationId:a.conversationId,id:a.requestId,text:a.text,mode:a.mode});
    }
    return {...base,result:{content:[{type:'text',text:JSON.stringify(value)}],isError:!value.ok || value.result?.state==='failed'}};
  } catch(e) {return {...base,result:{content:[{type:'text',text:String(e.message ?? e)}],isError:true}};}
}
async function main() {
  const args=process.argv.slice(2);const command=args.shift();const opts={};
  for(let i=0;i<args.length;i+=2) {if(!args[i]?.startsWith('--') || !args[i+1]) throw new Error('Expected --name value');opts[args[i].slice(2)]=args[i+1];}
  const root=opts.root;
  if(command==='mcp') {
    if(!root || !path.isAbsolute(root)) throw new Error('--root required');
    const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
    for await(const line of lines) {
      if(Buffer.byteLength(line)>25_000) continue;
      // Do not serialize tool waits: status/stop must be receivable during another call.
      void (async()=>{try {const response=await rpc(root,JSON.parse(line));if(response) process.stdout.write(JSON.stringify(response)+'\n');}catch {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');}})();
    }
    return;
  }
  if(command==='receipt') {console.log(JSON.stringify(await receipt(root,opts.session,opts.id)));return;}
  const text=opts['text-file'] ? await fs.readFile(opts['text-file'],'utf8') : opts.text;
  const value=await request(root,{action:command,session:opts.session,conversationId:opts.conversation,id:opts.id,text,mode:opts.mode});
  console.log(JSON.stringify(value));if(!value.ok || value.result?.state==='failed') process.exitCode=2;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(e=>{console.error(e.message ?? e);process.exitCode=1;});
}
