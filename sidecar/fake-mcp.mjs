import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const r=JSON.parse(line); if(r.id===undefined) continue;
  let result;
  if(r.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(r.method==='tools/list') result={tools:['ui_get_text','ui_set_text'].map(name=>({name,inputSchema:{type:'object'}}))};
  else if(r.method==='tools/call') result={content:[{type:'text',text:JSON.stringify(r.params)}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');
}
