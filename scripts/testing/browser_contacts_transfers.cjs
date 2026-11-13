const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),{chromium,launchOptions}=require('./browser_runtime.cjs');
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON||'python3',['-B',path.join(__dirname,'contacts_transfer_test_server.py')],{cwd:root,stdio:['ignore','pipe','pipe']});
 let log='',server,browser,page,closing=false,transport=Promise.resolve(),timer;const checks=[],errors=[];
 const check=async(name,run)=>{console.error('Checking: '+name);await run();checks.push(name);};
 try{
  await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),15000);backend.stdout.on('data',d=>{log+=d;if(log.includes('SYNTHETIC_CONTACTS_TRANSFER_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',d=>log+=d);backend.once('exit',code=>reject(Error(`Backend ${code}: ${log}`)));});
  const {createServer}=await import(pathToFileURL(path.join(root,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(root,'frontend'),configFile:path.join(root,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4381,strictPort:true}});await server.listen();
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1400,height:1100}});
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
   if(url.origin==='http://127.0.0.1:4381'&&!url.pathname.startsWith('/api/'))return route.continue();
   if(!['http://127.0.0.1:4381','http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
   try{const task=transport.then(()=>route.fetch({url:`http://127.0.0.1:4382${url.pathname}${url.search}`}));transport=task.then(()=>{},()=>{});const response=await task;return route.fulfill({response,headers:{...response.headers(),...headers}});}catch(e){if(!closing)errors.push(e.message);return route.abort().catch(()=>{});}
  });
  await context.addInitScript(()=>{localStorage.setItem('token','synthetic-contacts-transfer-token');localStorage.setItem('user',JSON.stringify({user_id:1,email:'contacts@example.test',role:'admin',is_staff:true}));});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4382/_fixture/inspect/')).json();
  const open=async name=>{await page.getByRole('button',{name:'Conference',exact:true}).first().click();const row=page.getByRole('row').filter({hasText:name});
   await row.getByText('Start date not recorded',{exact:true}).waitFor();
   await row.getByText('End date not recorded',{exact:true}).waitFor();
   await row.getByTitle('Edit Conference Details',{exact:true}).click();};
  const paper=()=>page.locator('.challan-copy').first();
  const openChallan=async name=>{await page.getByRole('button',{name:'Challans',exact:true}).first().click();await page.getByRole('row').filter({hasText:name}).getByRole('button',{name:'View',exact:true}).click();await paper().waitFor();};
  await page.goto('http://127.0.0.1:4381/');await open('Source venue program');
  await check('Customer and named venue save from current details without issuing papers or changing stock',async()=>{
   await page.getByPlaceholder('Customer / Association Name',{exact:true}).fill('Conference form customer');
   await page.getByPlaceholder('Billing Address',{exact:true}).fill('Example billing road');await page.getByPlaceholder('GST Number',{exact:true}).fill('EXAMPLE-GST');
   const saveCustomer=page.getByRole('button',{name:'Save current customer',exact:true});
   assert.equal(await saveCustomer.isDisabled(),true);
   await page.getByLabel('Name for this saved customer',{exact:true}).fill('Saved <Example> customer');
   await page.getByRole('button',{name:'Save current customer',exact:true}).click();await page.getByRole('button',{name:'Use customer Saved <Example> customer',exact:true}).waitFor();
   assert.equal(await page.getByPlaceholder('Customer / Association Name',{exact:true}).inputValue(),'Conference form customer');
   await page.getByLabel('Name for this delivery address',{exact:true}).fill('Hotel — main hall');await page.getByRole('button',{name:'Save named delivery address',exact:true}).click();await page.getByRole('button',{name:'Use delivery address Hotel — main hall',exact:true}).waitFor();
   const state=await inspect();assert.equal(state.customers.length,1);assert.equal(state.venues.length,1);assert.equal(state.source_assets.length,2);assert.equal(state.target_assets.length,0);
   assert.equal(state.source_header.association_name,'Source customer');
   await page.getByLabel('Name for this saved customer',{exact:true}).fill('Renamed <Example> customer');
   await page.getByRole('button',{name:'Update saved customer',exact:true}).click();
   await page.getByRole('button',{name:'Use customer Renamed <Example> customer',exact:true}).waitFor();
   assert.equal((await inspect()).customers.length,1);
  });
  await page.reload();await open('Target venue program');
  await check('Saved suggestions survive reload and autofill customer GST, billing and named delivery address on another program',async()=>{
   await page.getByLabel('Find saved customer',{exact:true}).fill('EXAMPLE-GST');await page.getByRole('button',{name:'Use customer Renamed <Example> customer',exact:true}).click();
   assert.equal(await page.getByPlaceholder('Customer / Association Name',{exact:true}).inputValue(),'Renamed <Example> customer');
   assert.equal(await page.getByPlaceholder('Billing Address',{exact:true}).inputValue(),'Example billing road');assert.equal(await page.getByPlaceholder('GST Number',{exact:true}).inputValue(),'EXAMPLE-GST');
   await page.getByLabel('Find saved delivery address',{exact:true}).fill('main hall');await page.getByRole('button',{name:'Use delivery address Hotel — main hall',exact:true}).click();
   assert.equal(await page.getByPlaceholder('Transport / Delivery Address',{exact:true}).inputValue(),(await inspect()).source_address.trim());
   await page.setViewportSize({width:390,height:844});
   const panel=page.getByRole('region',{name:'Saved customers and venues'});assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
   assert.equal(await page.locator('example').count(),0,'Saved names must be text, not markup');await page.setViewportSize({width:1400,height:1100});
  });
  await page.reload();await open('Source venue program');await page.getByRole('button',{name:'Packup',exact:true}).click();
  await check('Actual transfer uses the source saved full address and changes only current custody',async()=>{
   await page.getByRole('button',{name:'Transfer Assets',exact:true}).click();
   const origin=page.getByLabel('Transfer dispatch venue',{exact:true});assert.equal(await origin.inputValue(),(await inspect()).source_address);assert.equal(await origin.getAttribute('readonly'),'');
   const overlay=origin.locator('..').locator('..');await overlay.getByRole('button').filter({hasText:'Transferred speaker'}).click();
   await overlay.locator('select').selectOption(String((await inspect()).target_id));
   const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/asset-commands/'));saved.catch(()=>{});
   await page.getByRole('button',{name:'Transfer (1)',exact:true}).click();const response=await saved;assert.equal(response.status(),200,await response.text());
   const state=await inspect();assert.equal(state.source_assets.includes(state.moved_id),false);assert.equal(state.target_assets.includes(state.moved_id),true);
  });
  await page.reload();await openChallan('Source venue program');
  await check('Normal outward papers default to four columns and omit warehouse origin',async()=>{
   const headers=await paper().locator('thead th').allTextContents();
   assert.deepEqual(headers.map(s=>s.trim().toUpperCase()),['ALIAS NAME','TYPE','QUANTITY','TOTAL']);
   assert.equal(await paper().getByRole('region',{name:'Dispatched from'}).count(),0);
  });
  await check('Source main and truck return previews and standalone print exclude the transferred asset while original dispatch keeps it',async()=>{
   await paper().getByText('Transferred speaker',{exact:true}).waitFor();await page.getByRole('button',{name:/Return Challan \(/}).click();
   await paper().getByText('Remaining mixer',{exact:true}).waitFor();assert.equal(await paper().getByText('Transferred speaker',{exact:true}).count(),0);
   // The only legacy truck has a single View button alongside its Items control.
   await page.getByRole('button',{name:'View',exact:true}).click();
   assert.equal(await paper().getByText('Transferred speaker',{exact:true}).count(),0);await paper().getByText('Remaining mixer',{exact:true}).waitFor();
   const pending=context.waitForEvent('page');await page.getByRole('button',{name:/^Print Truck 1$/i}).click();const printed=await pending;printed.on('pageerror',e=>errors.push(e.message));
   await printed.locator('.challan-copy').first().getByText('Remaining mixer',{exact:true}).waitFor();assert.equal(await printed.getByText('Transferred speaker',{exact:true}).count(),0);await printed.close();
   await page.getByRole('button',{name:/Original Dispatch \(/}).click();await paper().getByText('Transferred speaker',{exact:true}).waitFor();
  });
  await page.getByRole('button',{name:/Back to List/}).click();await page.getByRole('row').filter({hasText:'Target venue program'}).getByRole('button',{name:'View',exact:true}).click();
  await check('Destination challan shows the complete source venue under Dispatched from on desktop and phone',async()=>{
   const origins=paper().getByRole('region',{name:'Dispatched from'});await origins.waitFor();assert.match(await origins.innerText(),/Source venue program/);
   assert((await origins.innerText()).includes((await inspect()).source_address));
   assert.equal(await origins.evaluate(el=>getComputedStyle(el).fontSize),'8px');
   assert.equal(await origins.locator('..').getByText('Service Receiver',{exact:true}).count(),1);
   await paper().getByText('Transferred speaker',{exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});assert.equal(await origins.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
   await paper().screenshot({path:'/tmp/tt-compact-challan-phone.png'});
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,actual_App_and_Django:true,disposable_database:true,production_changed:false},null,2));
 }catch(e){console.error(log.slice(-2500));if(page)console.error((await page.locator('body').innerText()).slice(-3500));throw e;}
 finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
