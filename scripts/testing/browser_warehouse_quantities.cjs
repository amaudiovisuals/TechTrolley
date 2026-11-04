const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..');
const QR=require(path.join(root,'frontend/node_modules/qrcode'));
const {chromium,launchOptions}=require('./browser_runtime.cjs');
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON||'python3',['-B',path.join(__dirname,'warehouse_quantity_test_server.py')],{cwd:root,stdio:['ignore','pipe','pipe']});
 let log='',server,browser,page,closing=false,transport=Promise.resolve(),timer;const checks=[],errors=[],writes=[];
 const check=async(name,fn)=>{console.error('Checking: '+name);await fn();checks.push(name);};
 try{
  await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),15000);backend.stdout.on('data',d=>{log+=d;if(log.includes('SYNTHETIC_WAREHOUSE_QUANTITY_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',d=>log+=d);backend.once('exit',code=>reject(Error(`Backend ${code}: ${log}`)));});
  const {createServer}=await import(pathToFileURL(path.join(root,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(root,'frontend'),configFile:path.join(root,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4371,strictPort:true}});await server.listen();
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1400,height:1100}});
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
   if(url.origin==='http://127.0.0.1:4371'&&!url.pathname.startsWith('/api/'))return route.continue();
   if(!['http://127.0.0.1:4371','http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
   if(req.method()!=='GET')writes.push({path:url.pathname,body:req.postDataJSON()});
   try{const task=transport.then(()=>route.fetch({url:`http://127.0.0.1:4372${url.pathname}${url.search}`}));transport=task.then(()=>{},()=>{});const response=await task;return route.fulfill({response,headers:{...response.headers(),...headers}});}catch(e){if(!closing)errors.push(e.message);return route.abort().catch(()=>{});}
  });
  const qr=await QR.toDataURL('AM-BULK',{width:220,margin:4});
  await context.addInitScript(qr=>{localStorage.setItem('token','synthetic-warehouse-quantity-token');localStorage.setItem('user',JSON.stringify({user_id:1,email:'quantity@example.test',role:'admin',is_staff:false}));
   window.__streams=[];navigator.mediaDevices.getUserMedia=async()=>{const img=new Image();img.src=qr;await img.decode();const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d');const draw=()=>{ctx.fillStyle='white';ctx.fillRect(0,0,640,480);ctx.drawImage(img,210,130,220,220);};draw();const stream=canvas.captureStream(15),timer=setInterval(draw,60);stream.getTracks().forEach(track=>{const stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};});window.__streams.push(stream);return stream;};
  },qr);
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const waitFor=(predicate)=>{const promise=page.waitForResponse(predicate);promise.catch(()=>{});return promise;};
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4372/_fixture/inspect/')).json();
  const open=async()=>{await page.getByRole('button',{name:'Conference',exact:true}).first().click();await page.getByTitle('Edit Conference Details',{exact:true}).first().click();};
  const readablePanel=async(panel,mode)=>{
   await page.setViewportSize({width:390,height:844});
   for(const theme of ['blue','green']){
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    const failures=await panel.evaluate(section=>{
     const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
     const luminance=values=>values.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
     return [...section.querySelectorAll('h2,h3,h4,p,label,th,td,input[type=number],button:not([disabled])')].filter(el=>el.getBoundingClientRect().width>0).map(el=>{
      const style=getComputedStyle(el);let node=el,bg='rgba(0, 0, 0, 0)';while(node&&bg==='rgba(0, 0, 0, 0)'){bg=getComputedStyle(node).backgroundColor;node=node.parentElement;}
      const a=luminance(rgb(style.color)),b=luminance(rgb(bg));return {text:el.textContent||el.getAttribute('aria-label'),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
     }).filter(result=>result.ratio<4.5);
    });assert.deepEqual(failures,[],`${mode} panel contrast in ${theme} theme`);
   }
   await page.evaluate(()=>document.documentElement.dataset.theme='blue');await page.setViewportSize({width:1400,height:1100});
  };
  const readableConsumables=mode=>readablePanel(page.locator(`[data-testid^="consumable-${mode}-"]`).locator('..'),mode);
  const scan=async(code,amount,action)=>{
   const input=page.locator('input[placeholder="Search or scan requirement..."]:visible, input[placeholder="Scan to remove/verify..."]:visible, input[placeholder="Scan to add equipment..."]:visible').first();
   await input.fill(code);await input.press('Enter');
   const modal=page.getByRole('heading',{name:'Select Quantity',exact:true}).locator('..').locator('..').locator('..');
   await modal.locator('input[type=number]').fill(String(amount));
   const saved=action==='consumable-draft'?null:waitFor(r=>r.request().method()==='POST'&&r.url().endsWith('/quantity-commands/'));
   await modal.getByRole('button',{name:new RegExp(action==='consumable-draft'?'^Add':`^${action.replace('_',' ')}`,'i')}).click();
   if(saved){const response=await saved;assert.equal(response.status(),200,await response.text());}
   await page.getByRole('heading',{name:'Select Quantity',exact:true}).waitFor({state:'hidden'});
  };
  await page.goto('http://127.0.0.1:4371/');
  await check('Ownership dashboard and completion/reconciliation reviews remain readable in both phone themes without applying changes',async()=>{
   const ownership=page.getByRole('region',{name:'Inventory by owner'});await ownership.getByRole('table').waitFor();await readablePanel(ownership,'ownership dashboard');
   await page.getByRole('button',{name:'Conference',exact:true}).first().click();
   await page.getByRole('button',{name:'Review completion for Synthetic shared quantity event',exact:true}).click();
   const completion=page.getByRole('dialog');await completion.getByText('Recorded state: open',{exact:true}).waitFor();await readablePanel(completion,'completion');await completion.getByRole('button',{name:'Close event completion review',exact:true}).click();
   await page.getByRole('button',{name:'Review reconciliation for Synthetic shared quantity event',exact:true}).click();
   const reconciliation=page.getByRole('dialog');await reconciliation.getByRole('heading',{name:'Reviewed inventory reconciliation',exact:true}).waitFor();await reconciliation.getByText('Loading current evidence…',{exact:true}).waitFor({state:'hidden'});await readablePanel(reconciliation,'reconciliation');await reconciliation.getByRole('button',{name:'Close reconciliation review',exact:true}).click();
   assert.equal(writes.length,0,'Opening readability reviews must not change stock or lifecycle');
  });
  await open();await page.getByRole('button',{name:'Requirements',exact:true}).click();
  await check('Supplier camera scan hands off one selected partial count without repeated-read resets',async()=>{
   await page.getByTitle('Scan with Camera',{exact:true}).first().click();
   const modal=page.getByRole('heading',{name:'Select Quantity',exact:true}).locator('..').locator('..').locator('..');
   await modal.locator('input[type=number]').waitFor();await modal.locator('input[type=number]').fill('6');
   await page.getByRole('dialog',{name:'Camera scanner'}).waitFor({state:'hidden'});
   await page.waitForFunction(()=>window.__streams.length>0&&window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
   await page.waitForTimeout(2300);assert.equal(await modal.locator('input[type=number]').inputValue(),'6');
   const saved=waitFor(r=>r.request().method()==='POST'&&r.url().endsWith('/quantity-commands/'));
   await modal.getByRole('button',{name:/^stage/i}).click();assert.equal((await saved).status(),200);
   await page.getByRole('heading',{name:'Select Quantity',exact:true}).waitFor({state:'hidden'});const state=await inspect();assert.equal(state.allocation.reserved,6);assert.equal(state.stock,10);assert.equal(state.bulk_records,1);assert.equal(state.owner_id,1);});
  await check('Actual dispatch button moves exactly the reserved count',async()=>{const saved=waitFor(r=>r.request().method()==='POST'&&r.url().endsWith('/quantity-commands/'));await page.getByRole('button',{name:'Submit Dispatch to Show',exact:true}).click();assert.equal((await saved).status(),200);assert.equal((await inspect()).allocation.dispatched,6);});
  await page.getByRole('button',{name:'Requirements',exact:true}).click();
  await check('Requirements badge shows six event units rather than one master record',async()=>{assert.match(await page.getByRole('button').filter({hasText:'Shared cable master'}).innerText(), /x 6/);});
  await check('Supplier consumable scan saves and dispatches a recorded four-unit request',async()=>{await scan('AM-TAPE',4,'consumable-draft');
   await readableConsumables('requests');
   for(const name of ['Save consumable requests','Dispatch consumables']){const saved=waitFor(r=>r.request().method()==='POST'&&r.url().endsWith('/consumable-commands/'));await page.getByRole('button',{name,exact:true}).click();assert.equal((await saved).status(),200);}
   const state=await inspect();assert.equal(state.consumer.requested,4);assert.equal(state.consumer.state,'dispatched');assert.equal(state.consumable_stock,10);
  });
  await page.getByRole('button',{name:'Challans',exact:true}).first().click();
  await check('Challan list uses six delivered cables plus four consumables before first document save',async()=>{const row=page.getByRole('row').filter({hasText:'Synthetic shared quantity event'});assert.match(await row.innerText(), /10 items/i);});
  await page.getByRole('row').filter({hasText:'Synthetic shared quantity event'}).getByRole('button',{name:'View',exact:true}).click();
  await check('Reviewed customer challan and new supplier packet use event quantities, not master stock',async()=>{
   await page.getByRole('button',{name:'Edit Mode',exact:true}).click();const saved=waitFor(r=>r.request().method()==='PUT'&&r.url().includes('/challan-documents/'));await page.getByRole('button',{name:'Save Changes',exact:true}).click();assert.equal((await saved).status(),200);
   await page.getByRole('button',{name:'New delivery',exact:true}).click();await page.getByLabel('Quantity AM-BULK').waitFor();assert.equal(await page.getByLabel('Quantity AM-BULK').inputValue(),'6');assert.equal(await page.getByLabel('Quantity AM-TAPE').inputValue(),'4');
   await page.getByRole('button',{name:'Issue delivery challans',exact:true}).click();await page.getByText(/OUT-000001 — saved copy/).waitFor();const state=await inspect();const rows=state.packets[0].supplier_documents[0].rows;assert.equal(rows.find(r=>r.sku==='AM-BULK').quantity,6);assert.equal(rows.find(r=>r.sku==='AM-TAPE').quantity,4);
  });
  await page.reload();await open();await page.getByRole('button',{name:'Packup',exact:true}).click();
  await check('Packup badge shows six on-site units rather than ten warehouse units',async()=>{assert.match(await page.getByRole('button').filter({hasText:'Shared cable master'}).innerText(), /x 6/);await page.getByText('6 units on site',{exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});assert.match(await page.getByRole('button').filter({hasText:'Shared cable master'}).innerText(), /x 6/);await page.getByText('6 units on site',{exact:true}).waitFor();await page.setViewportSize({width:1400,height:1100});});
  await check('Partial bulk return and verification keep the remainder on site',async()=>{await scan('AM-BULK',2,'return');let state=await inspect();assert.equal(state.allocation.dispatched,4);assert.equal(state.allocation.awaiting_verification,2);
   await page.getByRole('button',{name:'Crosscheck',exact:true}).click();assert.match(await page.getByRole('button').filter({hasText:'Shared cable master'}).innerText(), /x 2/);await scan('AM-BULK',2,'verify_return');state=await inspect();assert.equal(state.allocation.awaiting_verification,0);assert.equal(state.allocation.dispatched,4);assert.equal(state.stock,10);assert.equal(state.bulk_records,1);
  });
  await check('Explicit consumable count and settlement deduct three consumed units once',async()=>{await readableConsumables('returns');await page.getByLabel('Returned to warehouse',{exact:true}).fill('1');await page.getByLabel('I verified this return count',{exact:true}).check();const saved=waitFor(r=>r.request().method()==='POST'&&r.url().endsWith('/consumable-commands/'));await page.getByRole('button',{name:'SUBMIT',exact:true}).click();assert.equal((await saved).status(),200);const state=await inspect();assert.equal(state.consumer.returned,1);assert.equal(state.consumer.consumed,3);assert.equal(state.consumable_stock,7);assert.equal(state.packets[0].supplier_documents[0].rows.find(r=>r.sku==='AM-TAPE').quantity,4);});
  assert(!writes.some(w=>w.path.includes('assign-quantity')));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks,passed:checks.length,actual_App_and_Django:true,private_memory_database:true,production_or_audit_staging_changed:false},null,2));
 }catch(e){console.error(log.slice(-5000));if(page)console.error((await page.locator('body').innerText()).slice(-4500));throw e;}
 finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
