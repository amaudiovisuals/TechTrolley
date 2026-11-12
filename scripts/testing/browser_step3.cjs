// Isolated temporary browser + Vite fixture; never connects to the business API.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const runtime = process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
const { chromium } = require(runtime);
const checks = [];
async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({ root: path.join(ROOT, 'frontend'), configFile: path.join(ROOT, 'frontend/vite.config.ts'),
    server: { host: '127.0.0.1', port: 4311, strictPort: true } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TT_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:4311/') ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto('http://127.0.0.1:4311/testing/challan.html');
    await page.waitForFunction(() => window.__fixture);
    await page.getByRole('button', { name: 'Edit Mode', exact: true }).click();
    // Find the actual input by its value, independently of presentation classes.
    const firstInput = () => page.locator('input[value="Synthetic first"]').first();
    await firstInput().fill('Synthetic draft edit');
    await check('Actual editor preserves an unsaved row through a server poll', async () => {
      await page.evaluate(() => window.__fixture.poll([{ ...window.__fixture.first, aliasName: 'Saved replacement' }]));
      await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'Synthetic draft edit'));
      assert.equal(await page.evaluate(() => window.__fixture.blocked()), true);
    });
    await check('Failed save retains draft and edit mode', async () => {
      await page.evaluate(() => window.__fixture.fail(true));
      await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByTestId('toast').filter({ hasText: 'unsaved' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save Changes', exact: true }).count(), 1);
    });
    await check('Page reload restores the account-scoped unsaved draft', async () => {
      await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('tt:draft:2:')));
      await page.reload(); await page.waitForFunction(() => window.__fixture);
      await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'Synthetic draft edit'));
    });
    await check('Account, event and truck switches do not inherit another document draft', async () => {
      for (const [field, value] of [['account', 'test-account-b'], ['event', '202'], ['truck', 'truck-2']]) {
        await page.evaluate(([field, value]) => window.__fixture[field](value), [field, value]);
        await page.getByRole('button', { name: 'Edit Mode', exact: true }).waitFor();
        assert.equal(await page.locator('input[value="Synthetic draft edit"]').count(), 0);
      }
      await page.evaluate(() => { window.__fixture.account('test-account-a'); window.__fixture.event('101'); window.__fixture.truck('master'); });
      await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'Synthetic draft edit'));
    });
    await check('Newer revision preserves draft and requires comparison before saving', async () => {
      await page.evaluate(() => window.__fixture.poll([window.__fixture.first], 2));
      await page.getByText('The saved challan changed elsewhere.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__saved.length), 0);
      await page.getByText('Compare with the latest saved version', { exact: true }).click();
      await page.getByRole('button', { name: 'Keep this reviewed draft' }).click();
      await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Mode', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__saved[0].expected_event_revision), 2);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tt:draft:2:')).length), 0);
    });
    await check('Clean documents accept empty/removal responses across repeated polls', async () => {
      await page.evaluate(() => window.__fixture.poll([], 4));
      await page.waitForFunction(() => !document.body.textContent.includes('Synthetic draft edit'));
      for (let index = 0; index < 24; index++) await page.evaluate(() => window.__fixture.poll([], 4));
      assert.equal(await page.evaluate(() => window.__fixture.blocked()), false);
    });
    // Also exercise the real App's event form against synthetic HTTP responses.
    let serverRevision = 1;
    const event = () => ({ id: 301, revision: serverRevision, name: 'Synthetic root event', association_name: 'Synthetic association',
      start_date: '2026-10-09', end_date: '2026-10-10', conference_type: 'Medical Conference',
      assets: [], staged_assets: [], requirements: [], crosscheck_assets: [], challan_assets: [], assigned_employees: [],
      consumable_data: {}, truck_challans_data: [], flag_log: [], approximate_value: null, is_audit: false, challan_number: 'SYNTHETIC-301' });
    const account = { user_id: 1, role: 'admin', email: 'synthetic@example.test', is_staff: true };
    await context.route('**/api/**', route => {
      const url = new URL(route.request().url());
      assert.equal(route.request().method(), 'GET', 'This root form test must not write even to its synthetic transport');
      const data = url.pathname.endsWith('/my-profile/') ? account : url.pathname.endsWith('/conferences/') ? [event()] :
        url.pathname.endsWith('/company-settings/') ? { name: 'Synthetic company', dashboard_config: {} } :
        url.pathname.endsWith('/asset-stats/') ? { total: 1, ready: 1, in_use: 0, maintenance: 0 } :
        url.pathname.endsWith('/assets/') ? (url.searchParams.has('all') ? [] : { results: [], count: 0 }) : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.evaluate(account => { localStorage.setItem('token', 'synthetic-root-token'); localStorage.setItem('user', JSON.stringify(account)); }, account);
    await page.addInitScript(() => { window.tailwind = { config: {} }; });
    await page.goto('http://127.0.0.1:4311/');
    const openEvent = async () => {
      await page.getByRole('button', { name: 'Conference', exact: true }).first().click();
      await page.getByTitle('Edit Conference Details').first().click();
    };
    await check('Actual App event metadata survives reload as a scoped draft', async () => {
      await openEvent();
      await page.locator('input[value="Synthetic root event"]').fill('Synthetic preserved metadata');
      await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('tt:event-draft:2:') && localStorage.getItem(key).includes('Synthetic preserved metadata')));
      await page.reload(); await openEvent();
      await page.locator('input[value="Synthetic preserved metadata"]').waitFor();
    });
    await check('Actual App exposes a stale event draft instead of overwriting a newer server revision', async () => {
      serverRevision = 2;
      await page.reload(); await openEvent();
      await page.getByText('This event changed after your draft was started.', { exact: false }).waitFor();
      await page.locator('input[value="Synthetic preserved metadata"]').waitFor();
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Isolated headless Chrome; actual React editor with synthetic props/callbacks; no backend or production connection' }, null, 2));
  } finally { if (browser) await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
