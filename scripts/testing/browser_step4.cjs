// Actual React editor -> DRF -> disposable migrated SQLite. No business settings/database.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const { chromium } = require(process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const checks = [];
async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const backend = spawn(process.env.TT_TEST_PYTHON || path.join(ROOT, 'backend/venv/bin/python'), [path.join(__dirname, 'document_test_server.py')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let backendOutput = '';
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(Error('Synthetic document server did not start within 15 seconds')), 15000);
    backend.stdout.on('data', data => { backendOutput += data; if (backendOutput.includes('SYNTHETIC_DOCUMENT_SERVER_READY')) { clearTimeout(readyTimer); resolve(); } });
    backend.stderr.on('data', data => { backendOutput += data; });
    backend.once('exit', code => reject(Error(`Synthetic server stopped (${code}): ${backendOutput}`)));
  });
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  let server, browser;
  try {
    await ready;
    server = await createServer({ root: path.join(ROOT, 'frontend'), configFile: path.join(ROOT, 'frontend/vite.config.ts'),
      server: { host: '127.0.0.1', port: 4313, strictPort: true,
        proxy: { '/api': 'http://127.0.0.1:4314', '/_fixture': 'http://127.0.0.1:4314' } } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TT_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:4313/') ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto('http://127.0.0.1:4313/testing/documents.html');
    const edit = () => page.getByRole('button', { name: 'Edit Mode', exact: true }).click();
    await check('Mixed owned/rented/manual rows commit once and create no inventory records', async () => {
      await edit(); await page.getByRole('button', { name: 'Add Item', exact: true }).click();
      await page.locator('input[value="ADHOC-3"]').fill('Manual cable one');
      await page.getByRole('button', { name: 'Add Item', exact: true }).click();
      await page.locator('input[value="ADHOC-4"]').fill('Manual cable two');
      await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByTestId('toast').filter({ hasText: 'Challan saved.' }).waitFor();
      const state = await (await page.request.get('http://127.0.0.1:4313/_fixture/inspect/')).json();
      assert.deepEqual(state, { asset_count: 2, stock_quantity: 100, documents: 1, revisions: 1, receipts: 1 });
    });
    await check('Reopening and a second browser context load the same manual rows from Django', async () => {
      await page.reload(); await page.getByText('Manual cable one', { exact: false }).first().waitFor();
      const other = await browser.newContext(); const second = await other.newPage();
      await second.goto('http://127.0.0.1:4313/testing/documents.html');
      await second.getByText('Manual cable two', { exact: false }).first().waitFor(); await other.close();
    });
    await check('Saved decimal rates and supplier source appear in all three print copies once', async () => {
      assert.equal(await page.getByText('Manual cable one', { exact: true }).count(), 3);
      assert.equal(await page.getByText('Rented from Synthetic AM supplier', { exact: true }).count(), 3);
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.getByText('Manual cable two', { exact: true }).count(), 3);
      await page.emulateMedia({ media: 'screen' });
    });
    await check('Issue captures history and later stock/supplier/event changes preserve printed snapshots', async () => {
      await edit(); await page.getByRole('button', { name: 'Save & Issue', exact: true }).click();
      await page.getByTestId('toast').filter({ hasText: 'Issued challan saved' }).waitFor();
      await page.request.post('http://127.0.0.1:4313/_fixture/change/'); await page.reload();
      await page.getByText('Owned cable', { exact: true }).first().waitFor();
      assert.equal(await page.getByText('Changed inventory cable', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Rented from Synthetic AM supplier', { exact: true }).count(), 3);
      assert.equal(await page.getByText('Original billing', { exact: true }).count(), 3);
    });
    await check('Issued corrections require a reason and intentional deletion preserves the earlier revision', async () => {
      await edit(); await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByTestId('toast').filter({ hasText: 'Enter a reason' }).waitFor();
      await page.getByText('Reason for correcting this issued challan').locator('input').fill('Removed duplicated manual request after review');
      const row = page.locator('tr').filter({ has: page.locator('input[value="Manual cable two"]') });
      await row.getByTitle('Delete Row').click(); await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Mode', exact: true }).waitFor();
      const event = await (await page.request.get('http://127.0.0.1:4313/api/conferences/', { headers: { Authorization: 'Token synthetic-document-token' } })).json();
      const doc = event[0].challan_documents[0];
      const history = await (await page.request.get(`http://127.0.0.1:4313/api/challan-documents/${doc.id}/history/`, { headers: { Authorization: 'Token synthetic-document-token' } })).json();
      assert.equal(history.length, 3); assert.equal(history[1].snapshot.lines.length, 4); assert.equal(history[2].snapshot.lines.length, 3);
      assert.equal(history[2].reason, 'Removed duplicated manual request after review');
    });
    await check('Losing a committed response and reopening retries the same receipt without another revision', async () => {
      await edit();
      await page.getByText('Reason for correcting this issued challan').locator('input').fill('Added reviewed manual equipment');
      await page.getByRole('button', { name: 'Add Item', exact: true }).click();
      await page.locator('input[value="ADHOC-4"]').fill('Manual cable retry');
      let original;
      const pattern = '**/api/conferences/*/challan-documents/master/';
      await context.route(pattern, async route => { original = route.request().postDataJSON(); await route.fetch(); await route.abort('failed'); });
      await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByText('A save is awaiting confirmation.', { exact: false }).waitFor();
      await context.unroute(pattern);
      const committed = await (await page.request.get('http://127.0.0.1:4313/_fixture/inspect/')).json();
      assert.equal(committed.revisions, 4);
      await page.reload(); await page.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor();
      let retry;
      await context.route(pattern, route => { retry = route.request().postDataJSON(); return route.continue(); });
      await page.getByRole('button', { name: 'Retry saved request', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Mode', exact: true }).waitFor();
      assert.deepEqual(retry, original);
      const confirmed = await (await page.request.get('http://127.0.0.1:4313/_fixture/inspect/')).json();
      assert.deepEqual(confirmed, committed);
      assert.equal(await page.getByText('Manual cable retry', { exact: true }).count(), 3);
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Actual Chrome/React + Django HTTP + disposable in-memory SQLite; no production connection' }, null, 2));
  } finally { clearTimeout(readyTimer); if (browser) await browser.close(); if (server) await server.close(); backend.kill('SIGTERM'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
