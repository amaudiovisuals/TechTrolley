const assert = require('node:assert/strict'); const path = require('node:path');
const { spawn } = require('node:child_process'); const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const { chromium } = require(process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const checks = []; async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const backend = spawn(process.env.TT_TEST_PYTHON || path.join(ROOT, 'backend/venv/bin/python'), [path.join(__dirname, 'consumable_test_server.py')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', timer, server, browser, release, closing = false, transport = Promise.resolve();
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error(`Fixture startup: ${log}`)), 15000);
    backend.stdout.on('data', data => { log += data; if (log.includes('SYNTHETIC_CONSUMABLE_SERVER_READY')) { clearTimeout(timer); resolve(); } });
    backend.stderr.on('data', data => { log += data; }); backend.once('exit', code => reject(Error(`Fixture exit ${code}: ${log}`)));
  });
  try {
    await ready;
    const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
    server = await createServer({ root: path.join(ROOT, 'frontend'), configFile: path.join(ROOT, 'frontend/vite.config.ts'), server: { host: '127.0.0.1', port: 4317, strictPort: true } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TT_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext(); const page = await context.newPage(); const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    let holdNext = false, dropNext = false, reached;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:4317') return route.continue();
      if (url.origin !== 'http://127.0.0.1:8000') return route.abort();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      const consume = url.pathname.endsWith('/consumable-commands/');
      if (request.method() !== 'GET') writes.push({ path: url.pathname, payload: request.postDataJSON() });
      let response;
      try { const pending = transport.then(() => route.fetch({ url: `http://127.0.0.1:4318${url.pathname}${url.search}` })); transport = pending.then(() => {}, () => {}); response = await pending; }
      catch (error) { if (!closing) errors.push(error.message); await route.abort().catch(() => {}); return; }
      if (consume && holdNext) { holdNext = false; reached(); await new Promise(resolve => { release = resolve; }); }
      if (consume && dropNext) { dropNext = false; return route.abort(); }
      return route.fulfill({ response, headers: { ...response.headers(), 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(() => {
      window.tailwind = { config: {} }; localStorage.setItem('token', 'synthetic-consumable-token');
      localStorage.setItem('user', JSON.stringify({ user_id: 1, role: 'godown_incharge', is_staff: false, email: 'synthetic-consume@example.test' }));
    });
    await page.goto('http://127.0.0.1:4317/');
    const open = async () => { await page.getByRole('button', { name: 'Conference', exact: true }).first().click(); await page.getByRole('button', { name: /View Execution/ }).first().click(); await page.getByRole('button', { name: 'Requirements', exact: true }).click(); };
    const inspect = async () => (await page.request.get('http://127.0.0.1:4318/_fixture/inspect/')).json();
    await open();
    await check('Actual consumable scan creates an unconfirmed draft; saving reserves without stock debit', async () => {
      const input = page.getByPlaceholder('Search or scan requirement...'); await input.fill('CONSUME-10'); await input.press('Enter');
      await page.getByRole('heading', { name: 'Select Quantity', exact: true }).waitFor(); await page.locator('input[type="number"]').last().fill('6');
      await page.getByRole('button', { name: /^Add.*6.*Units/ }).click();
      const draft = await page.evaluate(() => JSON.parse(Object.values(localStorage).find(value => value.includes('"schema":2') && value.includes('Synthetic consumable event'))).form.consumable_data['1']);
      assert.equal(draft.returned, null); assert.equal(draft.return_confirmed, false); assert.equal((await inspect()).stock, 10);
      await page.getByRole('button', { name: 'Save consumable requests', exact: true }).click();
      await page.getByText('6 units · requested', { exact: true }).waitFor(); assert.equal((await inspect()).stock, 10);
    });
    await check('A newer metadata edit made during a save survives its acknowledgement', async () => {
      await page.getByPlaceholder('e.g. KL 01 HJ 5241').fill('SAVED-VEHICLE');
      const arrived = new Promise(resolve => { reached = resolve; }); holdNext = true;
      await page.getByRole('button', { name: 'Save consumable requests', exact: true }).click(); await arrived;
      await page.getByPlaceholder('e.g. KL 01 HJ 5241').fill('NEWER-DRAFT-VEHICLE'); release();
      await page.getByText(/This event changed after your draft was started/).waitFor();
      assert.equal(await page.getByPlaceholder('e.g. KL 01 HJ 5241').inputValue(), 'NEWER-DRAFT-VEHICLE'); assert.equal((await inspect()).vehicle, 'SAVED-VEHICLE');
      await page.getByRole('button', { name: /Load latest saved details/ }).click();
    });
    await check('Dispatch leaves returns empty and settlement refuses an unconfirmed count', async () => {
      await page.getByRole('button', { name: 'Dispatch consumables', exact: true }).click(); await page.getByText('6 units · dispatched', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Crosscheck', exact: true }).click();
      assert.equal(await page.getByLabel('Returned to warehouse', { exact: true }).inputValue(), '');
      await page.getByRole('button', { name: 'SUBMIT', exact: true }).click(); await page.getByText(/Enter and verify each dispatched return count/).waitFor();
      assert.equal((await inspect()).stock, 10);
    });
    await check('Committed settlement lost response reloads and retries the same UUID without another deduction', async () => {
      await page.getByLabel('Returned to warehouse', { exact: true }).fill('2'); await page.getByLabel('I verified this return count', { exact: true }).check();
      dropNext = true; await page.getByRole('button', { name: 'SUBMIT', exact: true }).click(); await page.getByText(/Consumable save not confirmed/).waitFor();
      const first = writes.at(-1); assert.equal((await inspect()).stock, 6); assert.equal((await inspect()).settlements, 1);
      await page.reload(); await open(); await page.getByRole('button', { name: /movement.*pending.*retry/i }).click();
      await page.getByText(/Pending movements confirmed/).waitFor(); assert.deepEqual(writes.at(-1), first);
      const saved = await inspect(); assert.equal(saved.stock, 6); assert.equal(saved.settlements, 1); assert.equal(saved.data['1'].consumed, 4); assert.equal(saved.data['1'].status, 'settled');
    });
    await check('Admin, boss and assigned technician see the ledger; only warehouse roles see settlement', async () => {
      for (const [index, role] of ['admin', 'boss', 'technician'].entries()) {
        const actorPage = await context.newPage(); actorPage.on('pageerror', error => errors.push(error.message));
        await actorPage.addInitScript(({ role, id }) => {
          window.tailwind = { config: {} }; localStorage.setItem('token', `synthetic-${role}-token`);
          localStorage.setItem('user', JSON.stringify({ user_id: id, role, is_staff: false, email: `${role}@example.test` }));
        }, { role, id: index + 2 });
        await actorPage.goto('http://127.0.0.1:4317/');
        await actorPage.getByRole('button', { name: 'Conference', exact: true }).first().click();
        await actorPage.locator('button[title="Edit Conference Details"]').or(actorPage.getByRole('button', { name: /View Execution/ })).first().click();
        await actorPage.getByRole('button', { name: 'Requirements', exact: true }).click();
        await actorPage.getByText('6 units · settled', { exact: true }).waitFor();
        assert.equal(await actorPage.getByLabel('Requested quantity', { exact: true }).isDisabled(), true);
        await actorPage.getByRole('button', { name: 'Crosscheck', exact: true }).click();
        assert.equal(await actorPage.getByRole('button', { name: 'SUBMIT', exact: true }).count(), role === 'technician' ? 0 : 1);
        await actorPage.close();
      }
    });
    assert(writes.every(write => write.path.endsWith('/consumable-commands/'))); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Actual React App, migrated disposable SQLite and DRF; fresh Chrome context; loopback-only' }, null, 2));
  } catch (error) { console.error('Synthetic fixture diagnostics:', log); throw error; }
  finally { closing = true; clearTimeout(timer); if (release) release(); if (browser) await browser.close(); if (server) await server.close(); backend.kill('SIGTERM'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
