'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {PassThrough}=require('stream'),{EventEmitter}=require('events');
const {createDirectUsage,codexSnapshot,claudeSnapshot,codexRateLimits}=require('../direct-usage');
const {normalizeUsage}=require('../ai-usage');
test('direct Codex maps all buckets, second timestamps, and missing windows without double counting',()=>{
 const bucket={primary:{usedPercent:38,windowDurationMins:300,resetsAt:1792670072},secondary:{usedPercent:19,windowDurationMins:10080}};
 const result=normalizeUsage(codexSnapshot({rateLimits:bucket,rateLimitsByLimitId:{codex:{...bucket,planType:'plus'},review:{limitName:'Relecture',primary:{usedPercent:80,windowDurationMins:60}}}}));
 assert.equal(result.providers[0].windows.length,3);assert.equal(result.providers[0].windows[0].remainingPercent,62);
 assert.equal(result.providers[0].windows[0].resetAt,1792670072000);assert.equal(result.providers[0].windows[2].groupLabel,'Relecture');
 assert.equal(normalizeUsage(codexSnapshot({rateLimits:null})).providers[0].windows.length,0);
});
test('Claude maps subscription and model windows; unknown is never zero',()=>{
 const result=normalizeUsage(claudeSnapshot({five_hour:{utilization:30,resets_at:'2026-10-22T12:00:00Z'},seven_day:{utilization:null},seven_day_opus:{utilization:70},extra_usage:{utilization:99}},'max'));
 assert.deepEqual(result.providers[0].windows.map(w=>w.remainingPercent),[70,30]);assert.equal(result.providers[0].plan,'max');
});
test('Codex only initializes and reads rate limits; its child is closed after reading',async()=>{
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let killed=false;child.kill=()=>{killed=true;};
 const sent=[];child.stdin.on('data',bytes=>{const frame=JSON.parse(String(bytes));sent.push(frame.method);
 if(frame.id===1)queueMicrotask(()=>child.stdout.write('{"id":1,"result":{}}\n'));
 if(frame.id===2)queueMicrotask(()=>child.stdout.write('{"id":2,"result":{"rateLimits":null}}\n'));
 });
 const result=await codexRateLimits('codex.exe',(_exe,args,opts)=>{assert.equal(opts.windowsHide,true);assert.deepEqual(args,['app-server','--listen','stdio://']);return child;});
 assert.deepEqual(sent,['initialize','initialized','account/rateLimits/read']);assert.equal(killed,true);assert.equal(result.rateLimits,null);
});
test('Codex timeouts close the child and redact diagnostics',async()=>{
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let killed=false;child.kill=()=>{killed=true;};
 await assert.rejects(codexRateLimits('codex.exe',()=>child,10),/CODEX_USAGE_UNAVAILABLE/);assert.equal(killed,true);
});
function fixture(t,oauth,fetchImpl){const home=fs.mkdtempSync(path.join(os.tmpdir(),'fm-direct-'));fs.mkdirSync(path.join(home,'.claude'));const file=path.join(home,'.claude','.credentials.json');fs.writeFileSync(file,JSON.stringify({claudeAiOauth:oauth}));const before=fs.readFileSync(file,'utf8');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return{home,file,before,reader:createDirectUsage({home,env:{},fetchImpl})};}
test('direct Claude sends credentials only to Anthropic and never stores, returns or rotates them',async t=>{
 const f=fixture(t,{accessToken:'FAKE_SECRET',refreshToken:'FAKE_REFRESH',scopes:['user:profile'],expiresAt:Date.now()+60000,subscriptionType:'max'},async(url,options)=>{
 assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer FAKE_SECRET');return{ok:true,json:async()=>({five_hour:{utilization:42}})};});
 const result=await f.reader.read('direct:claude');assert.ok(!JSON.stringify(result).includes('FAKE_'));assert.equal(result.providers[0].windows[0].usedPercent,42);assert.equal(fs.readFileSync(f.file,'utf8'),f.before);
});
test('expired Claude account never triggers a request; upstream errors never leak response bodies',async t=>{
 let calls=0;const f=fixture(t,{accessToken:'FAKE_SECRET',scopes:['user:profile'],expiresAt:1},async()=>{calls++;throw Error('SECRET');});
 const result=normalizeUsage(await f.reader.read('direct:claude'));assert.equal(calls,0);assert.match(result.providers[0].error,/reconnectez Claude Code/);
 fs.writeFileSync(f.file,JSON.stringify({claudeAiOauth:{accessToken:'FAKE_SECRET',scopes:['user:profile'],expiresAt:Date.now()+60000}}));
 assert.ok(!JSON.stringify(await f.reader.read('direct:claude')).includes('SECRET'));assert.equal(calls,1);
});
function renewFixture(t,oauth,fetchImpl,onRenew){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'fm-renew-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'.claude'));const file=path.join(home,'.claude','.credentials.json');fs.writeFileSync(file,JSON.stringify({claudeAiOauth:oauth}));
 const bin=path.join(home,'bin');fs.mkdirSync(bin);const exe=path.join(bin,process.platform==='win32'?'claude.exe':'claude');fs.writeFileSync(exe,'');
 const spawns=[];
 const spawnImpl=(cmd,args,opts)=>{spawns.push({cmd,args,opts});const child=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>{onRenew?.(file);child.emit('exit',0);});return child;};
 return{file,spawns,reader:createDirectUsage({home,env:{PATH:bin},fetchImpl,spawnImpl})};
}
test('expired Claude access is renewed by Claude Code itself, then read once more',async t=>{
 const seen=[];
 const f=renewFixture(t,{accessToken:'OLD',scopes:['user:profile'],expiresAt:1},async(_u,o)=>{seen.push(o.headers.Authorization);return{ok:true,json:async()=>({five_hour:{utilization:12}})};},
  file=>fs.writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'NEW',scopes:['user:profile'],expiresAt:Date.now()+3600e3}})));
 const result=await f.reader.read('direct:claude');
 assert.deepEqual(f.spawns.map(s=>s.args),[['auth','status']]);assert.equal(f.spawns[0].opts.windowsHide,true);
 assert.deepEqual(seen,['Bearer NEW']);assert.equal(result.providers[0].windows[0].usedPercent,12);
});
test('a refused access (401) is renewed and retried; renewal runs at most once a minute',async t=>{
 const seen=[];
 const f=renewFixture(t,{accessToken:'OLD',scopes:['user:profile'],expiresAt:Date.now()+3600e3},async(_u,o)=>{seen.push(o.headers.Authorization);
  return o.headers.Authorization==='Bearer OLD'?{ok:false,status:401,body:{cancel:async()=>{}}}:{ok:true,json:async()=>({seven_day:{utilization:40}})};},
  file=>fs.writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'NEW',scopes:['user:profile'],expiresAt:Date.now()+3600e3}})));
 assert.equal((await f.reader.read('direct:claude')).providers[0].windows[0].usedPercent,40);
 assert.deepEqual(seen,['Bearer OLD','Bearer NEW']);
 fs.writeFileSync(f.file,JSON.stringify({claudeAiOauth:{accessToken:'OLD',scopes:['user:profile'],expiresAt:1}}));
 const again=normalizeUsage(await f.reader.read('direct:claude'));
 assert.equal(f.spawns.length,1);assert.match(again.providers[0].error,/Claude Code expirée/);
});
