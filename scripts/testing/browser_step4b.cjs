// Real App -> DRF -> migrated disposable SQLite, with a fresh isolated Chrome context.
const assert = require('node:assert/strict'); const path = require('node:path');
const { spawn } = require('node:child_process'); const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const { chromium } = require(process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const checks = []; async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const backend = spawn(process.env.TT_TEST_PYTHON || path.join(ROOT, 'backend/venv/bin/python'), [path.join(__dirname, 'quantity_test_server.py')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let backendOutput = '', readyTimer;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(Error(`Synthetic server did not start: ${backendOutput}`)), 15000);
    backend.stdout.on('data', data => { backendOutput += data; if (backendOutput.includes('SYNTHETIC_QUANTITY_SERVER_READY')) { clearTimeout(readyTimer); resolve(); } });
    backend.stderr.on('data', data => { backendOutput += data; });
    backend.once('exit', code => reject(Error(`Synthetic server stopped (${code}): ${backendOutput}`)));
  });
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  let server, browser, closing = false, transport = Promise.resolve();
  try {
    await ready;
    server = await createServer({ root: path.join(ROOT, 'frontend'), configFile: path.join(ROOT, 'frontend/vite.config.ts'), server: { host: '127.0.0.1', port: 4315, strictPort: true } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TT_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext(); const page = await context.newPage(); const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    let dropNextQuantity = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:4315') return route.continue();
      if (url.origin !== 'http://127.0.0.1:8000') return route.abort();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      if (request.method() !== 'GET') writes.push({ path: url.pathname, payload: request.postDataJSON() });
      let response;
      try {
        const pending = transport.then(() => route.fetch({ url: `http://127.0.0.1:4316${url.pathname}${url.search}` }));
        transport = pending.then(() => {}, () => {});
        response = await pending;
      } catch (error) { if (!closing) errors.push(error.message); await route.abort().catch(() => {}); return; }
      if (dropNextQuantity && url.pathname.endsWith('/quantity-commands/')) { dropNextQuantity = false; return route.abort(); }
      return route.fulfill({ response, headers: { ...response.headers(), 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(() => {
      window.tailwind = { config: {} };
      localStorage.setItem('token', 'synthetic-bulk-token');
      localStorage.setItem('user', JSON.stringify({ user_id: 1, role: 'godown_incharge', email: 'synthetic-bulk@example.test', is_staff: false }));
    });
    await page.goto('http://127.0.0.1:4315/');
    const openEvent = async () => {
      await page.getByRole('button', { name: 'Conference', exact: true }).first().click();
      await page.getByRole('button', { name: 'View Execution', exact: false }).first().click();
      await page.getByRole('button', { name: 'Requirements', exact: true }).click();
    };
    await openEvent();
    const scan = async code => {
      const input = page.getByPlaceholder('Search or scan requirement...');
      await input.fill(code); await input.press('Enter');
    };
    const quantity = async (amount, action) => {
      await page.getByRole('heading', { name: 'Select Quantity', exact: true }).waitFor();
      await page.locator('input[type="number"]').last().fill(String(amount));
      await page.getByRole('button', { name: new RegExp(`^${action}.*${amount}.*Unit`, 'i') }).click();
    };
    const state = async () => (await page.request.get('http://127.0.0.1:4316/_fixture/inspect/')).json();
    await check('Actual scanner stages a partial bulk quantity without cloning or a conference PUT', async () => {
      await scan('BULK-10'); await quantity(6, 'stage');
      await page.getByRole('button', { name: /Synthetic cable stock.*x 1/i }).click();
      await page.getByText('6 packed · 0 on site · 0 unchecked', { exact: true }).waitFor();
      const saved = await state(); assert.equal(saved.asset_count, 2); assert.equal(saved.stock, 10); assert.equal(saved.allocation[0].reserved, 6);
      assert.equal(writes.length, 1); assert(writes[0].path.endsWith('/quantity-commands/'));
    });
    await check('Actual dispatch button sends bulk and physical items in one atomic command', async () => {
      await scan('PHYSICAL-1');
      await page.getByRole('button', { name: /Synthetic speaker.*x 1/i }).waitFor();
      await page.getByRole('button', { name: 'Submit Dispatch to Show', exact: true }).click();
      await page.getByRole('button', { name: 'Submit Dispatch to Show', exact: true }).waitFor({ state: 'hidden' });
      const saved = await state(); assert.equal(saved.allocation[0].dispatched, 6); assert.equal(saved.allocation[0].reserved, 0);
      const last = writes.at(-1); assert(last.path.endsWith('/quantity-commands/')); assert.deepEqual(last.payload.items, [{ asset_id: 1, quantity: 6 }]); assert.deepEqual(last.payload.physical_asset_ids, [2]);
    });
    await check('A committed bulk return with a dropped response survives reload and exact retry', async () => {
      await page.getByRole('button', { name: 'Packup', exact: true }).click();
      const input = page.getByPlaceholder('Scan to remove/verify...'); await input.fill('BULK-10'); await input.press('Enter');
      dropNextQuantity = true; await quantity(2, 'return');
      await page.getByText(/Quantity not confirmed/).waitFor();
      const first = writes.at(-1); assert.equal((await state()).allocation[0].awaiting_verification, 2);
      await page.reload(); await openEvent();
      await page.getByRole('button', { name: /movement.*pending.*retry/i }).click();
      await page.getByText(/Pending movements confirmed/).waitFor();
      assert.deepEqual(writes.at(-1), first); assert.equal((await state()).movements, 3);
    });
    await check('Warehouse verification releases only explicitly verified units', async () => {
      await page.getByRole('button', { name: 'Crosscheck', exact: true }).click();
      await page.getByRole('button', { name: /Synthetic cable stock.*x 1/i }).click();
      await page.getByTitle('Verify Receipt').click(); await quantity(1, 'verify return');
      await page.getByText('0 packed · 4 on site · 1 unchecked', { exact: true }).waitFor();
      const saved = await state(); assert.equal(saved.allocation[0].verified_total, 1); assert.equal(saved.stock, 10); assert.equal(saved.asset_count, 2);
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Actual React App and DRF endpoints; fresh headless Chrome profile; migrated disposable SQLite; loopback-only transport' }, null, 2));
  } catch (error) { console.error('Synthetic backend diagnostics:', backendOutput); throw error; }
  finally { closing = true; clearTimeout(readyTimer); if (browser) await browser.close(); if (server) await server.close(); backend.kill('SIGTERM'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
