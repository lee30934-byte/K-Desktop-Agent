import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {MCPClient} from './dist/mcpClient.js';
import {runAnthropicRound} from './dist/anthropicTools.js';
import {codexExecutable,codexToolArgs,geminiTurnSettings} from './dist/globalTools.js';
import {toAnthropicTools,toOpenAITools,toGeminiFunctionDeclarations,dispatchModelToolCall} from './dist/toolSchema.js';
let checks=0;
function check(label,fn){fn();checks++;console.log('PASS '+label);}
const dir=mkdtempSync(path.join(os.tmpdir(),'kda-tools-test-'));
const policy=path.join(dir,'policy.json');
writeFileSync(policy,JSON.stringify({command:process.execPath,args:[path.resolve('fake-mcp.mjs')],denied:['ui_set_text']}));
const bridge=new MCPClient('test',process.execPath,[path.resolve('dist/toolBridge.js'),policy]);
try {
  const tools=await bridge.listTools();
  check('bridge hides denied tools',()=>assert.deepEqual(tools.map(t=>t.name),['ui_get_text']));
  const r=await bridge.callTool('ui_get_text',{text:'한글'});
  check('bridge forwards allowed arguments',()=>assert.match(r.content[0].text,/한글/));
  await assert.rejects(()=>bridge.callTool('ui_set_text',{}),/not permitted/);checks++;console.log('PASS bridge blocks direct denied invocation');
  await assert.rejects(()=>bridge.callTool('invented',{}),/not permitted/);checks++;console.log('PASS bridge blocks unknown invocation');
} finally {bridge.stop();}
const catalog=['ui_get_text','ui_set_text'].map(name=>({name,inputSchema:{type:'object',properties:{}}}));
const denied=new Set(['mcp__k-personal__ui_set_text']);
for(const [name,fn] of [['OpenAI/OpenRouter',toOpenAITools],['Gemini',toGeminiFunctionDeclarations],['Anthropic',toAnthropicTools]])
  check(name+' filtered catalog',()=>assert.equal(fn(catalog,denied).length,1));
let invoked=false;
const rejected=await dispatchModelToolCall({client:{callTool:async()=>{invoked=true;}},namespacedName:'mcp__k-personal__ui_set_text',args:{},disallowed:denied,knownTools:new Set(['mcp__k-personal__ui_set_text'])});
check('REST rejects denied call before MCP',()=>{assert.equal(rejected.ok,false);assert.equal(invoked,false);});
const originalFetch=globalThis.fetch;
let body;
globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({content:[{type:'thinking',thinking:'test',signature:'sig'},{type:'text',text:'조회'},{type:'tool_use',id:'tool_1',name:'mcp__k-personal__ui_get_text',input:{}}],stop_reason:'tool_use',usage:{input_tokens:4,output_tokens:2}}));};
try {
  const r=await runAnthropicRound({endpoint:'https://mock.invalid',headers:{},body:{},signal:new AbortController().signal});
  check('Anthropic call ID and full blocks preserved',()=>{assert.equal(r.toolCalls[0].id,'tool_1');assert.equal(r.content[0].signature,'sig');assert.equal(r.inputTokens,4);assert.equal(body.stream,false);});
  globalThis.fetch=async()=>new Response(JSON.stringify({content:[{type:'tool_use',id:'x',name:'x',input:{}}],stop_reason:'max_tokens'}));
  await assert.rejects(()=>runAnthropicRound({endpoint:'https://mock.invalid',headers:{},body:{},signal:new AbortController().signal}),/Incomplete/);checks++;console.log('PASS truncated Anthropic tool response rejected');
  globalThis.fetch=async()=>new Response('',{status:429});
  await assert.rejects(()=>runAnthropicRound({endpoint:'https://mock.invalid',headers:{},body:{},signal:new AbortController().signal}),/429/);checks++;console.log('PASS Anthropic HTTP failure propagated');
} finally {globalThis.fetch=originalFetch;}
const system=path.join(dir,'system.json');
writeFileSync(system,JSON.stringify({security:{test:'preserve'},mcpServers:{'k-personal':{excludeTools:['ui_set_text']},other:{command:'existing'}}}));
const before=readFileSync(system);
const prior=process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH=system;
try {
  const output=geminiTurnSettings({dir,command:process.execPath,args:['a b','한글']});
  const parsed=JSON.parse(readFileSync(output));
  check('Gemini preserves system policy and original file',()=>{assert.deepEqual(readFileSync(system),before);assert.deepEqual(parsed.mcpServers['k-personal'].excludeTools,['ui_set_text']);assert.equal(parsed.security.test,'preserve');assert.equal(parsed.mcpServers.other.command,'existing');});
} finally {if(prior===undefined)delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH=prior;}
const cli=codexExecutable(path.join(process.env.APPDATA,'npm','codex.cmd'));
const testArgs=['C:\\space and 한글\\bridge.js',policy];
const probe=spawnSync(cli.command,[...cli.prefix,...codexToolArgs({command:process.execPath,args:testArgs}),'mcp','get','k-personal','--json'],{encoding:'utf8',timeout:20000,windowsHide:true});
check('installed Codex preserves argv with spaces and Korean',()=>{assert.equal(probe.status,0,probe.stderr);assert.deepEqual(JSON.parse(probe.stdout).transport.args,testArgs);});
console.log(JSON.stringify({passed:checks,networkModelCalls:0,desktopActions:0}));
