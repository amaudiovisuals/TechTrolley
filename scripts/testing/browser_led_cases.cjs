const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),{chromium,launchOptions}=require('./browser_runtime.cjs');
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON||'python3',['-B',path.join(__dirname,'led_case_test_server.py')],{cwd:root,stdio:['ignore','pipe','pipe']});
 let log='',server,browser,page,closing=false,transport=Promise.resolve(),timer;const checks=[],errors=[];
 const check=async(name,run)=>{console.error('Checking: '+name);await run();checks.push(name);};
 try{
  await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),15000);backend.stdout.on('data',d=>{log+=d;if(log.includes('SYNTHETIC_LED_CASE_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',d=>log+=d);backend.once('exit',code=>reject(Error(`Backend ${code}: ${log}`)));});
  const {createServer}=await import(pathToFileURL(path.join(root,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(root,'frontend'),configFile:path.join(root,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4401,strictPort:true}});await server.listen();
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1400,height:1100}});
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
   if(url.origin==='http://127.0.0.1:4401'&&!url.pathname.startsWith('/api/'))return route.continue();
   if(!['http://127.0.0.1:4401','http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
   try{const task=transport.then(()=>route.fetch({url:`http://127.0.0.1:4402${url.pathname}${url.search}`}));transport=task.then(()=>{},()=>{});const response=await task;return route.fulfill({response,headers:{...response.headers(),...headers}});}catch(e){if(!closing)errors.push(e.message);return route.abort().catch(()=>{});}
  });
  await context.addInitScript(()=>{localStorage.setItem('token','synthetic-led-case-token');localStorage.setItem('user',JSON.stringify({user_id:1,email:'led@example.test',role:'admin',is_staff:true}));});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4402/_fixture/inspect/')).json();
  const open=async name=>{await page.getByRole('button',{name:'Conference',exact:true}).first().click();await page.getByRole('row').filter({hasText:name}).getByTitle('Edit Conference Details',{exact:true}).click();};
  const paper=()=>page.locator('.challan-copy').first();
  const openChallan=async name=>{await page.getByRole('button',{name:'Challans',exact:true}).first().click();await page.getByRole('row').filter({hasText:name}).getByRole('button',{name:'View',exact:true}).click();await paper().waitFor();};
  await page.goto('http://127.0.0.1:4401/');await open('Synthetic LED event');
  const picker=()=>page.getByRole('dialog',{name:'Select LED box panels'});
  const scan=async()=>{const input=page.locator('input[placeholder="Search or scan requirement..."]:visible, input[placeholder="Scan to remove/verify..."]:visible, input[placeholder="Scan to add equipment..."]:visible').first();await input.fill('OLD-P2-QR');await input.press('Enter');await picker().getByRole('checkbox').first().waitFor();};
  const confirm=async count=>{const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/asset-commands/'));saved.catch(()=>{});await picker().getByRole('button',{name:`Confirm ${count} panels`,exact:true}).click();const response=await saved;assert.equal(response.status(),200,await response.text());await picker().waitFor({state:'hidden'});};
  await page.getByRole('button',{name:'Requirements',exact:true}).click();
  await check('Old box QR opens six individual panel choices with actual two/four owners; changing a choice creates no movement',async()=>{
   await scan();assert.equal(await picker().getByRole('checkbox').count(),6);assert.equal(await picker().getByRole('checkbox',{checked:true}).count(),6);
   assert.equal(await picker().getByText(/Synthetic AM/).count(),4);assert.equal(await picker().getByText(/Synthetic Pvt Ltd/).count(),2);
   const checkbox=picker().getByRole('checkbox').last();await checkbox.uncheck();await page.waitForTimeout(2200);assert.equal(await checkbox.isChecked(),false);assert.equal((await inspect()).staged.length,0);await checkbox.check();
   await page.setViewportSize({width:390,height:844});assert.equal(await picker().evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.setViewportSize({width:1400,height:1100});
   await confirm(6);const state=await inspect();assert.equal(state.staged.length,6);assert(!state.staged.includes(state.source_id));
  });
  await check('Dispatch moves six panel IDs atomically and the old case is not additional stock',async()=>{
   const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/asset-commands/'));saved.catch(()=>{});await page.getByRole('button',{name:'Submit Dispatch to Show',exact:true}).click();assert.equal((await saved).status(),200);
   const state=await inspect();assert.equal(state.active.length,6);assert.equal(state.stock.totals.all_permanent,6);assert.equal(state.conversions,1);assert.equal(state.panels,6);
  });
  await openChallan('Synthetic LED event');
  await check('Customer delivery contains six panels and supplier delivery contains only its four panels',async()=>{
   await page.getByRole('button',{name:'Edit Mode',exact:true}).click();const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/challan-documents/'));saved.catch(()=>{});await page.getByRole('button',{name:'Save Changes',exact:true}).click();assert.equal((await saved).status(),200);
   await page.getByRole('button',{name:'New delivery',exact:true}).click();await page.getByRole('button',{name:'Issue delivery challans',exact:true}).click();await page.getByText(/OUT-000001 — saved copy/).waitFor();
   const state=await inspect(),packet=state.packets[0];assert.equal(packet.customer_document.rows.reduce((n,row)=>n+row.quantity,0),6);assert.equal(packet.supplier_documents[0].rows.reduce((n,row)=>n+row.quantity,0),4);assert(!packet.customer_document.rows.some(row=>row.asset_id===state.source_id));
  });
  await page.reload();await open('Synthetic LED event');await page.getByRole('button',{name:'Packup',exact:true}).click();
  await check('A box scan can return only two chosen panels and crosscheck offers only those two',async()=>{
   await scan();const boxes=picker().getByRole('checkbox');for(let i=2;i<6;i++)await boxes.nth(i).uncheck();await confirm(2);let state=await inspect();assert.equal(state.active.length,4);assert.equal(state.unchecked.length,2);
   await page.getByRole('button',{name:'Crosscheck',exact:true}).click();await scan();assert.equal(await picker().getByRole('checkbox',{checked:true}).count(),2);await confirm(2);state=await inspect();assert.equal(state.unchecked.length,0);assert.equal(state.active.length,4);
  });
  await page.getByRole('button',{name:'Packup',exact:true}).click();
  await check('Venue transfer scans select only the four registered panels still on site',async()=>{
   await page.getByRole('button',{name:'Transfer Assets',exact:true}).click();await page.getByPlaceholder('Scan or type QR / Barcode...').fill('OLD-P2-QR');await page.getByPlaceholder('Scan or type QR / Barcode...').press('Enter');
   const origin=page.getByLabel('Transfer dispatch venue',{exact:true});await origin.locator('..').locator('..').locator('select').selectOption(String((await inspect()).target_id));
   const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/asset-commands/'));saved.catch(()=>{});await page.getByRole('button',{name:'Transfer (4)',exact:true}).click();assert.equal((await saved).status(),200);
   const state=await inspect();assert.equal(state.active.length,0);assert.equal(state.target_active.length,4);assert(!state.target_active.includes(state.source_id));assert.equal(state.panels,6);
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,actual_App_and_Django:true,disposable_database:true,production_changed:false},null,2));
 }catch(e){console.error(log.slice(-2500));if(page)console.error((await page.locator('body').innerText()).slice(-3500));throw e;}
 finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
