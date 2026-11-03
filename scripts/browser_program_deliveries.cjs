const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.TT_PLAYWRIGHT_MODULE || '/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  let backend, server, browser, page;
  const errors = [], checks = [], issuedRequests = [];
  try {
    backend = spawn(process.env.TT_TEST_PYTHON || 'python3', ['-B', 'scripts/serve_delivery_acceptance.py'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let backendErrors = '';
    backend.stderr.on('data', value => { backendErrors = (backendErrors + value).slice(-5000); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic backend startup timed out: ' + backendErrors)), 15000);
      backend.on('error', reject);
      backend.on('exit', code => { clearTimeout(timeout); reject(new Error(`Synthetic backend exited ${code}: ${backendErrors}`)); });
      backend.stdout.on('data', value => { if (String(value).includes('SYNTHETIC_DELIVERY_READY')) { clearTimeout(timeout); resolve(); } });
    });
    const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
    server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 4667, strictPort: true } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
    let loseFirstResponse = true;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['http://127.0.0.1:4667', 'http://127.0.0.1:4668'].includes(url.origin)) return route.abort();
      if (request.method() === 'POST' && url.pathname.endsWith('/deliveries/')) {
        issuedRequests.push(request.postDataJSON());
        if (loseFirstResponse) {
          loseFirstResponse = false;
          await route.fetch(); // Server commits, then the response is lost.
          return route.abort('connectionreset');
        }
      }
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4667/testing/program-deliveries.html');
    await page.getByText('No saved deliveries yet.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'New delivery', exact: true }).click();
    await page.getByLabel('Description AM-M17').fill('Supplier laptop <script>alert("bad")</script>');
    await page.getByRole('button', { name: 'Issue delivery challans', exact: true }).click();
    await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).waitFor();
    assert(await page.getByLabel('Description AM-M17').isDisabled());
    await page.getByRole('button', { name: 'Retry saving same delivery', exact: true }).click();
    await page.getByText(/OUT-000001 — saved copy/).waitFor();
    assert.deepEqual(issuedRequests[0], issuedRequests[1]);
    checks.push('Lost response retry recovers the same delivery number and exact request');
    const supplierButton = page.getByRole('button', { name: /AM synthetic supplier — .*SR1-000001/ });
    await supplierButton.click();
    let frame = page.frameLocator('iframe');
    await frame.getByText('AM synthetic supplier', { exact: true }).first().waitFor();
    assert.equal(await frame.getByText('AM synthetic supplier', { exact: true }).count(), 3);
    assert.equal(await frame.getByText('Pvt Ltd synthetic issuer', { exact: true }).count(), 3);
    assert.equal(await frame.getByText('Supplier laptop <script>alert("bad")</script>', { exact: true }).count(), 3);
    assert.equal(await frame.locator('script').count(), 0);
    assert.equal(await frame.getByText('OWN-SPEAKER', { exact: true }).count(), 0);
    checks.push('Supplier paper has only its equipment, correct direction, escaped descriptions and three copies');
    const printFrame = page.frames().find(f => f.url() === 'about:srcdoc');
    const printSession = await context.newCDPSession(page);
    // Capture the same standalone saved HTML in a separate page for real A4
    // pagination acceptance; no Tailwind/CDN or application chrome is needed.
    const printPage = await context.newPage();
    await printPage.setContent(await printFrame.content());
    await printPage.emulateMedia({ media: 'print' });
    const pdfPath = process.env.TT_DELIVERY_PDF || '/tmp/techtrolley-supplier-delivery-synthetic.pdf';
    await printPage.pdf({ path: pdfPath, format: 'A4', preferCSSPageSize: true, printBackground: true });
    assert(fs.statSync(pdfPath).size > 10000);
    await printPage.close(); await printSession.detach();
    checks.push('Standalone saved supplier paper renders to an A4 PDF');
    await page.reload();
    await supplierButton.waitFor(); await supplierButton.click();
    await page.getByRole('button', { name: 'New delivery', exact: true }).click();
    assert(!(await page.getByLabel('Include AM-M17').isChecked()));
    await page.getByLabel('Include AM-M17').check();
    await page.getByLabel('Delivery reference').fill('Tomorrow delivery');
    await page.getByRole('button', { name: 'Issue delivery challans', exact: true }).click();
    await page.getByText(/OUT-000002 — saved copy/).waitFor();
    checks.push('Refresh retains saved papers; a separate delivery gets new customer and supplier numbers');
    await page.goto('http://127.0.0.1:4667/testing/program-deliveries.html?accounts=1');
    await page.getByRole('button', { name: /AM synthetic supplier — .*SR1-000001/ }).click();
    await page.frameLocator('iframe').getByText('AM-M17', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'New delivery', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Void delivery', exact: true }).count(), 0);
    assert.equal(await page.frameLocator('iframe').getByText('AM-M17', { exact: true }).count(), 3);
    await page.getByRole('button', { name: /Customer — .*OUT-000001/ }).click();
    await page.frameLocator('iframe').getByText('OWN-SPEAKER', { exact: true }).first().waitFor();
    assert.equal(await page.frameLocator('iframe').getByText('OWN-SPEAKER', { exact: true }).count(), 3);
    checks.push('Accounts reopens both document directions without issue/void controls');
    await page.goto('http://127.0.0.1:4667/testing/program-deliveries.html');
    await page.getByRole('button', { name: 'Void delivery', exact: true }).last().click();
    await page.getByLabel('Void reason').fill('Synthetic correction');
    await page.getByRole('button', { name: 'Confirm void', exact: true }).click();
    await page.getByRole('button', { name: /AM synthetic supplier — .*SR1-000001/ }).click();
    await page.frameLocator('iframe').getByText('VOID — Synthetic correction', { exact: true }).first().waitFor();
    assert.equal(await page.frameLocator('iframe').getByText('VOID — Synthetic correction', { exact: true }).count(), 3);
    checks.push('Voiding preserves all original papers with a visible void marker');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, pageErrors: errors, backend: 'real Django, isolated in-memory synthetic fixtures', pdf: pdfPath, productionAccess: false }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ errors, text: page ? (await page.locator('body').innerText()).slice(-3000) : '' }));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    if (backend) backend.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
