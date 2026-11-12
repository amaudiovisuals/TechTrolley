const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'../..'),ts=require(path.join(ROOT,'frontend/node_modules/typescript'));
function load(name){const out={};new Function('exports',ts.transpileModule(fs.readFileSync(path.join(ROOT,'frontend/state',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out);return out;}
const{downloadEventPdf}=load('privateDownloads'),{printText}=load('printText');
const checks=[],check=async(name,run)=>{await run();checks.push(name)};
(async()=>{
 let token='synthetic-token',clicked=0,removed=0,revoked=[],timers=[];
 global.localStorage={getItem:()=>token};global.window={setTimeout:(fn,ms)=>{timers.push({fn,ms});}};
 const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
 URL.createObjectURL=()=> 'blob:synthetic';URL.revokeObjectURL=url=>revoked.push(url);
 global.document={body:{appendChild:()=>{}},createElement:()=>({click(){clicked++;assert.equal(this.href,'blob:synthetic');assert.equal(this.download,'Conference_12.pdf');},remove(){removed++}})};
 try{
  await check('Authenticated PDF transport uses only fixed event route and releases object URL after consumption',async()=>{await downloadEventPdf(12,async url=>{assert.equal(url,'/api/conferences/12/download-pdf/');return new Response('%PDF-synthetic',{headers:{'Content-Type':'application/pdf'}})});assert.equal(clicked,1);assert.equal(removed,1);assert.equal(timers[0].ms,60000);assert.deepEqual(revoked,[]);timers[0].fn();assert.deepEqual(revoked,['blob:synthetic']);});
  await check('Missing login and invalid event identifier never fetch',async()=>{let calls=0;token=null;await assert.rejects(downloadEventPdf(12,async()=>{calls++}),/Sign in/);token='synthetic';await assert.rejects(downloadEventPdf('../12',async()=>{calls++}),/Save the event/);assert.equal(calls,0);});
  await check('Permission and missing-file errors do not create a download',async()=>{for(const status of [401,403,404])await assert.rejects(downloadEventPdf(12,async()=>new Response(JSON.stringify({detail:'Synthetic refusal'}),{status,headers:{'Content-Type':'application/json'}})),/Synthetic refusal/);assert.equal(clicked,1);});
  await check('HTML disguised as successful download is refused',async()=>{await assert.rejects(downloadEventPdf(12,async()=>new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}})),/did not return a PDF/);assert.equal(clicked,1);});
  await check('Account switch while reading PDF cannot publish old-account file',async()=>{token='first';await assert.rejects(downloadEventPdf(12,async()=>({ok:true,headers:new Headers({'Content-Type':'application/pdf'}),blob:async()=>{token='second';return new Blob(['%PDF'])}})),/Account changed/);assert.equal(clicked,1);});
  await check('QR print template escapes markup and quoted attributes while preserving readable text',async()=>{const attack=`</div><script>opener.localStorage.clear()</script><img src=x onerror="alert('x')">&`;const safe=printText(attack);assert(!safe.includes('<'));assert(!safe.includes('>'));assert(!safe.includes('"'));assert(!safe.includes("'"));assert(safe.includes('&lt;script&gt;'));assert.equal(printText('A & B'), 'A &amp; B');assert.equal(printText(null),'');});
 }finally{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
 console.log(JSON.stringify({passed:checks.length,checks,scope:'Synthetic helper transports; no business data or physical phone'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
