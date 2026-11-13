// Real App/editor/reports/downloads, synthetic memory DB; external traffic blocked.
const assert = require('node:assert/strict'), path = require('node:path');
const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const XLSX = require(path.join(ROOT, 'frontend/node_modules/xlsx'));
const { chromium, launchOptions } = require('./browser_runtime.cjs');
(async () => {
 const backend = spawn(process.env.TT_TEST_PYTHON || path.join(ROOT, 'backend/venv/bin/python'), [path.join(__dirname, 'ownership_test_server.py')], { cwd: ROOT, stdio: ['ignore','pipe','pipe'] });
 let log='',timer,server,browser,closing=false,transport=Promise.resolve(),failOwners=false;
 const checks=[],errors=[],check=async(name,run)=>{console.error(`Checking: ${name}`);await run();checks.push(name);};
 const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),15000);backend.stdout.on('data',d=>{log+=d;if(log.includes('SYNTHETIC_OWNER_SERVER_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',d=>{log+=d;});backend.once('exit',c=>reject(Error(`Fixture ${c}: ${log}`)));});
 try {
  await ready;
  const {createServer}=await import(pathToFileURL(path.join(ROOT,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(ROOT,'frontend'),configFile:path.join(ROOT,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4335,strictPort:true}});await server.listen();
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({acceptDownloads:true});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin==='http://127.0.0.1:4335'&&!url.pathname.startsWith('/api/'))return route.continue();
   if(!['http://127.0.0.1:4335','http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
   if(failOwners&&url.pathname==='/api/inventory-ownership/')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic ownership unavailable"}',headers});
   try{const pending=transport.then(()=>route.fetch({url:`http://127.0.0.1:4336${url.pathname}${url.search}`}));transport=pending.then(()=>{},()=>{});const response=await pending;return route.fulfill({response,headers:{...response.headers(),...headers}});}catch(e){if(!closing)errors.push(e.message);return route.abort().catch(()=>{});}
  });
  await context.addInitScript(()=>{window.tailwind={config:{}};localStorage.setItem('token','synthetic-sources-token');localStorage.setItem('user',JSON.stringify({user_id:1,role:'admin',is_staff:true,email:'sources@example.test'}));});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4336/_fixture/inspect/')).json();
  const open=async(name='Synthetic source event')=>{await page.getByRole('button',{name:'Challans',exact:true}).first().click();await page.getByRole('row').filter({hasText:name}).getByRole('button',{name:'View',exact:true}).click();};
  const quantity=async(target,name)=>{
   const table=target.getByRole('region',{name:'Challan equipment table'}).first();
   const headers=await table.getByRole('columnheader').allTextContents();
   const index=headers.findIndex(label=>label.trim().toUpperCase()==='QUANTITY');
   assert(index>=0);
   return (await table.getByRole('row').filter({hasText:name}).first().locator('td').nth(index).textContent()).trim();
  };
  const download=async(button)=>{const pending=page.waitForEvent('download');await button.click();const file=await pending;return XLSX.readFile(await file.path());};
  await page.goto('http://127.0.0.1:4335/');
  await check('Dashboard counts shared warehouse, main stock and external catalogue separately',async()=>{const owners=page.getByRole('region',{name:'Inventory by owner'});await owners.getByText('AM Audiovisuals',{exact:true}).waitFor();await owners.getByText(/Main-owned: 1.*Other owners in shared godown: 2.*Shared godown total: 3.*External catalogue: 1/).waitFor();});
  await open();
  await check('Every saved dispatch copy groups owned, shared supplier, external rental and manual lines with exact subtotals',async()=>{await page.getByText('Manual owner row',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-owner-section="owned"]').count(),3);assert.equal(await page.getByText('Rented from AM Audiovisuals',{exact:true}).count(),3);assert.equal(await page.getByText('Rented from External rental company',{exact:true}).count(),3);assert.equal(await page.getByText('Manual additions',{exact:true}).count(),3);assert.equal(await quantity(page,'Shared cable'),'6');assert.equal(await quantity(page,'Shared tape'),'4');assert.equal(await page.getByText('Section subtotal: ₹85.00',{exact:true}).count(),3);assert.equal(await page.getByText('Section subtotal: ₹0.50',{exact:true}).count(),3);});
  await check('Manual row edit preserves source rows, supplier quantity and warehouse stock across save/reload',async()=>{const before=await inspect();await page.getByRole('button',{name:'Edit Mode',exact:true}).click();await page.getByText('Reason for correcting this issued challan').locator('input').fill('Reviewed manual quantity correction');await page.getByRole('row').filter({has:page.locator('input[value="Manual owner row"]')}).locator('td').nth(5).locator('input').fill('3');await page.getByRole('button',{name:'Save Changes',exact:true}).click();await page.getByRole('button',{name:'Edit Mode',exact:true}).waitFor();const state=await inspect();assert.equal(state.stock,before.stock);assert.equal(state.consumable_stock,before.consumable_stock);assert.equal(state.document.lines.length,5);assert.equal(state.document.lines.find(l=>l.source_kind==='manual').quantity,3);assert.equal(state.document.header.owner_sections_version,1);await page.reload();await open();assert.equal(await quantity(page,'Manual owner row'),'3');assert.equal(await page.getByText('Section subtotal: ₹0.75',{exact:true}).count(),3);});
  await check('Source and issuer renames keep saved dispatch values and labels',async()=>{await page.request.post('http://127.0.0.1:4336/_fixture/change/');await page.reload();await open();await page.getByText('Shared cable',{exact:true}).first().waitFor();assert.equal(await page.getByText('Rented from AM Audiovisuals',{exact:true}).count(),3);assert.equal(await page.locator('[data-owner-section="owned"]').first().textContent(),'Owned stock — AM Audiovisuals Pvt Ltd');assert.equal(await quantity(page,'Shared tape'),'4');});
  await check('Actual return view uses current balances with frozen owner labels and values; no assumed rental/manual returns',async()=>{await page.getByRole('button',{name:/Return Challan \(/}).click();await page.getByText(/Return quantity preview/).waitFor();assert.equal(await quantity(page,'Shared cable'),'4');assert.equal(await quantity(page,'Shared tape'),'1');assert.equal(await page.getByText('Rented from AM Audiovisuals',{exact:true}).count(),3);assert.equal(await page.getByText('Section subtotal: ₹52.50',{exact:true}).count(),3);assert.equal(await page.getByText('Rental speaker',{exact:true}).count(),0);assert.equal(await page.getByText('Manual owner row',{exact:true}).count(),0);await page.getByRole('button',{name:/Original Dispatch \(/}).click();});
  await check('Standalone dispatch print retains the same sections, manual rows and cents',async()=>{const pending=context.waitForEvent('page');await page.getByRole('button',{name:/Print Dispatch Challan/}).click();const copy=await pending;copy.on('pageerror',e=>errors.push(e.message));await copy.waitForLoadState();await copy.getByText('Manual owner row',{exact:true}).first().waitFor();assert.equal(await copy.locator('[data-owner-section]').count(),12);assert.equal(await copy.getByText('Section subtotal: ₹0.75',{exact:true}).count(),3);await copy.close();});
  await check('Opening the first revision reprints its original quantity and issuer after a rename',async()=>{
   await page.getByRole('button',{name:'Challan versions',exact:true}).click();
   const pending=context.waitForEvent('page');
   await page.getByRole('button',{name:'Open version 1 for printing',exact:true}).click();
   const copy=await pending;copy.on('pageerror',error=>errors.push(error.message));
   await copy.getByText('Section subtotal: ₹0.50',{exact:true}).first().waitFor();
   assert.equal(await quantity(copy,'Manual owner row'),'2');
   assert.equal(await copy.locator('[data-owner-section="owned"]').first().textContent(),'Owned stock — AM Audiovisuals Pvt Ltd');
   await copy.close();
  });
  await check('Old saved documents remain flat before and after a draft save',async()=>{await page.getByRole('button',{name:/Back to List/}).click();await page.getByRole('row').filter({hasText:'Old flat document'}).getByRole('button',{name:'View',exact:true}).click();await page.getByText('Old flat row',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-owner-section]').count(),0);await page.getByRole('button',{name:'Edit Mode',exact:true}).click();await page.getByRole('button',{name:'Save Changes',exact:true}).click();await page.getByRole('button',{name:'Edit Mode',exact:true}).waitFor();assert.equal((await inspect()).old_header.owner_sections_version,undefined);assert.equal(await page.locator('[data-owner-section]').count(),0);});
  await check('Conflicting ticket and warehouse references show a warning and cannot save a new document',async()=>{await page.getByRole('button',{name:/Back to List/}).click();await page.getByRole('row').filter({hasText:'Overlapping source review'}).getByRole('button',{name:'View',exact:true}).click();await page.getByText(/appears in both warehouse and supplier-ticket sources/).waitFor();const before=await inspect();await page.getByRole('button',{name:'Edit Mode',exact:true}).click();await page.getByRole('button',{name:'Save Changes',exact:true}).click();await page.getByText(/Warehouse and supplier-ticket rows overlap/).waitFor();assert.equal((await inspect()).documents,before.documents);await page.getByRole('button',{name:'Close Edit Mode',exact:true}).click();});
  await page.getByRole('button',{name:'Reports',exact:true}).first().click();
  await check('Reports ownership failures show an error, hide export and recover actual counts',async()=>{const owners=page.getByRole('region',{name:'Inventory by owner'});await owners.getByRole('button',{name:'Export ownership report'}).waitFor();failOwners=true;await owners.getByRole('button',{name:'Reload ownership report'}).click();await owners.getByRole('alert').waitFor();assert.equal(await owners.getByRole('button',{name:'Export ownership report'}).count(),0);failOwners=false;await owners.getByRole('button',{name:'Reload ownership report'}).click();await owners.getByRole('button',{name:'Export ownership report'}).waitFor();const workbook=await download(owners.getByRole('button',{name:'Export ownership report'}));const rows=XLSX.utils.sheet_to_json(workbook.Sheets['Inventory owners']);assert.equal(rows.find(r=>r.Owner==='Renamed AM owner')['Inventory records'],2);assert.equal(rows.find(r=>r.Owner==='Renamed AM owner')['Inventory classification'],'Shared godown stock');});
  await check('Real dispatch/return XLSX downloads distinguish paper quantities from stock masters and keep frozen prices/manual edits',async()=>{await page.getByRole('heading',{name:'Synthetic source event',exact:true}).click();const workbook=await download(page.getByRole('button',{name:'Export saved challan',exact:true}));const rows=XLSX.utils.sheet_to_json(workbook.Sheets['Saved challan lines']);assert.equal(rows.length,5);assert.equal(rows.find(r=>r['Alias Name']==='Manual owner row').Quantity,3);assert.equal(rows.find(r=>r['Alias Name']==='Shared cable').Quantity,6);assert.equal(rows.find(r=>r['Alias Name']==='Shared cable').Section,'Rented from AM Audiovisuals');assert.equal(rows.reduce((n,r)=>n+r['Line Total'],0),135.75);const returns=await download(page.getByRole('button',{name:'Export current return preview',exact:true}));const preview=XLSX.utils.sheet_to_json(returns.Sheets['Current return preview']);assert.deepEqual(preview.map(r=>r.Quantity),[4,1]);assert.deepEqual(preview.map(r=>r['Unit Value']),[12.5,2.5]);assert(!preview.some(r=>r['Ticket Item ID']));});
  await check('Grouped challans sum individual values across rates and keep owners and identifiers distinct',async()=>{
   await page.goto('http://127.0.0.1:4335/testing/challan.html');
   await page.waitForFunction(()=>window.__fixture);
   await page.evaluate(()=>{
    const {first,poll}=window.__fixture;
    poll([
     {...first,id:'11',sku:'CABLE-11',serialNumber:'TEST-11',aliasName:'HDMI Fibre Long Cable',itemPrice:100,current_value:80.25},
     {...first,id:'12',sku:'CABLE-12',serialNumber:'TEST-12',aliasName:'hdmi  fibre long cable ',quantity:2,itemPrice:200,current_value:125.15},
     {...first,id:'13',sku:'CABLE-13',serialNumber:'TEST-13',aliasName:'HDMI Fibre Long Cable',itemPrice:300,current_value:210.11,subrental_company:7,subrental_company_name:'AM test owner'},
    ],2);
   });
   const paper=page.getByRole('region',{name:'Challan equipment table'}).first();
   const rows=paper.locator('tbody tr').filter({hasText:/hdmi\s+fibre long cable/i});
   await rows.first().waitFor();
   assert.equal(await rows.count(),2);
   assert.equal(await quantity(page,'HDMI Fibre Long Cable'),'3');
   assert.match(await rows.first().innerText(),/TEST-11, TEST-12/);
   assert.match(await rows.first().innerText(),/₹330\.55/);
   assert.match(await rows.last().innerText(),/₹210\.11/);
   assert.equal(await paper.getByRole('columnheader',{name:'Unit Rate'}).count(),0);
   await page.getByRole('button',{name:'Ungroup Items'}).click();
   assert.equal(await rows.count(),3);
   assert.equal(await paper.getByRole('columnheader',{name:'Unit Rate'}).count(),1);
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,actual_app:true,business_database:false,environment:'Disposable migrated in-memory SQLite/Django HTTP; fresh Chrome; real XLSX downloads; external traffic blocked'},null,2));
 }catch(e){console.error(log);throw e;}finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill('SIGTERM');}
})().catch(e=>{console.error(e);process.exitCode=1;});
