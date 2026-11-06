// Actual App/decoder and bundled CSS/fonts; temporary Chrome profile and
// synthetic read-only API/camera. Every external request is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const {chromium} = require(process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const QR = require(path.join(ROOT, 'frontend/node_modules/qrcode'));

(async () => {
  const {createServer} = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({root: path.join(ROOT, 'frontend'), configFile: path.join(ROOT, 'frontend/vite.config.ts'),
    server: {host: '127.0.0.1', port: 4359, strictPort: true}});
  let browser;
  const checks = [], errors = [], writes = [];
  const check = async (name, run) => {console.error(`Checking: ${name}`); await run(); checks.push(name);};
  try {
    await server.listen();
    browser = await chromium.launch({headless: true, executablePath: process.env.TT_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
    const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true});
    const account = {user_id: 1, role: 'admin', is_staff: true, email: 'camera@example.test'};
    const asset = {id: 1, sku: 'PHONE-CAMERA-01', barcode: 'TT-PHONE-01', alias_name: 'Phone QR cable 01',
      type: 'Cable', status: 'Available', quantity: 1, is_barcode_added: true,
      serial_number: 'SERIAL'.repeat(14), description: 'DESCRIPTION'.repeat(15), item_price: 100};
    const pool = [asset, {...asset, id: 2, sku: 'DUPLICATE-A', barcode: 'AMBIGUOUS-CODE'},
      {...asset, id: 3, sku: 'DUPLICATE-B', barcode: 'AMBIGUOUS-CODE'}];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (!['http://127.0.0.1:4359','http://127.0.0.1:8000'].includes(url.origin)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const headers = {'Access-Control-Allow-Origin':'http://127.0.0.1:4359','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,OPTIONS'};
      if (req.method() === 'OPTIONS') return route.fulfill({status:204,headers});
      if (req.method() !== 'GET') {writes.push(url.pathname); return route.fulfill({status: 405, body: '{}'});}
      const data = url.pathname.endsWith('/my-profile/') ? account :
        url.pathname.endsWith('/company-settings/') ? {name: 'SYNTHETIC CAMERA TEST', dashboard_config: {}} :
        url.pathname.endsWith('/asset-stats/') ? {total: 3, ready: 3, in_use: 0, maintenance: 0} :
        /\/assets\/1\/$/.test(url.pathname) ? asset :
        url.pathname.endsWith('/assets/') ? (url.searchParams.has('all') ? pool : {results: pool, count: pool.length}) : [];
      return route.fulfill({contentType: 'application/json', body: JSON.stringify(data),headers});
    });
    await context.addInitScript(account => {
      localStorage.setItem('token', 'synthetic-camera-token'); localStorage.setItem('user', JSON.stringify(account));
      window.__cameraStreams = []; window.__cameraQR = '';
      navigator.mediaDevices.getUserMedia = async () => {
        const image = new Image(); image.src = window.__cameraQR; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
        const ctx = canvas.getContext('2d');
        const draw = () => {ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 640, 480); ctx.drawImage(image, 210, 130, 220, 220);};
        draw(); const stream = canvas.captureStream(15), interval = setInterval(draw, 60);
        stream.getTracks().forEach(track => {const stop = track.stop.bind(track); track.stop = () => {clearInterval(interval); stop();};});
        window.__cameraStreams.push(stream); return stream;
      };
    }, account);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4359/');
    await page.locator('button').filter({has:page.locator('i.fa-bars')}).click();
    await page.getByRole('button', {name: 'Inventory', exact: true}).first().click();
    await page.getByText('PHONE-CAMERA-01', {exact:true}).first().waitFor();
    const scan = async code => {
      await page.evaluate(qr => window.__cameraQR = qr, await QR.toDataURL(code, {width: 220, margin: 4}));
      await page.getByTitle('Scan with Camera', {exact: true}).click();
    };
    const dialog = () => page.getByRole('dialog', {name: 'Camera scanner'});
    await check('Matched inventory QR closes scanner, reveals the right asset and ends camera tracks', async () => {
      await scan('TT-PHONE-01');
      await page.getByRole('heading', {name: 'Asset Details', exact: true}).waitFor();
      await dialog().waitFor({state: 'hidden'});
      await page.getByRole('heading', {name: 'Phone QR cable 01', exact: true}).waitFor();
      await page.waitForFunction(() => window.__cameraStreams.length > 0 && window.__cameraStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
    });
    for (const width of [320, 390, 667, 1024]) {
      await check(`Asset details title, actions, badges and long values fit at ${width}px`, async () => {
        await page.setViewportSize({width, height: 844});
        await page.waitForFunction(() => getComputedStyle(document.querySelector('h2')).fontWeight === '900');
        const geometry = await page.evaluate(() => {
          const heading = [...document.querySelectorAll('h2')].find(e => e.textContent === 'Asset Details');
          const root = heading.parentElement.parentElement, title = root.querySelector('h3');
          const box = e => {const r = e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom};};
          return {heading:box(heading), back:box(heading.nextElementSibling), title:box(title),
            badges:box(title.parentElement.nextElementSibling), overflow:[...root.querySelectorAll('p,h2,h3,button')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent),
            bounds:[...root.querySelectorAll('p,h2,h3,button')].every(e => {const b=box(e);return b.left>=-1&&b.right<=innerWidth+1;})};
        });
        const separate = (a,b) => a.bottom <= b.top + 1 || b.bottom <= a.top + 1 || a.right <= b.left + 1 || b.right <= a.left + 1;
        assert(separate(geometry.heading, geometry.back), JSON.stringify(geometry));
        assert(separate(geometry.title, geometry.badges), JSON.stringify(geometry));
        assert.deepEqual(geometry.overflow, [], JSON.stringify(geometry)); assert(geometry.bounds, JSON.stringify(geometry));
        if (process.env.TT_RESULTS_DIR && width === 390) await page.screenshot({path:path.join(process.env.TT_RESULTS_DIR,'asset-details-390.png')});
      });
    }
    await page.getByRole('button', {name:'Back to List',exact:true}).click();
    for (const code of ['UNKNOWN-CAMERA-CODE', 'AMBIGUOUS-CODE']) {
      await check(`${code} keeps the scanner open for correction`, async () => {
        await scan(code);
        await dialog().getByText('Code read. Check the item result before moving on.', {exact:true}).waitFor();
        assert(await dialog().isVisible()); assert.equal(await page.getByRole('heading',{name:'Asset Details',exact:true}).count(),0);
        await dialog().getByRole('button',{name:'Close Scanner',exact:true}).click();
        await page.waitForFunction(() => window.__cameraStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
        if (code === 'UNKNOWN-CAMERA-CODE') await page.getByRole('button',{name:'Dismiss',exact:true}).click();
      });
    }
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed:checks.length,checks,actual_app_and_decoder:true,api:'synthetic read-only responses',camera:'canvas MediaStream',layout:'actual app HTML and locally compiled CSS/fonts; external requests blocked',physical_phone_acceptance:false,staging_or_production_changed:false},null,2));
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      console.error((await page.locator('body').innerText()).slice(-5000));
      if (process.env.TT_RESULTS_DIR) await page.screenshot({path:path.join(process.env.TT_RESULTS_DIR,'camera-failure.png')});
    }
    throw error;
  } finally {if(browser) await browser.close(); await server.close();}
})().catch(error => {console.error(error); process.exitCode=1;});
