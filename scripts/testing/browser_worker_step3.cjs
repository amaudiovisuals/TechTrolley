// The generated production worker and actual update hook, in an isolated origin.
// The old client is a representative legacy automatic-reload client, not the live bundle.
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http');
const path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '../..');
const { chromium, launchOptions } = require('./browser_runtime.cjs');
const { build } = require(path.join(ROOT, 'frontend/node_modules/esbuild'));
const checks = [];
async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-worker-tests-'));
  let browser, server;
  try {
    fs.cpSync(path.join(ROOT, 'frontend/dist'), temporary, { recursive: true });
    await build({ entryPoints: [path.join(ROOT, 'frontend/testing/updateFixture.tsx')], bundle: true, format: 'esm',
      outfile: path.join(temporary, 'fixture.js'), define: { 'import.meta.env.PROD': 'true' } });
    const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
    fs.writeFileSync(path.join(temporary, 'index.html'), html);
    const generatedWorker = fs.readFileSync(path.join(temporary, 'sw.js'), 'utf8');
    let worker = generatedWorker, apiRequests = 0;
    const oldWorker = 'self.addEventListener("install",e=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));';
    const legacyHtml = `<!doctype html><html><body>Representative legacy client<script>
      sessionStorage.setItem('legacyNavigations',String(Number(sessionStorage.getItem('legacyNavigations')||0)+1));
      let controlled=!!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange',()=>{if(controlled)location.reload();controlled=true;});
      navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
    </script></body></html>`;
    server = http.createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const route = new URL(request.url, 'http://localhost').pathname;
      if (route.startsWith('/api/')) { apiRequests++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ requests: apiRequests })); return; }
      if (route === '/sw.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(worker); return; }
      if (route === '/legacy.html') { response.setHeader('Content-Type', 'text/html'); response.end(legacyHtml); return; }
      const file = path.join(temporary, route === '/' ? 'index.html' : route.slice(1));
      if (!file.startsWith(temporary + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      response.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(4312, '127.0.0.1', resolve));
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:4312/') ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:4312/');
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await check('Actual generated worker first activation does not navigate the new client', async () => {
      assert.equal(await page.evaluate(() => sessionStorage.getItem('navigations')), '1');
    });
    await check('Authenticated API responses are not cached by the generated worker', async () => {
      assert.deepEqual(await page.evaluate(async () => [await (await fetch('/api/test')).json(), await (await fetch('/api/test')).json()]), [{ requests: 1 }, { requests: 2 }]);
      await context.setOffline(true);
      assert.equal(await page.evaluate(async () => { try { await fetch('/api/test'); return 'served'; } catch { return 'failed'; } }), 'failed');
      await context.setOffline(false);
    });
    await check('Waiting update preserves dirty work and navigates only after explicit approval', async () => {
      await page.getByRole('button', { name: 'Dirty', exact: true }).click();
      worker = `${generatedWorker}\n// synthetic-release-2`;
      await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
      await page.getByTestId('available').filter({ hasText: 'true' }).waitFor();
      await page.getByRole('button', { name: 'Update', exact: true }).click();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('navigations')), '1');
      assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting), true);
      await page.getByRole('button', { name: 'Clean', exact: true }).click();
      const other = await context.newPage();
      await other.goto('http://127.0.0.1:4312/');
      await other.getByRole('button', { name: 'Dirty', exact: true }).click();
      await page.getByRole('button', { name: 'Update', exact: true }).click();
      await page.getByTestId('blocked').filter({ hasText: 'true' }).waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('navigations')), '1');
      await other.getByRole('button', { name: 'Clean', exact: true }).click();
      await page.getByRole('button', { name: 'Update', exact: true }).click();
      await page.waitForFunction(() => sessionStorage.getItem('navigations') === '2');
      assert.equal(await other.evaluate(() => sessionStorage.getItem('navigations')), '1');
      await other.close();
    });
    assert.deepEqual(errors, []); await context.close();
    worker = oldWorker;
    const legacyContext = await browser.newContext(); const legacyPage = await legacyContext.newPage();
    await legacyPage.goto('http://127.0.0.1:4312/legacy.html');
    await legacyPage.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await check('New worker ignores old-client SKIP_WAITING and avoids a forced legacy reload', async () => {
      worker = generatedWorker;
      await legacyPage.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
      await legacyPage.evaluate(async () => { window.__registration = await navigator.serviceWorker.getRegistration(); });
      await legacyPage.waitForFunction(() => !!window.__registration.waiting);
      await legacyPage.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting.postMessage({ type: 'SKIP_WAITING' }));
      // Round-trip a server request after the message; the worker must still be waiting.
      await legacyPage.evaluate(() => fetch('/api/message-barrier'));
      assert.equal(await legacyPage.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting), true);
      assert.equal(await legacyPage.evaluate(() => sessionStorage.getItem('legacyNavigations')), '1');
    });
    await check('Explicit approval in a new tab cannot force an old legacy tab to reload', async () => {
      const current = await legacyContext.newPage();
      await current.goto('http://127.0.0.1:4312/');
      await current.getByTestId('available').filter({ hasText: 'true' }).waitFor();
      await current.getByRole('button', { name: 'Update', exact: true }).click();
      await current.getByTestId('blocked').filter({ hasText: 'true' }).waitFor();
      assert.equal(await legacyPage.evaluate(() => sessionStorage.getItem('legacyNavigations')), '1');
      assert.equal(await current.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting), true);
      await legacyPage.close();
      await current.getByRole('button', { name: 'Update', exact: true }).click();
      await current.waitForFunction(() => sessionStorage.getItem('navigations') === '2');
    });
    await legacyContext.close();
    console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Isolated headless Chrome; generated worker + actual React update hook; representative legacy client; no production connection' }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
