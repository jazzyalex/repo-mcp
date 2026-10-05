import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';

test('reconnect reuses the saved key without prompting or exposing upstream secrets', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'mcp-connect-'));
 try {
  const fake=path.join(root,'fake-client');
  await writeFile(fake, '#!/bin/bash\nprintf \'{"process_running":true,"healthy":true,"ready":true,"remote_lookup_attempted":true,"error":"401 invalid_api_key sk-secret-sentinel"}\\n\'\n',{mode:0o700});
  await writeFile(path.join(root,'runtime.key'),'saved-synthetic-key',{mode:0o600});
  await writeFile(path.join(root,'tunnel-id'),'tunnel_test\n');
  const r=spawnSync('/bin/bash',['scripts/connect.sh'],{env:{...process.env,MCP_STATE_DIR:root,TUNNEL_CLIENT_BIN:fake},input:'',encoding:'utf8',timeout:10000});
  assert.equal(r.status,1);
  assert.match(r.stdout,/Reusing the saved/);
  assert.match(r.stdout,/credential_rejected/);
  assert.doesNotMatch(r.stdout+r.stderr,/sk-secret-sentinel|Paste the runtime key/);
  assert.equal(await readFile(path.join(root,'runtime.key'),'utf8'),'saved-synthetic-key');
  assert.equal((await stat(path.join(root,'runtime.key'))).mode & 0o777,0o600);
  const rotate=spawnSync('/bin/bash',['scripts/connect.sh','--rotate-key'],{env:{...process.env,MCP_STATE_DIR:root,TUNNEL_CLIENT_BIN:fake},input:'replacement-synthetic-key\n',encoding:'utf8',timeout:10000});
  assert.equal(rotate.status,1); // credential failure remains a failure even after rotation
  assert.equal(await readFile(path.join(root,'runtime.key'),'utf8'),'replacement-synthetic-key');
  assert.doesNotMatch(rotate.stdout+rotate.stderr,/replacement-synthetic-key|sk-secret-sentinel/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('standalone tunnel preview uses durable private state with no checkout dependency', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'mcp-tunnel-install-'));
 try {
  const state=path.join(root,'app-support');
  const credentials=path.join(state,'credentials');
  await mkdir(credentials,{recursive:true,mode:0o700});
  await writeFile(path.join(credentials,'runtime.key'),'synthetic-key',{mode:0o600});
  await writeFile(path.join(credentials,'tunnel-id'),'tunnel_test\n',{mode:0o600});
  const client=path.join(root,'tunnel-client');
  await writeFile(client,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const result=spawnSync('python3',['scripts/install-tunnel-service.py','--client',client],{
   env:{...process.env,REPO_MCP_HOME:state},encoding:'utf8'
  });
  assert.equal(result.status,0,result.stdout+result.stderr);
  const canonicalState=await realpath(state);
  const preview=path.join(canonicalState,'tunnel','local.repo-mcp.tunnel.preview.plist');
  const decoded=spawnSync('python3',['-c',
   'import json,plistlib,sys; d=plistlib.load(open(sys.argv[1],"rb")); print(json.dumps(d))',preview],{encoding:'utf8'});
  assert.equal(decoded.status,0,decoded.stderr);
  const plist=JSON.parse(decoded.stdout);
  const args:string[]=plist.ProgramArguments;
  assert.equal(plist.WorkingDirectory,path.join(canonicalState,'tunnel'));
  assert.equal(args[args.indexOf('--control-plane.api-key')+1],`file:${path.join(canonicalState,'credentials','runtime.key')}`);
  assert.equal(args[args.indexOf('--health.url-file')+1],path.join(canonicalState,'tunnel','health.url'));
  assert.equal(plist.StandardOutPath,path.join(canonicalState,'tunnel','stdout.log'));
  assert.equal(plist.StandardErrorPath,path.join(canonicalState,'tunnel','stderr.log'));
  assert.doesNotMatch(JSON.stringify(plist),/repo-mcp-trial|\.trial/);
  assert.equal((await stat(credentials)).mode & 0o777,0o700);
  assert.equal((await stat(preview)).mode & 0o777,0o600);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('status requires remote verification and never masks errors with readiness flags', () => {
 const check=(data: unknown)=>spawnSync(process.execPath,['scripts/tunnel-status.mjs'],{input:JSON.stringify(data),encoding:'utf8'});
 const flags={process_running:true,healthy:true,ready:true};
 assert.equal(check(flags).status,1);
 assert.match(check({...flags,remote_error:'403 secret-sentinel'}).stdout,/access_denied/);
 assert.doesNotMatch(check({...flags,remote_error:'403 secret-sentinel'}).stdout,/secret-sentinel/);
 assert.equal(check({...flags,remote_lookup_attempted:true}).status,1);
 assert.equal(check({...flags,remote_lookup_attempted:true,live_poll:{status:'ok',details:{last_success:new Date().toISOString(),consecutive_failures:0}}}).status,0);
 assert.equal(check({...flags,remote_lookup_attempted:true,live_poll:{status:'ok',details:{last_success:new Date(Date.now()-300000).toISOString(),consecutive_failures:0}}}).status,1);
 assert.equal(check({...flags,remote_lookup_attempted:true,error:'connection failed'}).status,1);
});

for (const scenario of [
 {name:'live becomes false',live:false,ready:true,code:1,state:'not_ready'},
 {name:'ready becomes false',live:true,ready:false,code:1,state:'not_ready'},
 {name:'the poll recovers',live:true,ready:true,code:0,state:'ready'}
]) test(`status retry uses the latest health response when ${scenario.name}`, async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'mcp-status-retry-'));
 const requests: (string | undefined)[]=[];
 const server=createServer((request,response) => {
  requests.push(request.url);
  const first=requests.length===1;
  response.writeHead(200,{'Content-Type':'application/json'});
  response.end(JSON.stringify({
   live:first ? true : scenario.live,
   ready:first ? true : scenario.ready,
   components:{'control-plane':{status:'ok',details:{
    last_success:new Date(Date.now()-(first ? 300000 : 0)).toISOString(),
    consecutive_failures:0
   }}}
  }));
 });
 try {
  await new Promise<void>((resolve,reject) => {
   server.once('error',reject);
   server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address();
  assert.ok(address && typeof address!=='string');
  const healthFile=path.join(root,'health.url');
  await writeFile(healthFile,`http://127.0.0.1:${address.port}`);
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolve,reject) => {
   const child=spawn(process.execPath,['scripts/tunnel-status.mjs','--health-file',healthFile],{timeout:5000});
   let stdout='',stderr='';
   child.stdout.setEncoding('utf8').on('data',chunk => {stdout+=chunk;});
   child.stderr.setEncoding('utf8').on('data',chunk => {stderr+=chunk;});
   child.once('error',reject);
   child.once('close',(code,signal) => resolve({code,signal,stdout,stderr}));
  });
  assert.equal(result.signal,null,result.stderr);
  assert.equal(result.code,scenario.code,result.stdout+result.stderr);
  assert.equal(JSON.parse(result.stdout).state,scenario.state);
  assert.deepEqual(requests,['/health?details=true','/health?details=true']);
 } finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root,{recursive:true,force:true});
 }
});
