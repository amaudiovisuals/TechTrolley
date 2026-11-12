// Actual App/editor/print -> disposable Django HTTP; fresh Chrome contexts only.
const assert = require('node:assert/strict'), path = require('node:path');
const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const { chromium } = require(process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const checks = []; async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const backend = spawn(process.env.TT_TEST_PYTHON || path.join(ROOT, 'backend/venv/bin/python'), [path.join(__dirname, 'document_sources_test_server.py')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', timer, browser, server, closing = false, transport = Promise.resolve(), release;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error(`Fixture startup: ${log}`)), 15000);
    backend.stdout.on('data', data => { log += data; if (log.includes('SYNTHETIC_SOURCE_SERVER_READY')) { clearTimeout(timer); resolve(); } });
    backend.stderr.on('data', data => { log += data; }); backend.once('exit', code => reject(Error(`Fixture exited ${code}: ${log}`)));
  });
  try {
    await ready;
    const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
    server = await createServer({ root: path.join(ROOT, 'frontend'), configFile: path.join(ROOT, 'frontend/vite.config.ts'), server: { host: '127.0.0.1', port: 4319, strictPort: true } }); await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TT_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext(); const errors = [], writes = []; let holdTickets = true;
    const ticketGate = new Promise(resolve => { release = resolve; });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:4319') return route.continue();
      if (url.origin !== 'http://127.0.0.1:8000') return route.abort();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      if (request.method() !== 'GET') writes.push({ path: url.pathname, payload: request.postDataJSON() });
      let response;
      try { const pending = transport.then(() => route.fetch({ url: `http://127.0.0.1:4320${url.pathname}${url.search}` })); transport = pending.then(() => {}, () => {}); response = await pending; }
      catch (error) { if (!closing) errors.push(error.message); return route.abort().catch(() => {}); }
      if (holdTickets && url.pathname === '/api/subrental-tickets/') await ticketGate;
      return route.fulfill({ response, headers: { ...response.headers(), 'Access-Control-Allow-Origin': '*' } });
    });
    await context.addInitScript(() => {
      window.tailwind = { config: {} }; localStorage.setItem('token', 'synthetic-sources-token');
      localStorage.setItem('user', JSON.stringify({ user_id: 1, role: 'admin', is_staff: true, email: 'sources@example.test' }));
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    const open = async (target, name = 'Synthetic source event') => {
      await target.getByRole('button', { name: 'Challans', exact: true }).first().click();
      await target.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'View', exact: true }).click();
    };
    const inspect = async () => (await page.request.get('http://127.0.0.1:4320/_fixture/inspect/')).json();
    const quantity = async (target, name) => (await target.getByRole('row').filter({ hasText: name }).first().locator('td').nth(5).textContent()).trim();
    await page.goto('http://127.0.0.1:4319/'); await open(page);
    await check('Actual new master waits for rental sources; first rows use bulk 6, consumables 8 and rental 3', async () => {
      await page.getByText(/Loading event rental sources/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Edit Mode', exact: true }).count(), 0);
      holdTickets = false; release(); await page.getByText('Event tape', { exact: true }).first().waitFor();
      assert.equal(await quantity(page, 'Bulk cable'), '6'); assert.equal(await quantity(page, 'Event tape'), '8'); assert.equal(await quantity(page, 'Rental speaker'), '3');
      assert.equal(await page.getByText('Event tape', { exact: true }).count(), 3); assert.equal((await inspect()).consumable_stock, 5);
    });
    await check('Actual return preview uses bulk 4 and counted tape 3, with no inferred supplier return', async () => {
      await page.getByRole('button', { name: /Return Challan \(/ }).click(); await page.getByText(/Return quantity preview/).waitFor();
      assert.equal(await quantity(page, 'Bulk cable'), '4'); assert.equal(await quantity(page, 'Event tape'), '3');
      assert.equal(await page.getByText('Rental speaker', { exact: true }).count(), 0);
      await page.getByRole('button', { name: /Original Dispatch \(/ }).click();
    });
    await check('Oversized old bulk draft is rejected by the server and remains editable without a stock write', async () => {
      await page.getByRole('button', { name: 'Edit Mode', exact: true }).click();
      const input = page.getByRole('row').filter({ has: page.locator('input[value="Bulk cable"]') }).locator('td').nth(5).locator('input');
      await input.fill('100'); await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByText('document_quantity_exceeds_event_allocation', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), '100'); assert.equal((await inspect()).documents, 0); assert.equal((await inspect()).stock, 100);
      await input.fill('6');
    });
    await check('Mixed source document plus a manual row saves without changing stock or consumption', async () => {
      await page.getByRole('button', { name: 'Add Item', exact: true }).click();
      await page.locator('input[value="ADHOC-4"]').fill('Manual source row');
      await page.getByRole('button', { name: 'Save Changes', exact: true }).click(); await page.getByText('Challan saved.', { exact: true }).waitFor();
      const saved = await inspect(); assert.equal(saved.stock, 100); assert.equal(saved.consumable_stock, 5); assert.equal(saved.consumed, 5);
      assert.deepEqual(saved.document.lines.filter(line => line.asset_id).map(line => line.quantity), [6, 3, 8]); assert.equal(saved.document.lines.length, 4);
      assert.equal(saved.documents, 1); assert.equal(saved.revisions, 1);
    });
    await check('New browser page and actual standalone print reload the same stored source/manual rows', async () => {
      await page.reload(); await open(page); await page.getByText('Manual source row', { exact: true }).first().waitFor();
      const printed = context.waitForEvent('page'); await page.getByRole('button', { name: /Print Dispatch Challan/ }).click(); const copy = await printed;
      copy.on('pageerror', error => errors.push(error.message)); await copy.waitForLoadState(); await copy.getByText('Manual source row', { exact: true }).first().waitFor();
      assert.equal(await copy.getByText('Event tape', { exact: true }).count(), 3); assert.equal(await quantity(copy, 'Event tape'), '8'); await copy.close();
    });
    await check('Issued source snapshots preserve quantities, labels, supplier and manual rows after source changes', async () => {
      await page.getByRole('button', { name: 'Edit Mode', exact: true }).click(); await page.getByRole('button', { name: 'Save & Issue', exact: true }).click();
      await page.getByText('Issued challan saved with revision history.', { exact: true }).waitFor(); assert.equal((await inspect()).document.state, 'issued');
      await page.request.post('http://127.0.0.1:4320/_fixture/change/'); await page.reload(); await open(page);
      await page.getByText('Event tape', { exact: true }).first().waitFor(); assert.equal(await quantity(page, 'Event tape'), '8');
      assert.equal(await page.getByText('Manual source row', { exact: true }).count(), 3); assert.equal(await page.getByText('Rented from Synthetic AM supplier', { exact: true }).count(), 3);
      const saved = await inspect(); assert.equal(saved.stock, 90); assert.equal(saved.consumable_stock, 0); assert.equal(saved.consumed, 5);
    });
    await check('Legacy consumable source stays visible as a review warning and cannot save an invented quantity', async () => {
      await page.getByRole('button', { name: /Back to List/ }).click();
      await page.getByRole('row').filter({ hasText: 'Legacy source review' }).getByRole('button', { name: 'View', exact: true }).click();
      await page.getByText(/needs legacy quantity\/settlement review/).waitFor();
      await page.getByRole('button', { name: 'Edit Mode', exact: true }).click(); await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByText(/Source quantities need review before saving/).waitFor(); assert.equal((await inspect()).documents, 1);
    });
    assert(writes.every(write => write.path.endsWith('/challan-documents/master/'))); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Actual React App/editor/standalone print + disposable migrated SQLite/Django HTTP; fresh Chrome context' }, null, 2));
  } catch (error) { console.error('Synthetic fixture diagnostics:', log); throw error; }
  finally { closing = true; clearTimeout(timer); if (release) release(); if (browser) await browser.close(); if (server) await server.close(); backend.kill('SIGTERM'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
