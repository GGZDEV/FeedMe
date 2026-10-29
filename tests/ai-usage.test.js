'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),express=require('express');
const {normalizeUsage,UsageService,createUsageRouter}=require('../ai-usage');
const NOW=1792657200000;
const payload=()=>({updatedAt:NOW,providers:[{provider:'openai',displayName:'OpenAI',plan:'plus',windows:[{label:'5h',usedPercent:27,resetAt:NOW+100000},{label:'Week',usedPercent:17}]}]});
function fixture(t,readUsage=async()=>payload()) {
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-usage-'));
 t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
 let now=NOW;
 const options={dataDir,readUsage,connections:()=>[{id:'vps',name:'OpenClaw VPS'}],now:()=>now};
 return {dataDir,options,service:new UsageService(options),advance:()=>{now+=130000;}};
}
test('subscription windows show remaining quota, never convert unknown values to zero',()=>{
 const data=payload(); data.providers[0].windows.push({label:'unknown',usedPercent:null},{label:'invalid',usedPercent:'23'},{label:'overflow',usedPercent:105});
 const result=normalizeUsage(data);
 assert.deepEqual(result.providers[0].windows.map(w=>w.remainingPercent),[73,83,0]);
 assert.equal(result.providers[0].name,'ChatGPT / Codex');
 assert.equal(result.providers[0].windows[0].resetAt,NOW+100000);
 assert.equal(result.providers[0].windows[1].resetAt,null);
 assert.throws(()=>normalizeUsage({}));
});
test('quota responses and saved cache exclude credentials, emails and raw upstream errors',async t=>{
 const data=payload(); data.token='SECRET';data.providers[0].accountEmail='private@example.test';data.providers[0].error='SECRET';data.providers[0].billing={key:'SECRET'};
 const f=fixture(t,async()=>data);f.service.configure([{connectionId:'vps'}]);
 const result=await f.service.snapshot();
 const all=JSON.stringify(result)+fs.readFileSync(f.service.file,'utf8');
 assert.ok(!all.includes('SECRET'));assert.ok(!all.includes('private@example.test'));assert.ok(result.sources[0].providers[0].error);
});
test('discovery is read-only; selected subscriptions and last known values survive restart',async t=>{
 const f=fixture(t);await f.service.read('vps');assert.ok(!fs.existsSync(f.service.file));
 f.service.configure([{connectionId:'vps',providers:['openai','anthropic']}]);await f.service.snapshot();
 const restored=new UsageService(f.options); const result=await restored.snapshot();
 assert.equal(result.sources[0].providers.length,2);assert.equal(result.sources[0].providers[1].name,'Claude');
 assert.equal(result.sources[0].providers[1].windows.length,0);assert.ok(result.sources[0].providers[1].error);
 assert.equal(result.sources[0].providers[0].windows[0].remainingPercent,73);
});
test('in-flight reads coalesce; failures keep stale values and cannot trigger a retry storm',async t=>{
 let calls=0,fail=false;const f=fixture(t,async()=>{calls++;await new Promise(r=>setImmediate(r));if(fail)throw new Error('SECRET');return payload();});
 f.service.configure([{connectionId:'vps'}]);await Promise.all([f.service.snapshot(),f.service.snapshot(true)]);assert.equal(calls,1);
 fail=true;f.advance();const result=await f.service.snapshot();assert.equal(calls,2);
 assert.equal(result.sources[0].stale,true);assert.equal(result.sources[0].providers[0].windows[0].remainingPercent,73);
 const cached=await f.service.snapshot(true);assert.equal(calls,2);assert.ok(cached.sources[0].error);
});
test('provider-specific errors preserve last known quota and date',async t=>{
 let data=payload();const f=fixture(t,async()=>data);f.service.configure([{connectionId:'vps'}]);await f.service.snapshot();
 f.advance();data={updatedAt:NOW+130000,providers:[{provider:'openai',error:'upstream failure',windows:[]}]};
 const p=(await f.service.snapshot()).sources[0].providers[0];assert.equal(p.stale,true);assert.equal(p.updatedAt,NOW);assert.equal(p.windows[0].remainingPercent,73);
});
test('invalid and duplicate sources do not replace valid settings; removal discards saved cache',async t=>{
 const f=fixture(t);f.service.configure([{connectionId:'vps'}]);await f.service.snapshot();
 for(const sources of [[{connectionId:'https://arbitrary.test'}],[{connectionId:'vps'},{connectionId:'vps'}],[{connectionId:'vps',providers:['bad/id']}]] )assert.throws(()=>f.service.configure(sources));
 assert.equal(f.service.config().sources.length,1);f.service.configure([]);assert.deepEqual(f.service.data.snapshots,{});
});
test('local API can discover and configure, rejects cross-site requests and arbitrary endpoints',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return payload();});const app=express();app.use(express.json());app.use('/api/ai-usage',createUsageRouter(f.options));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port+'/api/ai-usage';
 assert.equal((await fetch(base+'/config',{headers:{Origin:'https://evil.test'}})).status,403);
 const reboundStatus=await new Promise((resolve,reject)=>require('http').get(base+'/config',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
 assert.equal(reboundStatus,403);
 const post=(url,json)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(json)});
 assert.equal((await post('/discover',{connectionId:'https://evil.test'})).status,400);assert.equal(calls,0);
 assert.equal((await post('/discover',{connectionId:'vps'})).status,200);assert.equal(calls,1);
 assert.equal((await post('/config',{sources:[{connectionId:'vps',providers:['openai']}]})).status,200);
 const res=await fetch(base);assert.equal(res.headers.get('cache-control'),'no-store');assert.equal((await res.json()).sources[0].providers[0].windows[0].remainingPercent,73);
});
