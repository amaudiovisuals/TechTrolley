const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../..');
const {chromium,launchOptions}=require('./browser_runtime.cjs');
const checks=[];async function check(name,run){await run();checks.push(name);}
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON || path.join(ROOT,'backend/venv/bin/python'),[path.join(__dirname,'manifest_test_server.py')],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
 let log='',timer,server,browser,closing=false,transport=Promise.resolve(),dropNext=false;
 const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(`Fixture startup ${log}`)),15000);backend.stdout.on('data',data=>{log+=data;if(log.includes('SYNTHETIC_MANIFEST_SERVER_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',data=>{log+=data;});backend.once('exit',code=>reject(Error(`Fixture exit ${code}: ${log}`)));});
 try{
  await ready;const{createServer}=await import(pathToFileURL(path.join(ROOT,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(ROOT,'frontend'),configFile:path.join(ROOT,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4321,strictPort:true}});await server.listen();
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext(),writes=[],errors=[];
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin==='http://127.0.0.1:4321')return route.continue();if(url.origin!=='http://127.0.0.1:8000')return route.abort();
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}});
   if(req.method()!=='GET')writes.push({path:url.pathname,payload:req.postDataJSON()});let response;
   try{const pending=transport.then(()=>route.fetch({url:`http://127.0.0.1:4322${url.pathname}${url.search}`}));transport=pending.then(()=>{},()=>{});response=await pending;}catch(error){if(!closing)errors.push(error.message);return route.abort().catch(()=>{});}
   if(dropNext&&url.pathname.endsWith('/manifest-commands/')){dropNext=false;return route.abort();}
   return route.fulfill({response,headers:{...response.headers(),'Access-Control-Allow-Origin':'*'}});
  });
  await context.addInitScript(()=>{
    // These editing scenarios explicitly enable the detailed optional columns.
    localStorage.setItem('challan_visible_columns_v2',JSON.stringify(['Seq','Asset','Type','Identifiers','Rate','Qty','Total']));
window.tailwind={config:{}};localStorage.setItem('token','synthetic-sources-token');localStorage.setItem('user',JSON.stringify({user_id:1,role:'admin',is_staff:true,email:'sources@example.test'}));});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4322/_fixture/inspect/')).json();
  const open=async()=>{await page.getByRole('button',{name:'Challans',exact:true}).first().click();await page.getByRole('row').filter({hasText:'Synthetic source event'}).getByRole('button',{name:'View',exact:true}).click();};
  const clickCommand=async(name,action,status=200)=>{const response=page.waitForResponse(response=>response.url().endsWith('/manifest-commands/')&&response.request().postDataJSON().action===action&&response.status()===status);await page.getByRole('button',{name,exact:true}).click();await(await response).finished();await page.waitForFunction(()=>{const input=document.querySelector('[aria-label="Manifest from"]');return !input||!input.disabled;});};
  const masterLine=async name=>(await inspect()).document.lines.find(line=>line.snapshot.alias_name===name);
  const masterRow=name=>page.getByRole('row').filter({has:page.locator(`input[value="${name}"]`)});
  await page.goto('http://127.0.0.1:4321/');await open();
  await check('Actual saved master starts two truck documents including rented and manual sources without stock writes',async()=>{
   await page.getByRole('button',{name:'Edit Mode',exact:true}).click();await page.getByRole('button',{name:'Add Item',exact:true}).click();await page.locator('input[value="ADHOC-4"]').fill('Manual cable');await masterRow('Manual cable').locator('td').nth(5).locator('input').fill('4');
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();await page.getByText('Challan saved.',{exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Start truck manifest',exact:true}).count(),0);
   await clickCommand('+ Add Truck 2 (Split Challans)','start');await page.getByRole('button',{name:'View Truck 1 challan',exact:true}).waitFor();
   const saved=await inspect();assert.equal(saved.stock,100);assert.equal(saved.consumable_stock,5);assert.equal(saved.all_documents.length,3);assert.equal(saved.manifest_entries.length,4);assert.equal(saved.all_documents.find(doc=>doc.truck_id===1).lines.length,4);await page.getByLabel('Vehicle Truck 1',{exact:true}).fill('UNSAVED VEHICLE');
  });
  await check('Actual source selectors split bulk, consumable, rental and manual lines while master quantities remain fixed',async()=>{
   await page.getByLabel('Manifest from').selectOption('1');await page.getByLabel('Manifest to').selectOption('2');
   for(const[name,quantity]of[['Bulk cable',2],['Event tape',3],['Rental speaker',1],['Manual cable',2]])await page.getByLabel(`Move ${name}`,{exact:true}).fill(String(quantity));
   await clickCommand('Move selected manifest quantities','move');await page.getByText('Truck manifest confirmed.',{exact:true}).waitFor();
   const saved=await inspect();assert.equal(saved.stock,100);assert.equal(saved.consumable_stock,5);assert.equal(saved.document.lines.length,4);
   for(const line of saved.document.lines)assert.equal(saved.manifest_entries.filter(entry=>entry.master_line_id===line.id).reduce((sum,entry)=>sum+entry.quantity,0),line.quantity);
  });
  await check('Cancel draft split returns from the truck view to the original master and allows a fresh split',async()=>{
   const before=await inspect();
   await page.getByRole('button',{name:'View Truck 2 challan',exact:true}).click();
   await page.getByRole('button',{name:'Cancel draft split',exact:true}).click();
   await page.getByRole('button',{name:'Keep split',exact:true}).click();
   assert.equal((await inspect()).all_documents.length,3);
   await page.getByRole('button',{name:'Cancel draft split',exact:true}).click();
   await clickCommand('Remove draft trucks','cancel');
   await page.getByRole('button',{name:'+ Add Truck 2 (Split Challans)',exact:true}).waitFor();
   const cancelled=await inspect();
   assert.equal(cancelled.all_documents.length,1);
   assert.deepEqual(cancelled.document,before.document);
   assert.equal(cancelled.stock,before.stock);
   await clickCommand('+ Add Truck 2 (Split Challans)','start');
   await page.getByLabel('Manifest from').selectOption({label:'Truck 1'});
   await page.getByLabel('Manifest to').selectOption({label:'Truck 2'});
   for(const[name,quantity]of[['Bulk cable',2],['Event tape',3],['Rental speaker',1],['Manual cable',2]])await page.getByLabel(`Move ${name}`,{exact:true}).fill(String(quantity));
   await page.getByLabel('Vehicle Truck 1',{exact:true}).fill('UNSAVED VEHICLE');
   await clickCommand('Move selected manifest quantities','move');
  });
  await check('Vehicle details issue into a real truck copy and standalone print uses allocated quantities',async()=>{
   await page.getByLabel('Vehicle Truck 1',{exact:true}).fill('SYNTHETIC-TRUCK');await clickCommand('Save Truck 1 details','metadata',409);await page.getByRole('button',{name:'Keep reviewed Truck 1 details',exact:true}).click();await clickCommand('Save Truck 1 details','metadata');await page.getByText('Truck manifest confirmed.',{exact:true}).waitFor();
   await page.getByLabel('Truck document date').fill('2026-10-13');await clickCommand('Issue Truck 1 challan','issue');await page.getByText(/Truck 1 issued/).waitFor();
   const saved=await inspect(),doc=saved.all_documents.find(doc=>doc.truck_id&&doc.state==='issued');assert.equal(doc.header.vehicle_number,'SYNTHETIC-TRUCK');assert.equal(doc.lines.find(line=>line.snapshot.alias_name==='Bulk cable').quantity,4);
   assert.equal(await page.getByRole('button',{name:'Cancel draft split',exact:true}).count(),0);
   await page.getByRole('button',{name:'View Truck 1 challan',exact:true}).click();const printed=context.waitForEvent('page');await page.getByRole('button',{name:'Print Truck 1',exact:true}).click();const copy=await printed;copy.on('pageerror',error=>errors.push(error.message));await copy.waitForLoadState();await copy.getByText('Manual cable',{exact:true}).first().waitFor();assert.equal(await copy.getByText('Manual cable',{exact:true}).count(),3);await copy.close();
  });
  await check('Issued transfer fails without a reason, then records the correction without changing stock',async()=>{
   await page.getByLabel('Move Bulk cable',{exact:true}).fill('1');await clickCommand('Move selected manifest quantities','move',409);await page.getByRole('alert').filter({hasText:'issued_manifest_requires_correction_reason'}).waitFor();
   const before=await inspect();await page.getByLabel('Manifest correction reason').fill('Repacked one cable');await clickCommand('Move selected manifest quantities','move');await page.getByText('Truck manifest confirmed.',{exact:true}).waitFor();
   const after=await inspect(), truck=after.all_documents.find(doc=>doc.truck_id&&doc.state==='issued');assert.equal(after.stock,100);assert.equal(truck.lines.find(line=>line.snapshot.alias_name==='Bulk cable').quantity,3);assert.equal(truck.number,before.all_documents.find(doc=>doc.truck_id===truck.truck_id).number);
  });
  await check('Master reduction below truck quantities is rejected without freezing edits; a corrected master updates both copies',async()=>{
   await page.getByRole('button',{name:'View master challan',exact:true}).click();await page.getByRole('button',{name:'Edit Mode',exact:true}).click();await page.getByLabel('Reason for correcting this issued challan',{exact:true}).fill('Reviewed printed alias');
   const quantity=masterRow('Bulk cable').locator('td').nth(5).locator('input');await quantity.fill('5');await clickCommand('Save Changes','save_master',409);await page.getByText('deallocate_before_reducing_master_line',{exact:true}).waitFor();assert.equal(await quantity.isDisabled(),false);await quantity.fill('6');
   await page.locator('input[value="Bulk cable"]').fill('Printed bulk cable');await clickCommand('Save Changes','save_master');await page.getByText('Challan saved.',{exact:true}).waitFor();
   const saved=await inspect();assert.equal(saved.all_documents.filter(doc=>doc.truck_id).every(doc=>doc.lines.some(line=>line.snapshot.alias_name==='Printed bulk cable')),true);assert.equal(saved.stock,100);
  });
  await check('Lost master acknowledgement reloads both durable queues and exact retries do not create another revision',async()=>{
   await page.getByRole('button',{name:'Edit Mode',exact:true}).click();await page.getByLabel('Reason for correcting this issued challan',{exact:true}).fill('Reviewed manual name');await page.locator('input[value="Manual cable"]').fill('Manual after retry');dropNext=true;
   const dropped=page.waitForEvent('requestfailed',{predicate:request=>request.url().endsWith('/manifest-commands/')&&request.postDataJSON()?.document?.lines?.some(line=>line.snapshot.alias_name==='Manual after retry')});
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();await dropped;
   await page.getByRole('button',{name:/movement.*pending.*retry/i}).waitFor();const original=writes.at(-1),committed=await inspect();await page.reload();await open();await page.getByRole('button',{name:/movement.*pending.*retry/i}).click();await page.getByText(/Pending movements confirmed/).waitFor();
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();await page.getByText('Challan saved.',{exact:true}).waitFor();assert.deepEqual(writes.at(-1),original);const after=await inspect();assert.equal(after.revisions,committed.revisions);assert.equal(after.stock,100);assert.equal(after.document.lines.find(line=>line.snapshot.alias_name==='Manual after retry').quantity,4);
  });
  await check('Deallocation uses Unassigned, preserves the master/manual source and survives reload',async()=>{
   await page.getByLabel('Manifest from').selectOption({label:'Truck 1'});await page.getByLabel('Manifest to').selectOption('');await page.getByLabel('Move Manual after retry',{exact:true}).fill('1');await page.getByLabel('Manifest correction reason').fill('Held one manual item');await clickCommand('Move selected manifest quantities','move');await page.getByText('Truck manifest confirmed.',{exact:true}).waitFor();
   const saved=await inspect(),line=saved.document.lines.find(line=>line.snapshot.alias_name==='Manual after retry');assert.equal(saved.manifest_entries.filter(entry=>entry.master_line_id===line.id).reduce((sum,entry)=>sum+entry.quantity,0),3);assert.equal(line.quantity,4);await page.reload();await open();await page.getByText('Manual after retry',{exact:true}).first().waitFor();assert.equal((await inspect()).stock,100);
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({checks:checks.length,names:checks,environment:'Actual App/editor/truck panel/standalone print; migrated disposable SQLite/Django HTTP; fresh Chrome context'},null,2));
 }catch(error){console.error('Synthetic fixture diagnostics:',log);throw error;}
 finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill('SIGTERM');}
})().catch(error=>{console.error(error);process.exitCode=1;});
