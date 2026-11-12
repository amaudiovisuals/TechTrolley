// Diagnostic of an exact immutable production build; assertions document gaps,
// not acceptance of cold-offline business workflows. No real API/DB connection.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require(process.env.TT_PLAYWRIGHT_MODULE||'/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const ORIGIN='http://[::1]:4363',revision='fd57e32a894aad20a3b7b1b19db56f99a8c1b97c';
(async()=>{
 assert(process.env.TT_REVIEW_RELEASE&&process.env.TT_TAILWIND_JS,'Supply immutable review directory and private local styles');
 const release=path.resolve(process.env.TT_REVIEW_RELEASE),dist=path.join(release,'frontend/dist'),manifest=JSON.parse(fs.readFileSync(path.join(release,'release-manifest.json')));
 assert.equal(manifest.revision,revision);
 for(const [name,entry]of Object.entries(manifest.files)){if(name.startsWith('frontend/dist/'))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(release,name))).digest('hex'),entry.sha256,name);}
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tt-cold-profile-')),checks=[],errors=[],writes=[],apiReads=[];
 const account={user_id:1,role:'admin',is_staff:true,email:'cold-offline@example.test'},asset={id:1,sku:'COLD-SKU-01',barcode:'COLD-QR-01',alias_name:'Cold offline cable',type:'Cable',quantity:1,status:'Available',is_barcode_added:true,item_price:'0',depreciation_percentage:'0'};
 const event={id:1,revision:0,name:'Cold offline synthetic event',start_date:'2026-10-28',end_date:'2026-10-29',conference_type:'Medical Conference',assets:[],requirements:[],staged_assets:[],crosscheck_assets:[],challan_assets:[],assigned_employees:[],truck_challans_data:[],consumable_data:{},flag_log:[],is_audit:false,challan_number:'COLD-01'};
 const queueKey=`tt:movement:2:${encodeURIComponent(ORIGIN)}:1`,draftKey=`tt:event-draft:2:${encodeURIComponent(ORIGIN)}:1:1`;
 const operation={eventId:'1',payload:{request_id:'92222222-3333-4444-8555-666666666666',action:'stage',asset_ids:[1],source:'qr'}},draft={schema:2,baseRevision:0,form:{id:'1',name:'Preserved cold diagnostic draft'},updatedAt:'2026-10-28T00:00:00Z'};
 let context,server,offline=false;
 const check=async(name,run)=>{console.error(`Checking: ${name}`);await run();checks.push(name);};
 try{
  server=http.createServer((req,res)=>{
   const url=new URL(req.url,ORIGIN);res.setHeader('Cache-Control','no-store');
   if(url.pathname.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');
    if(req.method!=='GET'){writes.push(url.pathname);res.writeHead(405);res.end('{}');return;}
    apiReads.push(url.pathname+url.search);
    const data=url.pathname.endsWith('/my-profile/')?account:url.pathname.endsWith('/company-settings/')?{name:'SYNTHETIC COLD OFFLINE',dashboard_config:{}}:
     url.pathname.endsWith('/asset-stats/')?{total:1,ready:1,in_use:0,maintenance:0}:
     url.pathname.endsWith('/assets/')?(url.searchParams.has('all')?[asset]:{results:[asset],count:1}):url.pathname.endsWith('/assets/1/')?asset:
     url.pathname.endsWith('/conferences/')?[event]:url.pathname.endsWith('/conferences/1/')?event:[];
    res.end(JSON.stringify(data));return;
   }
   const file=path.resolve(dist,url.pathname==='/'?'index.html':'.'+decodeURIComponent(url.pathname));
   if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
   const mime={'.js':'application/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
   res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4363,'::1',resolve);});
  const launch=async(isOffline)=>{
   offline=isOffline;
   const c=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,executablePath:process.env.TT_CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',viewport:{width:1280,height:900}});
   await c.setOffline(isOffline);
   await c.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===ORIGIN)return route.continue();if(!offline&&u.origin==='https://cdn.tailwindcss.com')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(process.env.TT_TAILWIND_JS,'utf8')});return route.abort();});
   return c;
  };
  context=await launch(false);let page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const saved=()=>page.evaluate(({queueKey,draftKey})=>({queue:localStorage.getItem(queueKey),draft:localStorage.getItem(draftKey),token:localStorage.getItem('token')}),{queueKey,draftKey});
  const inventory=async()=>{await page.locator('nav button').filter({hasText:/^Inventory$/}).first().evaluate(button=>button.click());};
  const scan=async()=>{const input=page.getByPlaceholder('Search equipment, SKU, serial, MAC...');await input.fill('COLD-QR-01');await input.press('Enter');};
  await check('Exact built app installs its generated worker and loads synthetic asset/event online',async()=>{
   await page.goto(ORIGIN);await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
   await page.evaluate(account=>{localStorage.setItem('token','synthetic-cold-token');localStorage.setItem('user',JSON.stringify(account));},account);await page.reload();
   await inventory();await scan();await page.getByRole('heading',{name:'Asset Details',exact:true}).waitFor();await page.getByRole('button',{name:'Back to List',exact:true}).click();
   await page.locator('nav button').filter({hasText:/^Conference$/}).first().evaluate(button=>button.click());await page.getByText(event.name,{exact:true}).first().waitFor({state:'attached'});
   assert(apiReads.some(x=>x.startsWith('/api/assets/?all=true')));
  });
  await check('Known loaded-page inventory lookup works offline before memory is discarded',async()=>{
   offline=true;await context.setOffline(true);await inventory();await page.waitForTimeout(2100);await scan();await page.getByRole('heading',{name:'Asset Details',exact:true}).waitFor();
   await page.evaluate(({queueKey,draftKey,operation,draft})=>{localStorage.setItem(queueKey,JSON.stringify([operation]));localStorage.setItem(draftKey,JSON.stringify(draft));},{queueKey,draftKey,operation,draft});
  });
  const assertColdGap=async()=>{
   await page.getByRole('button',{name:/1 movement\(s\) pending/}).waitFor();assert.equal((await saved()).queue,JSON.stringify([operation]));assert.equal((await saved()).draft,JSON.stringify(draft));assert.equal((await saved()).token,'synthetic-cold-token');
   await inventory();await scan();await page.getByText('Unrecognized Scan',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Asset Details',exact:true}).count(),0);await page.getByRole('button',{name:'Dismiss',exact:true}).click();
   await page.locator('nav button').filter({hasText:/^Conference$/}).first().evaluate(button=>button.click());await page.getByText('No conferences found',{exact:true}).waitFor();assert.equal(await page.getByText(event.name,{exact:true}).count(),0);
   const cache=await page.evaluate(async()=>{const urls=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())urls.push(request.url);return urls;});assert(!cache.some(url=>new URL(url).pathname.startsWith('/api/')));
   assert.equal(await page.evaluate(()=>typeof window.tailwind),'undefined');
  };
  await check('Offline reload retains app shell/queue/draft but loses known inventory/events and CDN utility styles',async()=>{
   const reads=apiReads.length;await page.reload({waitUntil:'domcontentloaded'});await assertColdGap();assert.equal(apiReads.length,reads);
  });
  await check('Graceful Chromium process restart with same private profile reproduces the offline data/style gaps',async()=>{
   const reads=apiReads.length;await context.close();context=await launch(true);page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.goto(ORIGIN,{waitUntil:'domcontentloaded'});await assertColdGap();assert.equal(apiReads.length,reads);
  });
  await check('Online reload restores synthetic data/styles while original queue remains explicit and unsent',async()=>{
   offline=false;await context.setOffline(false);await page.reload();await page.getByRole('button',{name:/1 movement\(s\) pending/}).waitFor();await inventory();await scan();await page.getByRole('heading',{name:'Asset Details',exact:true}).waitFor();
   assert.equal((await saved()).queue,JSON.stringify([operation]));assert.equal((await saved()).draft,JSON.stringify(draft));assert.equal(await page.evaluate(()=>typeof window.tailwind),'object');assert.deepEqual(writes,[]);
  });
  assert(errors.length>=2&&errors.every(e=>/tailwind is not defined/.test(e)),JSON.stringify(errors));
  console.log(JSON.stringify({diagnostic_checks:checks.length,checks,review_revision:revision,exact_immutable_dist_hashes_verified:true,actual_generated_worker:true,synthetic_GET_API_only:true,representative_queue_and_draft_seeded:true,graceful_browser_process_restart:true,navigation:'DOM button clicks isolate data behavior when external-style loss affects accessibility; not usability acceptance',external_resources:'Private Tailwind script supplied online only; font/CDN traffic otherwise blocked; HTTP cache disabled by routing, worker cache retained',cold_offline_business_workflow_accepted:false,confirmed_gaps:['Known inventory is memory-only after offline reload/reopen','Conference list is memory-only after offline reload/reopen','Tailwind utility styles depend on uncached external script; inline config raises ReferenceError offline'],expected_runtime_errors:errors,staging_or_production_or_credentials_changed:false},null,2));
 }catch(error){for(const p of context?.pages()||[])console.error(JSON.stringify({url:p.url(),body:(await p.locator('body').innerText()).slice(0,3500),errors}));throw error;}finally{if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
