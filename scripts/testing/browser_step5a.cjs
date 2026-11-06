const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../..');
const {chromium}=require(process.env.TT_PLAYWRIGHT_MODULE||'/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON || path.join(ROOT,'backend/venv/bin/python'),[path.join(__dirname,'custody_test_server.py')],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
 let log='',timer,server,browser,closing=false,failReview=false,holdReview=false,heldRoutes=[],heldResolve,transport=Promise.resolve();
 const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),15000);backend.stdout.on('data',data=>{log+=data;if(log.includes('SYNTHETIC_CUSTODY_SERVER_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',data=>{log+=data;});backend.once('exit',code=>reject(Error(`Fixture ${code}: ${log}`)));});
 const checks=[],writes=[],errors=[];
 const check=async(name,run)=>{await run();checks.push(name);};
 try{
  await ready;
  const{createServer}=await import(pathToFileURL(path.join(ROOT,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(ROOT,'frontend'),configFile:path.join(ROOT,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4323,strictPort:true}});await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.TT_CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext();
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
   if(url.origin==='http://127.0.0.1:4323')return route.continue();
   if(url.origin!=='http://127.0.0.1:8000')return route.abort();
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}});
   if(request.method()!=='GET')writes.push({path:url.pathname,method:request.method()});
   if(url.pathname.endsWith('/custody-review/')){
    if(holdReview){heldRoutes.push(route);heldResolve();return;}
    if(failReview){return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic review unavailable'}),headers:{'Access-Control-Allow-Origin':'*'}});}
   }
   try{const pending=transport.then(()=>route.fetch({url:`http://127.0.0.1:4324${url.pathname}${url.search}`}));transport=pending.then(()=>{},()=>{});const response=await pending;return route.fulfill({response,headers:{...response.headers(),'Access-Control-Allow-Origin':'*'}});}catch(error){if(!closing)errors.push(error.message);return route.abort().catch(()=>{});}
  });
  await context.addInitScript(()=>{window.tailwind={config:{}};localStorage.setItem('token','synthetic-custody-token');localStorage.setItem('user',JSON.stringify({user_id:1,role:'admin',is_staff:true,email:'custody@example.test'}));});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4324/_fixture/inspect/')).json();
  const before=await inspect();await page.goto('http://127.0.0.1:4323/');
  await page.getByRole('button',{name:'Conference',exact:true}).first().click();
  const open=async()=>page.getByRole('row').filter({hasText:'Audit review fixture'}).getByTitle('Review current custody without changing inventory').click();
  const dialog=()=>page.getByRole('dialog',{name:'Custody review'});
  await check('Actual audit control loads GET preview; mismatch shows actual holder distinction; all stock/history unchanged',async()=>{
   await open();await dialog().getByText('Historical device',{exact:false}).waitFor();
   assert.match(await dialog().innerText(),/1 status differences/);
   assert.match(await dialog().innerText(),/Stored: Crosscheck · Expected from current records: Available/);
   assert.equal(await dialog().getByText('Currently held device',{exact:false}).count(),0);
   assert.equal(writes.length,0);assert.deepEqual(await inspect(),before);
  });
  await check('Review filter exposes healthy-held and restricted rows without a repair action',async()=>{
   await dialog().getByLabel('Show items needing review only').uncheck();
   const current=dialog().locator('[data-asset-id="2"]');assert.match(await current.innerText(),/Stored: In Use.*Expected from current records: In Use/);
   const missing=dialog().locator('[data-asset-id="3"]');assert.match(await missing.innerText(),/Restriction: Missing/);
   assert.equal(await dialog().getByRole('button',{name:/apply|release|repair/i}).count(),0);
   await dialog().getByRole('button',{name:'Close custody review'}).click();
  });
  await check('HTTP failure is an error, not an empty result; retry restores preview',async()=>{
   failReview=true;await open();await dialog().getByRole('alert').getByText('Synthetic review unavailable').waitFor();
   assert.equal(await dialog().getByText(/No status differences/).count(),0);
   failReview=false;await dialog().getByRole('button',{name:'Retry review'}).click();await dialog().getByText(/1 status differences/).waitFor();
   await dialog().getByRole('button',{name:'Close custody review'}).click();
  });
  await check('Closed review ignores late response and does not reopen or mutate data',async()=>{
   const heldReady=new Promise(resolve=>{heldResolve=resolve;});
   holdReview=true;await open();await dialog().getByText('Loading current custody…').waitFor();
   await heldReady;assert.ok(heldRoutes.length);await dialog().getByRole('button',{name:'Close custody review'}).click();holdReview=false;
   const completed=page.waitForResponse(response=>response.url().endsWith('/custody-review/')&&response.status()===200);
   for(const route of heldRoutes.splice(0)){const response=await route.fetch({url:'http://127.0.0.1:4324/api/conferences/2/custody-review/'});await route.fulfill({response,headers:{...response.headers(),'Access-Control-Allow-Origin':'*'}});}
   await(await completed).finished();assert.equal(await page.getByRole('dialog',{name:'Custody review'}).count(),0);
   assert.equal(writes.length,0);assert.deepEqual(await inspect(),before);
  });
  await check('Keyboard focus stays in the modal; Escape closes and restores the opener',async()=>{
   await open();await dialog().getByText(/1 status differences/).waitFor();
   await dialog().getByRole('button',{name:'Reload review'}).focus();await page.keyboard.press('Tab');
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Close custody review');
   await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'Custody review'}).count(),0);
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('title')),'Review current custody without changing inventory');
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,business_database:false,actual_app:true,transport:'Django in-memory SQLite; external requests aborted'},null,2));
 }finally{closing=true;clearTimeout(timer);for(const route of heldRoutes)await route.abort().catch(()=>{});if(browser)await browser.close();if(server)await server.close();backend.kill('SIGTERM');}
})().catch(error=>{console.error(error);process.exitCode=1;});
