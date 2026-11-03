const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  let server, browser, page;
  const checks = [], requests = [], failures = [], movements = [];
  let inventoryFails = false;
  const user = { id: 990001, username: 'synthetic-incharge', role: 'godown_incharge', is_staff: true };
  let event = { id: 990100, name: 'Synthetic scan event', association_name: 'Synthetic customer', conference_type: 'Medical Conference', start_date: '2026-11-03', end_date: '2026-11-04', assets: [], requirements: [], staged_assets: [], crosscheck_assets: [], challan_assets: [], assigned_employees: [], is_audit: false, truck_challans_data: [] };
  const supplier = { id: 7, name: 'AM test supplier', address: '', gst_number: '' };
  const stock = Array.from({ length: 57 }, (_, i) => ({ id: 7000 + i, sku: `SUP-${i}`, alias_name: `Supplier unit ${i}`, serial_number: `SN-${i}`, quantity: 1, item_price: '100.00', type: 'Laptops', status: 'Available', subrental_company: 7, subrental_company_name: supplier.name, is_temporary: false, sub_assets: [] }));
  try {
    server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 4666, strictPort: true } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(user => {
      // The existing page configures its CDN Tailwind runtime inline. Styling is
      // outside this offline functional fixture; do not send network traffic.
      window.tailwind = { config: {} };
      localStorage.setItem('token', 'synthetic-browser-token');
      localStorage.setItem('user', JSON.stringify(user));
    }, user);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:4666' && !url.pathname.startsWith('/api/')) return route.continue();
      if (!['http://127.0.0.1:4666', 'http://127.0.0.1:8000'].includes(url.origin)) return route.abort();
      requests.push(url.pathname + url.search);
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      let data = [];
      if (url.pathname === '/api/my-profile/') data = user;
      else if (url.pathname === '/api/company-settings/') data = { name: 'Synthetic issuer', next_challan_number: 1, dashboard_config: {} };
      else if (url.pathname === '/api/subrental-companies/') data = [supplier];
      else if (url.pathname === '/api/conferences/') data = [event];
      else if (url.pathname === `/api/conferences/${event.id}/` && request.method() === 'PATCH') {
        movements.push(request.postDataJSON());
        event = { ...event, ...request.postDataJSON() };
        data = event;
      }
      else if (url.pathname === '/api/assets/' && url.searchParams.has('subrental_company_id')) {
        assert.equal(url.searchParams.get('all'), 'true');
        if (inventoryFails) return route.fulfill({ status: 503, headers, json: { error: 'Synthetic inventory unavailable' } });
        data = stock;
      } else if (url.pathname === '/api/assets/') data = stock;
      else if (url.pathname === '/api/asset-stats/') data = { total: 57, ready: 57, in_use: 0, maintenance: 0 };
      else if (url.pathname === '/api/download-template/') return route.fulfill({ status: 200, headers, body: Buffer.from('synthetic-template-download') });
      else if (url.pathname === '/api/upload-assets/') return route.fulfill({ status: 400, headers, json: { created: 0, updated: 0, skipped: 0, errors: ['Row 2: Existing inventory was not changed.'] } });
      else if (request.method() !== 'GET') throw new Error(`Unexpected mutation: ${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 200, headers, json: data });
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => failures.push(error.message));
    await page.goto('http://127.0.0.1:4666/', { waitUntil: 'networkidle' });
    await page.getByText('Subrentals', { exact: true }).first().click();
    await page.getByText(supplier.name, { exact: true }).first().click();
    await page.getByRole('button', { name: /View Inventory/i }).click();
    await page.getByText('SUP-56', { exact: true }).waitFor();
    checks.push('Actual App loads supplier stock beyond the first 50 rows');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Template', exact: true }).click();
    await download;
    assert(requests.some(url => url.startsWith('/api/download-template/')));
    assert(!requests.some(url => url.startsWith('/api/export-inventory/')));
    checks.push('Supplier Template uses the example-template endpoint');
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('synthetic-upload') });
    await page.getByText('Row 2: Existing inventory was not changed.', { exact: true }).waitFor();
    checks.push('Import failures display row-level errors on the supplier screen');
    await page.reload();
    await page.getByText('Subrentals', { exact: true }).first().click();
    await page.getByText(supplier.name, { exact: true }).first().click();
    inventoryFails = true;
    await page.getByRole('button', { name: /View Inventory/i }).click();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    inventoryFails = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('SUP-56', { exact: true }).waitFor();
    checks.push('Failed supplier loading offers Retry and recovers');
    await page.getByText('Conference', { exact: true }).first().click();
    await page.getByTitle('Edit Conference Details', { exact: true }).first().click();
    const scanInput = page.getByPlaceholder('Search or scan requirement...').first();
    const savedScan = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes(`/api/conferences/${event.id}/`));
    await scanInput.fill('SUP-56');
    await scanInput.press('Enter');
    await page.getByText(/Subrental: AM test supplier/).first().waitFor();
    await savedScan;
    await scanInput.fill('SUP-56');
    await scanInput.press('Enter');
    assert.equal(event.staged_assets.filter(id => String(id) === '7056').length, 1);
    checks.push('Actual supplier unit scan stages the original ID once and shows its owner');
    await page.goto('http://127.0.0.1:4666/testing/hotfix-challan.html');
    await page.getByText('Subrental: AM test supplier', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('Subrental: AM test supplier', { exact: true }).count(), 3);
    assert.equal(await page.getByText('Pvt Ltd test issuer — Owned inventory', { exact: true }).count(), 3);
    assert.equal(await page.getByText('Manual additions', { exact: true }).count(), 3);
    checks.push('Actual challan renders distinct owner sections in all three copies');
    const group = page.getByRole('button', { name: /Group by Model/i });
    if (await group.count()) await group.click();
    assert.equal(await page.getByText('Subrental: AM test supplier', { exact: true }).count(), 3);
    checks.push('Grouping the same model retains separate owners');
    await page.goto('http://127.0.0.1:4666/testing/hotfix-challan.html?overlap=1');
    await page.getByRole('alert').filter({ hasText: 'same equipment' }).waitFor();
    assert.equal(await page.locator('table').count(), 0);
    checks.push('Inventory/ticket overlap refuses a double-counted printed challan');
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ checks, pageErrors: failures, externalTrafficBlocked: true, productionAccess: false, styledPrintAcceptance: false }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ requests, failures, visibleText: page ? (await page.locator('body').innerText()).slice(-3500) : '' }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
