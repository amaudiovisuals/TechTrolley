const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),{chromium,launchOptions}=require('./browser_runtime.cjs');
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON||'python3',['-B',path.join(__dirname,'quantity_transfer_test_server.py')],{cwd:root,stdio:['ignore','pipe','pipe']});
 let log='',server,browser,page,closing=false,transport=Promise.resolve(),timer,loseReply=true;const checks=[],errors=[],transfers=[];
 const check=async(name,run)=>{console.error('Checking: '+name);await run();checks.push(name);};
 try{
  await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),15000);backend.stdout.on('data',d=>{log+=d;if(log.includes('SYNTHETIC_QUANTITY_TRANSFER_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',d=>log+=d);backend.once('exit',code=>reject(Error(`Backend ${code}: ${log}`)));});
  const {createServer}=await import(pathToFileURL(path.join(root,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(root,'frontend'),configFile:path.join(root,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4411,strictPort:true}});await server.listen();
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1400,height:1100}});
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
   if(url.origin==='http://127.0.0.1:4411'&&!url.pathname.startsWith('/api/'))return route.continue();
   if(!['http://127.0.0.1:4411','http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
   const transfer=req.method()==='POST'&&url.pathname.endsWith('/quantity-transfers/');if(transfer)transfers.push(req.postDataJSON());
   try{const task=transport.then(()=>route.fetch({url:`http://127.0.0.1:4412${url.pathname}${url.search}`}));transport=task.then(()=>{},()=>{});const response=await task;
    if(transfer&&loseReply){loseReply=false;assert.equal(response.status(),200,await response.text());return route.abort('failed');}
    return route.fulfill({response,headers:{...response.headers(),...headers}});
   }catch(e){if(!closing)errors.push(e.message);return route.abort().catch(()=>{});}
  });
  await context.addInitScript(()=>{localStorage.setItem('token','synthetic-quantity-transfer-token');localStorage.setItem('user',JSON.stringify({user_id:1,email:'transfer@example.test',role:'admin',is_staff:false}));});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4412/_fixture/inspect/')).json();
  const open=async name=>{await page.getByRole('button',{name:'Conference',exact:true}).first().click();await page.getByRole('row').filter({hasText:name}).getByTitle('Edit Conference Details',{exact:true}).click();};
  const paper=()=>page.locator('.challan-copy').first();
  const openChallan=async name=>{await page.getByRole('button',{name:'Challans',exact:true}).first().click();await page.getByRole('row').filter({hasText:name}).getByRole('button',{name:'View',exact:true}).click();await paper().waitFor();};
  const assertPaperQuantity=async amount=>{const row=paper().locator('tr').filter({hasText:'Transfer cable master'});await row.waitFor();assert((await row.locator('td').allTextContents()).some(value=>value.trim()===String(amount)),await row.innerText());};
  const savedResponse=endpoint=>{const result=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(endpoint));result.catch(()=>{});return result;};
  await page.goto('http://127.0.0.1:4411/');await open('Quantity source A');await page.getByRole('button',{name:'Packup',exact:true}).click();
  await check('Phone transfer selects eight of twenty on-site units, preserving the saved source venue',async()=>{
   await page.getByRole('button',{name:'Transfer Assets',exact:true}).click();
   const origin=page.getByLabel('Transfer dispatch venue',{exact:true}),overlay=origin.locator('..').locator('..');
   assert.equal(await origin.inputValue(),(await inspect()).source_address);
   await overlay.getByPlaceholder('Scan or type QR / Barcode...').fill('TRANSFER-CABLE');await overlay.getByPlaceholder('Scan or type QR / Barcode...').press('Enter');
   const quantity=page.getByLabel('Transfer quantity TRANSFER-CABLE',{exact:true});assert.equal(await quantity.inputValue(),'20');await quantity.fill('8');
   await overlay.locator('select').selectOption(String((await inspect()).target_id));await page.setViewportSize({width:390,height:844});
   const confirm=page.getByRole('button',{name:'Transfer (8)',exact:true});assert.equal(await confirm.isEnabled(),true);
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='Transfer (8)'&&getComputedStyle(el).opacity==='1'));
   const contrast=await confirm.evaluate(el=>{const luminance=color=>color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);const css=getComputedStyle(el),a=luminance(css.color),b=luminance(css.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});assert(contrast>=4.5,'Transfer confirmation must remain readable');
   assert.equal(await quantity.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true);
   if(process.env.TT_TEST_SCREENSHOT)await page.screenshot({path:process.env.TT_TEST_SCREENSHOT});
   await page.getByRole('button',{name:'Transfer (8)',exact:true}).click();await page.getByRole('button',{name:'1 movement(s) pending — retry',exact:true}).waitFor();
   const state=await inspect();assert.equal(state.source,12);assert.equal(state.target.dispatched,8);assert.equal(state.available,80);assert.equal(state.stock,100);assert.equal(state.source_document_quantity,20);
  });
  await check('A lost transfer response recovers the same saved request once and updates both programs',async()=>{
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
   const response=savedResponse('/quantity-transfers/');await page.getByRole('button',{name:'1 movement(s) pending — retry',exact:true}).click();assert.equal((await response).status(),200);
   assert.equal(transfers.length,2);assert.deepEqual(transfers[0],transfers[1]);assert.equal((await inspect()).transfers,1);
   await page.setViewportSize({width:1400,height:1100});
   await page.getByText('12 units on site',{exact:true}).waitFor();
  });
  await page.reload();await openChallan('Quantity source A');
  await check('Source original challan keeps twenty while its current return challan shows twelve',async()=>{
   await assertPaperQuantity(20);await page.getByRole('button',{name:/Return Challan \(/}).click();await assertPaperQuantity(12);
  });
  await page.getByRole('button',{name:/Back to List/}).click();await page.getByRole('row').filter({hasText:'Quantity target B'}).getByRole('button',{name:'View',exact:true}).click();
  await check('Destination challan shows eight and the complete venue A dispatch address',async()=>{
   await assertPaperQuantity(8);const origins=paper().getByRole('region',{name:'Dispatched from'});assert((await origins.innerText()).includes((await inspect()).source_address));
   assert.match(await origins.innerText(),/TRANSFER-CABLE × 8/);
   await page.setViewportSize({width:390,height:844});assert.equal(await origins.evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.setViewportSize({width:1400,height:1100});
  });
  await check('Customer and supplier papers both save eight units and freeze the venue origin',async()=>{
   await page.getByRole('button',{name:'Edit Mode',exact:true}).click();const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/challan-documents/'));saved.catch(()=>{});
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();assert.equal((await saved).status(),200);
   await page.getByRole('button',{name:'New delivery',exact:true}).click();assert.equal(await page.getByLabel('Quantity TRANSFER-CABLE',{exact:true}).inputValue(),'8');
   await page.getByRole('button',{name:'Issue delivery challans',exact:true}).click();await page.getByText(/OUT-000001 — saved copy/).waitFor();
   const state=await inspect();assert.equal(state.records,1);assert.equal(state.owner_id,1);
   for(const doc of [state.packets[0].customer_document,...state.packets[0].supplier_documents]){assert.equal(doc.rows[0].quantity,8);assert.equal(doc.dispatch_origins.length,1);assert.equal(doc.dispatch_origins[0].address,state.source_address);}
   const supplier=state.packets[0].supplier_documents[0];assert.equal(supplier.destination,'Synthetic godown road');assert.equal(supplier.vehicle_number,'');assert.equal(supplier.driver_phone,'');
   await page.getByRole('button',{name:new RegExp(`Synthetic AM — ${supplier.number}`)}).click();const print=page.frameLocator(`iframe[title="Saved challan ${supplier.number}"]`);
   await print.getByText('Dispatched from',{exact:true}).first().waitFor();assert((await print.locator('body').innerText()).includes(state.source_address));
  });
  await page.reload();await open('Quantity target B');await page.getByRole('button',{name:'Packup',exact:true}).click();
  await check('Receiving program can return and verify only part of its transferred quantity',async()=>{
   const scan=async action=>{const input=page.locator('input[placeholder="Scan to remove/verify..."]:visible').first();await input.fill('TRANSFER-CABLE');await input.press('Enter');
    const modal=page.getByRole('heading',{name:'Select Quantity',exact:true}).locator('..').locator('..').locator('..');await modal.locator('input[type=number]').fill('3');const response=savedResponse('/quantity-commands/');
    await modal.getByRole('button',{name:new RegExp(`^${action.replace('_',' ')}`,'i')}).click();assert.equal((await response).status(),200);await modal.waitFor({state:'hidden'});};
   await scan('return');await page.getByRole('button',{name:'Crosscheck',exact:true}).click();await scan('verify_return');
   const state=await inspect();assert.equal(state.source,12);assert.equal(state.target.dispatched,5);assert.equal(state.target.verified_total,3);assert.equal(state.available,83);assert.equal(state.packets[0].customer_document.rows[0].quantity,8);
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,actual_App_and_Django:true,disposable_database:true,production_changed:false},null,2));
 }catch(e){console.error(log.slice(-2500));if(page)console.error((await page.locator('body').innerText()).slice(-3500));throw e;}
 finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
