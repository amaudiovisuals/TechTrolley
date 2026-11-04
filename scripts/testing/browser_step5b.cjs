const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');const ROOT=path.resolve(__dirname,'../..');
const{chromium}=require(process.env.TT_PLAYWRIGHT_MODULE||'/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON || path.join(ROOT,'backend/venv/bin/python'),[path.join(__dirname,'staff_test_server.py')],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
 let log='',timer,server,browser,closing=false,transport=Promise.resolve(),dropStaff=false,dropLink=false,failAllocations=false,holdHistory=false,heldRoutes=[],heldResolve;
 const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),15000);backend.stdout.on('data',data=>{log+=data;if(log.includes('SYNTHETIC_STAFF_SERVER_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',data=>{log+=data;});backend.once('exit',code=>reject(Error(`Fixture ${code}: ${log}`)));});
 const checks=[],writes=[],errors=[];const check=async(name,run)=>{await run();checks.push(name);};
 try{
  await ready;const{createServer}=await import(pathToFileURL(path.join(ROOT,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(ROOT,'frontend'),configFile:path.join(ROOT,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4325,strictPort:true}});await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.TT_CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const context=await browser.newContext({acceptDownloads:true});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin==='http://127.0.0.1:4325'&&!url.pathname.startsWith('/api/'))return route.continue();if(!['http://127.0.0.1:4325','http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}});
   if(request.method()!=='GET')writes.push({path:url.pathname,body:request.postDataJSON()});
   if(url.pathname==='/api/assets/'&&request.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(url.searchParams.get('all')==='true'?[]:{results:[],count:0}),headers:{'Access-Control-Allow-Origin':'*'}});
   if(failAllocations&&url.pathname==='/api/employee-allocations/')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic allocations unavailable"}',headers:{'Access-Control-Allow-Origin':'*'}});
   if(holdHistory&&url.pathname.endsWith('/history/')){heldRoutes.push(route);heldResolve();return;}
   try{const pending=transport.then(()=>route.fetch({url:`http://127.0.0.1:4326${url.pathname}${url.search}`}));transport=pending.then(()=>{},()=>{});const response=await pending;
    if(dropStaff&&url.pathname==='/api/staff-commands/'){dropStaff=false;return route.abort();}if(dropLink&&url.pathname==='/api/employee-link-commands/'){dropLink=false;return route.abort();}
    return route.fulfill({response,headers:{...response.headers(),'Access-Control-Allow-Origin':'*'}});
   }catch(error){if(!closing)errors.push(error.message);return route.abort().catch(()=>{});}
  });
  await context.addInitScript(()=>{window.tailwind={config:{}};localStorage.setItem('token','synthetic-staff-token');localStorage.setItem('user',JSON.stringify({user_id:1,role:'admin',is_staff:true,email:'staff-browser@example.test'}));});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4326/_fixture/inspect/')).json();
  const openReport=async()=>{await page.getByRole('button',{name:'Reports',exact:true}).first().click();await page.getByRole('button',{name:'Employee Assets',exact:true}).click();await page.getByText('Issued phone',{exact:false}).first().waitFor();};
  const dialog=()=>page.getByRole('dialog',{name:'Staff equipment operation'});
  const employee=id=>page.locator(`[data-employee-id="${id}"]`);
  const beginIssue=async name=>{await employee(1).getByRole('button',{name:'Issue equipment to Staff 1',exact:true}).click();await dialog().getByLabel('Search staff issue candidates').fill(name);await dialog().getByRole('button',{name:new RegExp(`^Select ${name} ·`)}).click();};
  const confirm=async(action,status=200)=>{const done=page.waitForResponse(r=>r.url().endsWith('/staff-commands/')&&r.request().postDataJSON().action===action&&r.status()===status);await dialog().getByRole('button',{name:'Confirm staff operation',exact:true}).click();await(await done).finished();if(status===200)await page.getByRole('dialog',{name:'Staff equipment operation'}).waitFor({state:'hidden'});};
  await page.goto('http://127.0.0.1:4325/');await openReport();
  await check('Seven actual allocations and exports include non-laptops/supplier/unknown legacy dates despite empty inventory pages',async()=>{
   assert.equal(await page.locator('[data-issued-asset-id]').count(),7);assert.equal(await page.locator('[data-employee-id]').count(),5);await page.getByText('Supplier tablet',{exact:false}).first().waitFor();await page.getByText(/Original issue date not recorded/).waitFor();
   await page.getByLabel('Laptops category only').check();assert.equal(await page.locator('[data-issued-asset-id]').count(),1);await page.getByLabel('Laptops category only').uncheck();
   const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export employee assets',exact:true}).click();const file=await downloaded;const XLSX=require(path.join(ROOT,'frontend/node_modules/xlsx'));const book=XLSX.readFile(await file.path());const rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);assert.equal(rows.length,7);assert.ok(rows.some(row=>row.Supplier==='Synthetic supplier'));assert.equal(writes.length,0);
  });
  await check('Actual non-laptop supplier issue and confirmed return persist dated history and dashboard projection',async()=>{
   await beginIssue('Available phone');await dialog().getByLabel('Reason for staff operation').fill('Verified company phone issue');await confirm('issue');await page.locator('[data-issued-asset-id="8"]').waitFor();let saved=await inspect();assert.equal(saved.assets.find(a=>a.id===8).assigned_to_id,1);
   await employee(1).getByRole('button',{name:'Record return of Available phone',exact:true}).click();await dialog().getByLabel('Reason for staff operation').fill('Physically returned company phone');await confirm('return');await page.locator('[data-issued-asset-id="8"]').waitFor({state:'hidden'});saved=await inspect();assert.equal(saved.assets.find(a=>a.id===8).assigned_to_id,null);assert.ok(saved.allocations.find(a=>a.asset_id===8).returned_at);
   await page.getByRole('button',{name:'Dashboard',exact:true}).first().click();assert.equal(await page.getByText('Available phone',{exact:true}).count(),0);await openReport();
  });
  await check('Legacy return records unknown original issue instead of fabricating a date',async()=>{
   await page.getByRole('button',{name:'Record return of Legacy camera',exact:true}).click();await dialog().getByLabel('Reason for staff operation').fill('Verified legacy device return');await confirm('return');const row=(await inspect()).allocations.find(a=>a.asset_id===7);assert.equal(row.issued_at,null);assert.equal(row.provenance,'legacy_assignment_at_return');assert.ok(row.returned_at);
  });
  await check('Competing issue rejects stale selection without rebasing or duplicating history',async()=>{
   await beginIssue('Conflict device');await dialog().getByLabel('Reason for staff operation').fill('Stale earlier choice');await page.request.post('http://127.0.0.1:4326/_fixture/compete/');await confirm('issue',409);
   await page.getByText('staff_allocation_conflict',{exact:false}).first().waitFor();const saved=await inspect();assert.equal(saved.allocations.filter(a=>a.asset_id===10).length,1);assert.equal(saved.assets.find(a=>a.id===10).assigned_to_id,2);
   await page.getByRole('button',{name:'Discard rejected staff attempt and review latest records',exact:true}).click();await dialog().waitFor({state:'hidden'});
  });
  await check('Lost issue response reloads durable queue; exact receipt recovers after role downgrade without second issue',async()=>{
   await beginIssue('Available laptop');await dialog().getByLabel('Reason for staff operation').fill('Verified laptop handover');dropStaff=true;const dropped=page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/staff-commands/')});await dialog().getByRole('button',{name:'Confirm staff operation',exact:true}).click();await dropped;const original=writes.at(-1),before=await inspect();
   assert.equal(await page.evaluate(async()=>{const module=await import('/state/workSafety.ts');return module.hasPendingWork();}),true);
   await page.request.post('http://127.0.0.1:4326/_fixture/role/?role=accounts');await page.reload();await openReport();await page.getByRole('button',{name:'Retry saved staff operation',exact:true}).click();await page.getByRole('button',{name:'Retry saved staff operation',exact:true}).waitFor({state:'hidden'});assert.deepEqual(writes.at(-1),original);assert.equal((await inspect()).allocations.length,before.allocations.length);assert.equal((await inspect()).assets.find(a=>a.id===9).staff_revision,1);
   await page.request.post('http://127.0.0.1:4326/_fixture/role/?role=admin');await page.reload();await openReport();
  });
  await check('Create/link acknowledgement loss recovers one employee profile and leaves login privileges unchanged',async()=>{
   await page.getByLabel('Login account to link').selectOption('2');await page.getByLabel('Linked employee name').fill('Reviewed system person');await page.getByLabel('Linked employee business ID').fill('REVIEWED-SYSTEM');await page.getByLabel('Reason for employee link').fill('Verified account and staff identity');dropLink=true;
   const dropped=page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/employee-link-commands/')});await page.getByRole('button',{name:'Confirm employee link',exact:true}).click();await dropped;const original=writes.at(-1),before=await inspect();await page.reload();await openReport();await page.getByRole('button',{name:'Retry saved staff operation',exact:true}).click();await page.getByRole('button',{name:'Retry saved staff operation',exact:true}).waitFor({state:'hidden'});const after=await inspect();assert.deepEqual(writes.at(-1),original);assert.equal(after.employees.length,before.employees.length);assert.equal(after.employees.filter(e=>e.user_id===2).length,1);assert.equal(after.login.role,'technician');assert.equal(after.login.superuser,false);
  });
  await check('Allocation HTTP failure displays an error and disables exports; successful reload clears it',async()=>{
   failAllocations=true;await page.getByRole('button',{name:'Reload allocations',exact:true}).click();await page.getByRole('alert').filter({hasText:'Could not load staff records'}).waitFor();assert.equal(await page.getByText('No active staff allocations are recorded.',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Export employee assets',exact:true}).isDisabled(),true);failAllocations=false;await page.getByRole('button',{name:'Reload allocations',exact:true}).click();await page.getByRole('alert').filter({hasText:'Could not load staff records'}).waitFor({state:'hidden'});
  });
  await check('Closing history ignores a delayed response',async()=>{
   const heldReady=new Promise(resolve=>{heldResolve=resolve;});holdHistory=true;await page.getByRole('button',{name:'History of Issued laptop',exact:true}).click();await heldReady;await page.getByRole('button',{name:'Close staff history',exact:true}).click();holdHistory=false;const done=page.waitForResponse(r=>r.url().endsWith('/history/'));
   for(const route of heldRoutes.splice(0)){const url=new URL(route.request().url());const response=await route.fetch({url:`http://127.0.0.1:4326${url.pathname}`});await route.fulfill({response,headers:{...response.headers(),'Access-Control-Allow-Origin':'*'}});}await(await done).finished();assert.equal(await page.getByRole('dialog',{name:'Staff issue return history'}).count(),0);
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,actual_app:true,business_database:false,environment:'Migrated in-memory SQLite; fresh Chrome; external traffic blocked'},null,2));
 }finally{closing=true;clearTimeout(timer);for(const route of heldRoutes)await route.abort().catch(()=>{});if(browser)await browser.close();if(server)await server.close();backend.kill('SIGTERM');}
})().catch(error=>{console.error(error);process.exitCode=1;});
