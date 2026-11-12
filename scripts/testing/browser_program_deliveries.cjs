// Real React delivery component; synthetic HTTP papers and a deliberately lost
// reply verify the browser's recovery contract without a business database.
const assert = require('node:assert/strict'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { chromium, launchOptions } = require('./browser_runtime.cjs');
const root = path.resolve(__dirname, '../..');
(async () => {
  const { createServer } = await import(pathToFileURL(path.join(root, 'frontend/node_modules/vite/dist/node/index.js')).href);
  const componentEntry = `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ProgramDeliveries } from '/components/ProgramDeliveries.tsx';
    import { hasPendingWork } from '/state/workSafety.ts'; window.hasPendingDeliveryWork = hasPendingWork;
    createRoot(document.getElementById('root')).render(React.createElement(ProgramDeliveries, { conferenceId: '1', accountId: 'synthetic-actor', canIssue: true, apiBase: '', apiFetch: (url, options) => fetch(url, options) }));`;
  const server = await createServer({ root: path.join(root, 'frontend'), configFile: path.join(root, 'frontend/vite.config.ts'),
    plugins: [{ name: 'synthetic-delivery-entry', resolveId(id) { if (id === '/delivery-recovery-main.js') return '\0delivery-recovery-main'; }, load(id) { if (id === '\0delivery-recovery-main') return componentEntry; } }],
    server: { host: '127.0.0.1', port: 4391, strictPort: true } });
  await server.listen(); const browser = await chromium.launch(launchOptions());
  const checks = [], errors = [], calls = []; let saved = null, mode = 'lost', page;
  const check = async (name, fn) => { await fn(); checks.push(name); };
  const paper = { number: '26-27/OUT-000001', reference: 'Delivery 1', direction: 'customer', issuer: { name: 'Synthetic Pvt Ltd' }, recipient: { name: 'Synthetic customer' }, rows: [], delivery_date: '2026-11-04', vehicle_number: '', driver_phone: '', destination: '', program: { name: 'Synthetic program', start_date: '', end_date: '' } };
  const preview = { source_hash: 'a'.repeat(64), suggested_reference: 'Delivery 1', previously_delivered: {}, source: { issuer: paper.issuer, customer: paper.recipient, vehicle_number: '', driver_phone: '', rows: [{ key: 'asset:1', name: 'Synthetic cable', sku: 'SYNTH-CABLE', serial: '', quantity: 6, owner_id: 1, owner: { name: 'Synthetic AM' } }] } };
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/delivery-recovery-main.js"></script></body></html>`;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:4391') return route.abort();
      if (url.pathname === '/delivery-recovery-test') return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml(url.pathname, html) });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname.endsWith('/preview/')) return route.fulfill({ json: preview });
      if (request.method() === 'GET') return route.fulfill({ json: saved ? [saved] : [] });
      const body = request.postDataJSON(); calls.push(body);
      if (!saved) saved = { id: 1, reference: body.reference.trim(), issued_at: new Date().toISOString(), issued_by: 'synthetic', voided_at: null, void_reason: '', snapshot: { customer_document: { ...paper, reference: body.reference.trim(), rows: preview.source.rows }, supplier_documents: [] } };
      if (mode === 'lost') return route.abort('connectionreset');
      if (mode === 'server-error') return route.fulfill({ status: 502, json: { detail: 'Synthetic gateway lost the reply' } });
      if (mode === 'malformed') return route.fulfill({ status: 200, json: {} });
      return route.fulfill({ status: 200, json: saved });
    });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.goto('http://127.0.0.1:4391/delivery-recovery-test');
    await check('Review protects pending work from app restart', async () => {
      await page.getByRole('button', { name: 'New delivery', exact: true }).click(); await page.getByLabel('Quantity SYNTH-CABLE').waitFor();
      await page.getByLabel('Delivery reference').fill(' Delivery 1 ');
      const supplier=page.getByRole('region',{name:'Supplier paper 1'});await supplier.getByRole('button',{name:'Edit supplier details',exact:true}).click();
      assert.equal(await supplier.getByLabel('Supplier vehicle 1',{exact:true}).inputValue(),'');assert.equal(await supplier.getByLabel('Supplier driver phone 1',{exact:true}).inputValue(),'');
      await supplier.getByLabel('Supplier address 1',{exact:true}).fill('Reviewed supplier road');
      assert.equal(await page.evaluate(() => window.hasPendingDeliveryWork()), true);
    });
    await check('Committed issue with lost reply retains its exact payload before sending', async () => {
      await page.getByRole('button', { name: 'Issue delivery challans', exact: true }).click();
      await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).waitFor();
      assert.equal(calls.length, 1);
      const durable = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('pending-delivery')).map(([, value]) => JSON.parse(value)));
      assert.equal(durable.length, 1); assert.deepEqual(durable[0].request, calls[0]);
      assert.equal(calls[0].supplier_details['1'].issuer_address,'Reviewed supplier road');
    });
    await check('Reload recovers the same request without automatic replay or new issuance', async () => {
      await page.reload(); await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).waitFor();
      assert.equal(calls.length, 1); assert.equal(await page.getByRole('button', { name: 'New delivery', exact: true }).isDisabled(), true);
      assert.equal(await page.evaluate(() => window.hasPendingDeliveryWork()), true);
    });
    await check('Gateway failures and malformed success replies keep the uncertain request', async () => {
      for (const value of ['server-error', 'malformed']) {
        mode = value; await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).click();
        await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).waitFor();
        await page.reload(); await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).waitFor();
      }
      calls.forEach(body => assert.deepEqual(body, calls[0]));
    });
    await check('Same UUID retry recovers one saved number and clears only confirmed work', async () => {
      mode = 'success'; await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).click();
      await page.getByText('26-27/OUT-000001 — saved copy', { exact: true }).waitFor();
      calls.forEach(body => assert.deepEqual(body, calls[0])); assert.equal(new Set(calls.map(body => body.request_key)).size, 1);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('pending-delivery')).length), 0);
      assert.equal(await page.evaluate(() => window.hasPendingDeliveryWork()), false);
      assert.equal(await page.getByRole('button', { name: 'Customer — 26-27/OUT-000001', exact: true }).count(), 1);
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: checks.length, checks, actual_React_component: true, synthetic_HTTP_only: true, business_stock_modified: false }, null, 2));
  } catch (error) { console.error({ pageErrors: errors, body: page ? (await page.locator('body').innerText()).slice(-2000) : '' }); throw error; }
  finally { if (page) await page.close({ runBeforeUnload: false }); await browser.close(); await server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
