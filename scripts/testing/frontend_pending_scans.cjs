// Real outbox with isolated storage/transports and serialized browser-style locks.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),ts=require(path.join(ROOT,'frontend/node_modules/typescript'));
const crypto=require('node:crypto').webcrypto;
const code=ts.transpileModule(fs.readFileSync(path.join(ROOT,'frontend/state/movementOutbox.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const lanes=new Map(),navigator={locks:{request(key,run){const task=(lanes.get(key)||Promise.resolve()).then(run,run);lanes.set(key,task.catch(()=>{}));return task;}}};
const moduleObject={exports:{}};new Function('module','exports','crypto','navigator',code)(moduleObject,moduleObject.exports,crypto,navigator);
const {MovementOutbox}=moduleObject.exports;
const storage=()=>{const data=new Map();return{getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};};
const checks=[];const check=async(name,run)=>{await run();checks.push(name);};
const offline=()=>Promise.reject(Error('offline'));
const refused=p=>assert.rejects(p,/offline/);
(async()=>{
 await check('Offline-only stage queues across instances without transport and flushes original UUID explicitly',async()=>{
  const s=storage(),sent=[],send=async op=>{sent.push(op);return{};},a=new MovementOutbox('prepared',s,send,()=>{}),b=new MovementOutbox('prepared',s,send,()=>{});
  await Promise.all([a.queueOfflineStage('1',1),b.queueOfflineStage('1',1)]);assert.equal(a.pending().length,1);assert.deepEqual(sent,[]);
  const original=a.pending()[0];await b.flush();assert.deepEqual(sent,[original]);assert.deepEqual(a.pending(),[]);
 });
 await check('Offline-only stage refuses missing locks or failed durable storage without sending',async()=>{
  const s=storage(),q=new MovementOutbox('guard',s,()=>{throw Error('Must not send');},()=>{}),locks=navigator.locks;
  navigator.locks=null;await assert.rejects(q.queueOfflineStage('1',1),/protect offline/);navigator.locks=locks;assert.deepEqual(q.pending(),[]);
  s.setItem=()=>{throw Error('quota');};await assert.rejects(q.queueOfflineStage('1',1),/quota/);assert.deepEqual(q.pending(),[]);
 });
 await check('Repeated offline scan and reloaded outbox keep one original UUID and payload',async()=>{
  const s=storage(),sent=[];let connected=false;
  const send=async op=>{sent.push(JSON.parse(JSON.stringify(op)));if(!connected)throw Error('offline');return{saved:true};};
  const first=new MovementOutbox('one',s,send,()=>{});
  await refused(first.enqueue('1','stage',[2,1]));const original=first.pending()[0];
  await refused(first.enqueue('1','stage',[1,2,1]));
  assert.equal(first.pending().length,1);assert.deepEqual(first.pending()[0],original);
  const reloaded=new MovementOutbox('one',s,send,()=>{});await refused(reloaded.enqueue('1','stage',[1,2]));
  assert.equal(reloaded.pending().length,1);assert.deepEqual(reloaded.pending()[0],original);
  connected=true;await reloaded.flush();assert.equal(reloaded.pending().length,0);
  assert.equal(new Set(sent.map(op=>op.payload.request_id)).size,1);
 });
 await check('Interleaved different assets preserve order while repeated pending item reuses its command',async()=>{
  const s=storage(),q=new MovementOutbox('many',s,offline,()=>{});
  await refused(q.enqueue('1','stage',[1]));await refused(q.enqueue('1','stage',[2]));const original=q.pending();
  await refused(q.enqueue('1','stage',[1]));assert.deepEqual(q.pending(),original);
  const sent=[];await new MovementOutbox('many',s,async op=>{sent.push(op.payload.asset_ids[0]);return{};},()=>{}).flush();assert.deepEqual(sent,[1,2]);
 });
 await check('Opposite intent is a barrier: stage, unstage, stage remain three commands',async()=>{
  const q=new MovementOutbox('opposite',storage(),offline,()=>{});
  for(const action of ['stage','unstage','stage'])await refused(q.enqueue('1',action,[1]));
  assert.deepEqual(q.pending().map(op=>op.payload.action),['stage','unstage','stage']);assert.equal(new Set(q.pending().map(op=>op.payload.request_id)).size,3);
 });
 await check('Another event touching the same item prevents reuse across that intervening intent',async()=>{
  const q=new MovementOutbox('events',storage(),offline,()=>{});
  for(const event of ['1','2','1'])await refused(q.enqueue(event,'stage',[1]));assert.equal(q.pending().length,3);
 });
 await check('Different source, transfer destination and overlapping asset sets remain distinct',async()=>{
  for(const pair of [
   [['1','stage',[1],'qr'],['1','stage',[1],'rfid']],
   [['1','transfer',[1],'qr',2],['1','transfer',[1],'qr',3]],
   [['1','stage',[1,2]],['1','stage',[1]]],
  ]){const q=new MovementOutbox(crypto.randomUUID(),storage(),offline,()=>{});for(const args of pair)await refused(q.enqueue(...args));assert.equal(q.pending().length,2);}
 });
 await check('Two browser owners racing to enqueue the same scan persist one UUID under the shared lock',async()=>{
  const s=storage(),a=new MovementOutbox('tabs',s,offline,()=>{}),b=new MovementOutbox('tabs',s,offline,()=>{});
  const results=await Promise.allSettled([a.enqueue('1','stage',[1]),b.enqueue('1','stage',[1])]);assert(results.every(r=>r.status==='rejected'));
  assert.equal(a.pending().length,1);assert.equal(b.pending()[0].payload.request_id,a.pending()[0].payload.request_id);
 });
 await check('Acknowledged scans do not create a permanent suppression rule',async()=>{
  const ids=[],q=new MovementOutbox('done',storage(),async op=>{ids.push(op.payload.request_id);return{};},()=>{});
  await q.enqueue('1','stage',[1]);await q.enqueue('1','stage',[1]);assert.equal(new Set(ids).size,2);assert.equal(q.pending().length,0);
 });
 await check('Non-asset quantity commands form a conservative barrier and are never coalesced',async()=>{
  const q=new MovementOutbox('quantities',storage(),offline,()=>{});
  await refused(q.enqueue('1','stage',[1]));
  await refused(q.enqueueQuantity('1',{request_id:crypto.randomUUID(),action:'stage',asset_id:2,quantity:1}));
  await refused(q.enqueue('1','stage',[1]));assert.equal(q.pending().length,3);
 });
 await check('Full queue permits reuse of a pending scan but refuses a new item without losing records',async()=>{
  const s=storage(),records=Array.from({length:500},(_,i)=>({eventId:'1',payload:{request_id:crypto.randomUUID(),action:'stage',asset_ids:[i+1],source:'qr'}}));s.setItem('full',JSON.stringify(records));
  const q=new MovementOutbox('full',s,offline,()=>{});await refused(q.enqueue('1','stage',[1]));assert.deepEqual(q.pending(),records);
  await assert.rejects(q.enqueue('1','stage',[501]),/Too many pending/);assert.deepEqual(q.pending(),records);
 });
 await check('Account/origin queue keys stay isolated',async()=>{
  const s=storage(),a=new MovementOutbox('account-a',s,offline,()=>{}),b=new MovementOutbox('account-b',s,offline,()=>{});
  await refused(a.enqueue('1','stage',[1]));await refused(b.enqueue('1','stage',[1]));assert.notEqual(a.pending()[0].payload.request_id,b.pending()[0].payload.request_id);
 });
 await check('Existing duplicate envelopes are retained; new reads reuse the latest equivalent pending envelope',async()=>{
  const s=storage(),records=[1,2].map(()=>({eventId:'1',payload:{request_id:crypto.randomUUID(),action:'stage',asset_ids:[1],source:'qr'}}));s.setItem('legacy',JSON.stringify(records));const q=new MovementOutbox('legacy',s,offline,()=>{});
  await refused(q.enqueue('1','stage',[1]));assert.deepEqual(q.pending(),records);
 });
 console.log(JSON.stringify({passed:checks.length,checks,real_outbox:true,synthetic_storage_transports:true,production_or_staging_changed:false},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
