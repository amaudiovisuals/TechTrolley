// Actual App + expiring DRF authentication. Disposable loopback memory DB only.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../..'),ORIGIN='http://127.0.0.1:4349',API='http://127.0.0.1:4350';
const {chromium}=require(process.env.TT_PLAYWRIGHT_MODULE||'/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON||path.join(ROOT,'backend/venv/bin/python'),[path.join(__dirname,'security_test_server.py')],{cwd:ROOT,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
 let log='',timer,server,browser,closing=false,offlineMovement=false,transport=Promise.resolve();const checks=[],errors=[],writes=[];
 const check=async(name,run)=>{console.error(`Checking: ${name}`);await run();checks.push(name);};
 const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),20000);backend.stdout.on('data',d=>{log+=d;if(log.includes('SYNTHETIC_SECURITY_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',d=>{log+=d;});backend.once('exit',code=>reject(Error(`Fixture exited ${code}: ${log}`)));});
 try{
  await ready;const {createServer}=await import(pathToFileURL(path.join(ROOT,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(ROOT,'frontend'),configFile:path.join(ROOT,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4349,strictPort:true}});await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.TT_CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin==='https://cdn.tailwindcss.com'&&process.env.TT_TAILWIND_JS)return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(process.env.TT_TAILWIND_JS,'utf8')});
   if(url.origin===ORIGIN&&!url.pathname.startsWith('/api/'))return route.continue();
   if(![ORIGIN,'http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
   if(url.pathname.endsWith('/asset-commands/'))writes.push({payload:req.postDataJSON(),authorization:req.headers().authorization});
   if(offlineMovement&&url.pathname.endsWith('/asset-commands/'))return route.abort('internetdisconnected');
   try{const task=transport.then(()=>route.fetch({url:`${API}${url.pathname}${url.search}`}));transport=task.then(()=>{},()=>{});const response=await task;return route.fulfill({response,headers:{...response.headers(),...headers}});}catch(error){if(!closing)errors.push(error.message);return route.abort().catch(()=>{});}
  });
  await context.addInitScript(()=>{window.tailwind={config:{}};});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const inspect=async()=>(await page.request.get(`${API}/_fixture/inspect/`)).json();
  const login=async(email='security-admin@example.test',password='Blue!Field-Maple-7832')=>{await page.locator('input[type=email]').fill(email);await page.locator('input[type=password]').fill(password);await page.getByRole('button',{name:'Secure Login',exact:true}).click();};
  await page.goto(ORIGIN);await login();await page.getByRole('button',{name:'Conference',exact:true}).first().waitFor();
  const fixture=await inspect(),queueKey=`tt:movement:2:${encodeURIComponent(ORIGIN)}:${fixture.actor_id}`,draftKey=`tt:event-draft:2:${encodeURIComponent(ORIGIN)}:${fixture.actor_id}:${fixture.event_id}`;
  const saved=()=>page.evaluate(({queueKey,draftKey})=>({queue:localStorage.getItem(queueKey),draft:localStorage.getItem(draftKey),token:localStorage.getItem('token')}),{queueKey,draftKey});
  let original,draftRaw,oldToken;
  await check('Actual typed scan transport failure saves one envelope; representative draft is retained',async()=>{
   await page.addStyleTag({content:'.fa-solid{display:inline-block;min-width:1em;min-height:1em}'});
   await page.getByRole('button',{name:'Conference',exact:true}).first().click();await page.getByTitle('Edit Conference Details',{exact:true}).first().click();await page.getByRole('button',{name:'Requirements',exact:true}).click();
   offlineMovement=true;const input=page.getByPlaceholder('Scan to add equipment...');await input.fill('SEC-QR');await input.press('Enter');await page.getByText(/Movement not confirmed:/).waitFor();
   const state=await saved();original=state.queue;oldToken=state.token;assert.equal(JSON.parse(original).length,1);assert.deepEqual(JSON.parse(original)[0].payload,writes[0].payload);
   draftRaw=JSON.stringify({schema:2,baseRevision:0,form:{id:String(fixture.event_id),name:'Synthetic unsaved auth recovery draft'},updatedAt:new Date().toISOString()});
   await page.evaluate(({draftKey,draftRaw})=>localStorage.setItem(draftKey,draftRaw),{draftKey,draftRaw});
   assert.equal((await inspect()).receipts,0);assert.deepEqual((await inspect()).staged,[]);
  });
  await check('Real expired-token Retry returns 401/login and preserves exact pending UUID and draft',async()=>{
   offlineMovement=false;await page.request.post(`${API}/_fixture/expire/`);
   const response=page.waitForResponse(r=>r.url().endsWith('/asset-commands/'));
   await page.getByRole('button',{name:/1 movement\(s\) pending/}).click();const failed=await response;assert.equal(failed.status(),401);assert.match(await failed.text(),/Login expired/);
   await page.getByRole('button',{name:'Secure Login',exact:true}).waitFor();const state=await saved();assert.equal(state.token,null);assert.equal(state.queue,original);assert.equal(state.draft,draftRaw);assert.equal((await inspect()).receipts,0);
  });
  await check('Login-screen reload and wrong password do not erase or send saved work',async()=>{
   const count=writes.length;await page.reload();await login('security-admin@example.test','wrong-password');await page.getByText('Invalid Credentials',{exact:true}).waitFor();
   assert.equal((await saved()).queue,original);assert.equal((await saved()).draft,draftRaw);assert.equal((await saved()).token,null);assert.equal(writes.length,count);assert.equal((await inspect()).receipts,0);
  });
  await check('Different account cannot see or automatically replay the original account queue',async()=>{
   const count=writes.length;await login('security-tech@example.test');await page.getByRole('button',{name:'Sign out shared login',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:/movement\(s\) pending/}).count(),0);assert.equal((await saved()).queue,original);assert.equal((await saved()).draft,draftRaw);assert.equal(writes.length,count);
   await page.getByRole('button',{name:'Sign out shared login',exact:true}).click();await page.getByRole('button',{name:'Secure Login',exact:true}).waitFor();
  });
  await check('Same-account normal login restores one original pending command without automatic replay',async()=>{
   const count=writes.length;await login();await page.getByRole('button',{name:/1 movement\(s\) pending/}).waitFor();const state=await saved();assert(state.token&&state.token!==oldToken);assert.equal(state.queue,original);assert.equal(state.draft,draftRaw);assert.equal(writes.length,count);assert.equal((await inspect()).receipts,0);
   assert.equal((await page.request.get(`${API}/api/my-profile/`,{headers:{Authorization:`Token ${oldToken}`}})).status(),401);
  });
  await check('Explicit Retry uses new token with original payload, commits once, retains draft across reload',async()=>{
   const token=(await saved()).token,response=page.waitForResponse(r=>r.url().endsWith('/asset-commands/'));
   await page.getByRole('button',{name:/1 movement\(s\) pending/}).click();assert.equal((await response).status(),200);await page.getByText('✅ Pending movements confirmed',{exact:true}).waitFor();
   assert.deepEqual(writes.at(-1).payload,JSON.parse(original)[0].payload);assert.equal(writes.at(-1).authorization,`Token ${token}`);assert.equal((await saved()).queue,'[]');assert.equal((await saved()).draft,draftRaw);
   const count=writes.length;await page.reload();await page.getByRole('button',{name:'Conference',exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:/movement\(s\) pending/}).count(),0);assert.equal(writes.length,count);assert.equal((await saved()).draft,draftRaw);const state=await inspect();assert.equal(state.receipts,1);assert.deepEqual(state.staged,[fixture.asset_id]);
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,actual_App_and_expiring_DRF:true,synthetic_memory_SQLite:true,representative_draft_seeded:true,physical_phone_or_staging_changed:false},null,2));
 }catch(error){console.error(log);throw error;}finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill('SIGTERM');}
})().catch(error=>{console.error(error);process.exitCode=1;});
