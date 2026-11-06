// Actual App/DRF/QR decoder. Synthetic camera and memory SQLite, no deployed API.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../..');
const { chromium, launchOptions } = require('./browser_runtime.cjs');
const QR=require(path.join(ROOT,'frontend/node_modules/qrcode'));
(async()=>{
 const backend=spawn(process.env.TT_TEST_PYTHON||path.join(ROOT,'backend/venv/bin/python'),[path.join(__dirname,'conference_camera_test_server.py')],{cwd:ROOT,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
 let log='',timer,server,browser,closing=false,disconnected=false,transport=Promise.resolve();const checks=[],errors=[],writes=[];
 const check=async(name,run)=>{console.error(`Checking: ${name}`);await run();checks.push(name);};
 const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),20000);backend.stdout.on('data',d=>{log+=d;if(log.includes('SYNTHETIC_CONFERENCE_CAMERA_READY')){clearTimeout(timer);resolve();}});backend.stderr.on('data',d=>{log+=d;});backend.once('exit',code=>reject(Error(`Fixture exited ${code}: ${log}`)));});
 try{
  await ready;const {createServer}=await import(pathToFileURL(path.join(ROOT,'frontend/node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root:path.join(ROOT,'frontend'),configFile:path.join(ROOT,'frontend/vite.config.ts'),server:{host:'127.0.0.1',port:4361,strictPort:true}});await server.listen();
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin==='https://cdn.tailwindcss.com'&&process.env.TT_TAILWIND_JS)return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(process.env.TT_TAILWIND_JS,'utf8')});
   if(url.origin==='http://127.0.0.1:4361'&&!url.pathname.startsWith('/api/'))return route.continue();
   if(!['http://127.0.0.1:4361','http://127.0.0.1:8000'].includes(url.origin))return route.abort();
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
   if(req.method()!=='GET')writes.push({path:url.pathname,body:req.postDataJSON()});
   if(disconnected&&url.pathname.endsWith('/asset-commands/'))return route.abort('internetdisconnected');
   try{const task=transport.then(()=>route.fetch({url:`http://127.0.0.1:4362${url.pathname}${url.search}`}));transport=task.then(()=>{},()=>{});const response=await task;return route.fulfill({response,headers:{...response.headers(),...headers}});}catch(error){if(!closing)errors.push(error.message);return route.abort().catch(()=>{});}
  });
  const qr=await QR.toDataURL('ROUTING-QR-01',{width:220,margin:4});
  await context.addInitScript(qr=>{
   window.tailwind={config:{}};localStorage.setItem('token','synthetic-camera-routing-token');localStorage.setItem('user',JSON.stringify({user_id:1,email:'routing@example.test',role:'admin',is_staff:true}));
   window.__streams=[];
   navigator.mediaDevices.getUserMedia=async()=>{const image=new Image();image.src=qr;await image.decode();const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d');const draw=()=>{ctx.fillStyle='white';ctx.fillRect(0,0,640,480);ctx.drawImage(image,210,130,220,220);};draw();const stream=canvas.captureStream(15),interval=setInterval(draw,60);stream.getTracks().forEach(t=>{const stop=t.stop.bind(t);t.stop=()=>{clearInterval(interval);stop();};});window.__streams.push(stream);return stream;};
  },qr);
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const inspect=async()=>(await page.request.get('http://127.0.0.1:4362/_fixture/inspect/')).json();
  // External icon fonts are blocked; retain dimensions for icon-only buttons.
  // This suite checks action routing, not responsive appearance or font loading.
  const openEvent=async()=>{await page.addStyleTag({content:'.fa-solid{display:inline-block;min-width:1em;min-height:1em}'});await page.getByRole('button',{name:'Conference',exact:true}).first().click();await page.locator('button[title="Edit Conference Details"]:visible').first().click();};
  const camera=()=>page.getByRole('dialog',{name:'Camera scanner'});
  const scan=async action=>{const response=page.waitForResponse(r=>r.url().endsWith('/asset-commands/'));await page.getByTitle('Scan with Camera',{exact:true}).first().click();const saved=await response;assert.equal(saved.status(),200,await saved.text());assert.equal(writes.at(-1).body.action,action);await page.getByText('✅ Movement saved',{exact:true}).waitFor();assert(await camera().isVisible(),'Conference camera must stay open');await camera().getByRole('button',{name:'Close Scanner',exact:true}).click();await page.waitForFunction(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));};
  await page.goto('http://127.0.0.1:4361/');await openEvent();await page.getByRole('button',{name:'Requirements',exact:true}).click();
  await check('Offline held QR repeats after the decoder window keep one saved request and no server stage',async()=>{
   disconnected=true;await page.getByTitle('Scan with Camera',{exact:true}).first().click();await page.getByText(/Movement not confirmed:/).waitFor();
   await page.waitForTimeout(4600);
   const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('tt:movement:2:')))||'[]'));
   assert.equal(pending.length,1);assert.equal(pending[0].payload.action,'stage');assert(writes.length>=2,'Hold must exercise repeated reads beyond two seconds');
   assert(writes.every(w=>w.body.request_id===pending[0].payload.request_id));assert.deepEqual((await inspect()).actions,[]);assert.deepEqual((await inspect()).staged,[]);
   assert(await camera().isVisible());await camera().getByRole('button',{name:'Close Scanner',exact:true}).click();
  });
  await check('Online page refresh restores the pending envelope without automatically committing it',async()=>{
   const original=writes[0].body,count=writes.length;disconnected=false;
   await page.reload();await page.getByRole('button',{name:/1 movement\(s\) pending/}).waitFor();await openEvent();await page.getByRole('button',{name:'Requirements',exact:true}).click();
   const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('tt:movement:2:')))||'[]'));
   assert.equal(pending.length,1);assert.deepEqual(pending[0].payload,original);assert.equal(writes.length,count);
   assert.deepEqual((await inspect()).actions,[]);assert.deepEqual((await inspect()).staged,[]);
  });
  await check('Reconnect retries the exact queued scan, stages once and displays the saved row',async()=>{
   const original=writes[0].body;disconnected=false;const response=page.waitForResponse(r=>r.url().endsWith('/asset-commands/'));
   await page.getByRole('button',{name:/1 movement\(s\) pending/}).click();const saved=await response;assert.equal(saved.status(),200,await saved.text());assert.deepEqual(writes.at(-1).body,original);
   await page.getByText('✅ Pending movements confirmed',{exact:true}).waitFor();const state=await inspect();assert.deepEqual(state.staged,[1]);assert.deepEqual(state.actions,['stage']);
   await page.getByRole('button',{name:/Routing cable.*x 1/i}).waitFor();assert.equal(await page.getByText('No requirements or assignments',{exact:true}).count(),0);
   assert.equal(await page.getByRole('button',{name:/movement\(s\) pending/}).count(),0);
  });
  await check('Reopening the event retains the saved staged row exactly once',async()=>{await page.reload();await openEvent();await page.getByRole('button',{name:'Requirements',exact:true}).click();await page.getByRole('button',{name:/Routing cable.*x 1/i}).waitFor();assert.equal(await page.getByRole('button',{name:/Routing cable.*x 1/i}).count(),1);assert.deepEqual((await inspect()).actions,['stage']);});
  await check('Repeated typed scan cannot save the same stage twice',async()=>{await page.waitForTimeout(2100);const before=writes.length;const input=page.getByPlaceholder('Scan to add equipment...');await input.fill('ROUTING-QR-01');await input.press('Enter');await page.getByText(/Already Scanned:/).waitFor();assert.equal(writes.length,before);assert.deepEqual((await inspect()).actions,['stage']);});
  const command=async action=>{const response=await page.request.post('http://127.0.0.1:4362/api/conferences/1/asset-commands/',{headers:{Authorization:'Token synthetic-camera-routing-token'},data:{request_id:crypto.randomUUID(),asset_ids:[1],action,source:'synthetic-routing-browser'}});assert.equal(response.status(),200,await response.text());};
  await command('dispatch');await page.reload();await openEvent();await page.getByRole('button',{name:'Packup',exact:true}).click();
  await check('Packup camera still records a return and stays continuous',async()=>{await scan('return');const state=await inspect();assert.deepEqual(state.dispatched,[]);assert.deepEqual(state.crosscheck,[1]);});
  await page.reload();await openEvent();await page.getByRole('button',{name:'Crosscheck',exact:true}).click();
  await check('Crosscheck camera still verifies the receipt and stays continuous',async()=>{await scan('verify_return');const state=await inspect();assert.deepEqual(state.crosscheck,[]);assert.deepEqual(state.actions,['stage','dispatch','return','verify_return']);});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,actual_App_DRF_decoder:true,synthetic_memory_SQLite:true,physical_phone_or_staging_changed:false},null,2));
 }catch(error){console.error(log);console.error(JSON.stringify({synthetic_commands:writes}));const page=browser?.contexts()[0]?.pages()[0];if(page)console.error((await page.locator('body').innerText()).slice(-2500));throw error;}finally{closing=true;clearTimeout(timer);if(browser)await browser.close();if(server)await server.close();backend.kill('SIGTERM');}
})().catch(error=>{console.error(error);process.exitCode=1;});
