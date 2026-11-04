// Execute current state/queue/update modules with synthetic state and transports.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const ts = require(path.join(ROOT, 'frontend/node_modules/typescript'));
const loaded = new Map();
function load(file, overrides = {}, globals = {}) {
  if (loaded.has(file)) return loaded.get(file);
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/import\.meta\.env\.PROD/g, 'true');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  function localRequire(name) {
    if (overrides[name]) return overrides[name];
    if (name.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), `${name}.ts`)), overrides, globals);
    throw Error(`Unexpected import ${name}`);
  }
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(localRequire, module, module.exports, ...Object.values(globals));
  loaded.set(file, module.exports); return module.exports;
}
function storage() {
  const records = new Map();
  return { records, getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
}
const checks = [];
async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const drafts = load('frontend/state/challanDrafts.ts');
  await check('Draft keys isolate origin, account, event, stable truck ID and schema', () => {
    const keys = [drafts.challanDraftKey('a', '1', '1', 'master'), drafts.challanDraftKey('b', '1', '1', 'master'),
      drafts.challanDraftKey('a', '2', '1', 'master'), drafts.challanDraftKey('a', '1', '2', 'master'), drafts.challanDraftKey('a', '1', '1', 'truck-1')];
    assert.equal(new Set(keys).size, 5);
  });
  await check('Empty and zero-valued drafts survive storage without becoming old authority', () => {
    const store = storage();
    const draft = { schema: 2, baseRevision: 3, assets: [], total: 0, number: '', updatedAt: 'synthetic' };
    assert.equal(drafts.writeDraft(store, 'key', draft), true);
    assert.deepEqual(drafts.readDraft(store, 'key'), draft);
    drafts.removeDraft(store, 'key'); assert.equal(drafts.readDraft(store, 'key'), null);
  });
  await check('Corrupt or legacy cache data cannot masquerade as a scoped draft', () => {
    const store = storage();
    for (const value of ['invalid', '[]', '{"schema":1,"assets":[]}']) {
      store.setItem('key', value); assert.equal(drafts.readDraft(store, 'key'), null);
    }
  });
  await check('Storage failure is explicit', () => {
    assert.equal(drafts.writeDraft({ setItem() { throw Error('quota'); } }, 'key', {}), false);
  });
  await check('Older entity revisions cannot overwrite acknowledgements', () => {
    assert.equal(drafts.acceptRevision(10, 9), false); assert.equal(drafts.acceptRevision(10, 10), true);
  });
  const model = load('frontend/state/conferences.ts');
  await check('Mapping preserves consumables, values, quantities, audit state and zero stock', () => {
    const result = model.mapConference({ id: 1, revision: 3, is_audit: true, approximate_value: '0.00', consumable_data: { 2: { returned: 0 } },
      truck_challans_data: [{ id: 4, asset_quantities: { 2: 0 } }] });
    assert.equal(result.revision, 3); assert.equal(result.approximate_value, 0); assert.equal(result.isAudit, true);
    assert.equal(result.consumable_data[2].returned, 0); assert.equal(result.truckChallans[0].asset_quantities[2], 0);
    assert.equal(model.stockQuantity(0), 0); assert.equal(model.stockQuantity(null), 1);
  });
  const eventDrafts = load('frontend/state/eventDrafts.ts');
  await check('Event drafts isolate account/event and retain their captured base revision', () => {
    const store = storage(), key = eventDrafts.eventDraftKey('origin', 'actor', 'event');
    const draft = { schema: 2, baseRevision: 4, form: { id: 'event', name: 'Edited', revision: 4 }, updatedAt: 'synthetic' };
    store.setItem(key, JSON.stringify(draft)); assert.deepEqual(eventDrafts.readEventDraft(store, key), draft);
    assert.equal(eventDrafts.readEventDraft(store, eventDrafts.eventDraftKey('origin', 'another actor', 'event')), null);
  });
  await check('Movement membership changes do not bless another writer\'s event metadata', () => {
    const before = eventDrafts.eventEditorData(model.mapConference({ id: 1, revision: 1, name: 'Original', assets: [] }));
    const scan = eventDrafts.eventEditorData(model.mapConference({ id: 1, revision: 2, name: 'Original', assets: [1] }));
    const otherWriter = eventDrafts.eventEditorData(model.mapConference({ id: 1, revision: 3, name: 'Changed elsewhere', assets: [1] }));
    assert.equal(eventDrafts.eventMetadata(before), eventDrafts.eventMetadata(scan));
    assert.notEqual(eventDrafts.eventMetadata(before), eventDrafts.eventMetadata(otherWriter));
  });
  const appTree = ts.createSourceFile('App.tsx', fs.readFileSync(path.join(ROOT, 'frontend/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function appFunction(name, scope) {
    let expression;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(appTree) === name) {
        expression = node.initializer;
        if (ts.isCallExpression(expression)) expression = expression.arguments[0];
      }
      ts.forEachChild(node, visit);
    }
    visit(appTree); assert.ok(expression, name);
    const code = ts.transpileModule(`const implementation = ${expression.getText(appTree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(scope), `${code}; return implementation;`)(...Object.values(scope));
  }
  function requestScope() {
    const store = storage(); store.setItem('token', 'synthetic-session'); const published = [];
    return { console: { error() {} }, localStorage: store, setWorkBlocker: () => {}, mapConference: model.mapConference, acceptRevision: drafts.acceptRevision,
      handleLogout() {}, conferenceSnapshotsRef: { current: new Map([['1', { id: '1', revision: 10 }]]) },
      conferenceFetchIdRef: { current: 0 }, setBackendConferences: value => published.push(value), setSelectedBookingForChallan: value => published.push(value), published };
  }
  await check('A delayed older write acknowledgement cannot overwrite a newer accepted revision', async () => {
    const scope = requestScope(); scope.fetch = async () => new Response(JSON.stringify({ id: 1, revision: 9 }), { status: 200 });
    await appFunction('apiFetch', scope)('/api/conferences/1/', { method: 'PATCH', body: '{}' });
    assert.equal(scope.conferenceSnapshotsRef.current.get('1').revision, 10); assert.equal(scope.published.length, 0);
  });
  await check('Responses from a previous login session cannot publish business data', async () => {
    const scope = requestScope(); scope.fetch = async () => { scope.localStorage.setItem('token', 'different-session'); return new Response('{}'); };
    await assert.rejects(appFunction('apiFetch', scope)('/api/conferences/1/'), /Account changed/);
    assert.equal(scope.published.length, 0);
  });
  const identity = load('frontend/state/scanIdentity.ts');
  await check('Matching rejects blank, punctuation-only and arbitrary numeric words', () => {
    const pool = [{ id: '123', sku: 'M26', serialNumber: '' }];
    for (const code of ['', '!!', 'conference 123', '123']) assert.notEqual(identity.resolveScan(code, pool).kind, 'matched');
    assert.equal(identity.resolveScan('SKU: M26', pool).kind, 'matched');
  });
  await check('Duplicate identifiers are ambiguous rather than first-match assignment', () => {
    assert.equal(identity.resolveScan('M26', [{ id: '1', sku: 'M26' }, { id: '2', sku: 'M26' }]).kind, 'ambiguous');
  });
  const { MovementOutbox, RejectedMovement } = load('frontend/state/movementOutbox.ts');
  await check('100 rapid scans drain in order without losing persisted operations', async () => {
    const store = storage(), sent = [], acknowledged = [];
    const outbox = new MovementOutbox('queue', store, async operation => { sent.push(operation.payload.asset_ids[0]); return operation; }, result => acknowledged.push(result));
    await Promise.all(Array.from({ length: 100 }, (_, index) => outbox.enqueue('1', 'stage', [index + 1])));
    assert.deepEqual(sent, Array.from({ length: 100 }, (_, index) => index + 1));
    assert.equal(acknowledged.length, 100); assert.equal(outbox.pending().length, 0);
  });
  await check('Reload after an uncertain response retries the same UUID exactly', async () => {
    const store = storage(); let firstId, retryId, sends = 0;
    const first = new MovementOutbox('queue', store, async operation => { firstId = operation.payload.request_id; sends++; throw Error('timeout'); }, () => {});
    await assert.rejects(first.enqueue('1', 'return', [1]));
    const reloaded = new MovementOutbox('queue', store, async operation => { retryId = operation.payload.request_id; return { saved: true }; }, () => {});
    await reloaded.flush(); assert.equal(firstId, retryId); assert.equal(sends, 1); assert.equal(reloaded.pending().length, 0);
  });
  await check('Explicit atomic rejection is reported and does not retry forever', async () => {
    const outbox = new MovementOutbox('queue', storage(), async () => { throw new RejectedMovement('held_elsewhere'); }, () => {});
    await assert.rejects(outbox.enqueue('1', 'stage', [1]), /held_elsewhere/); assert.equal(outbox.pending().length, 0);
  });
  await check('Unavailable durable storage blocks sending before any movement', async () => {
    let sent = false;
    const outbox = new MovementOutbox('queue', { getItem: () => null, setItem() { throw Error('quota'); } }, async () => { sent = true; }, () => {});
    await assert.rejects(outbox.enqueue('1', 'stage', [1])); assert.equal(sent, false);
  });
  const safety = load('frontend/state/workSafety.ts');
  await check('Dirty and pending blockers independently prevent updates', () => {
    safety.setWorkBlocker('draft', true); safety.setWorkBlocker('request', true); safety.setWorkBlocker('draft', false);
    assert.equal(safety.hasPendingWork(), true); safety.setWorkBlocker('request', false); assert.equal(safety.hasPendingWork(), false);
  });
  let skips = 0; const listeners = {}; const waiting = [];
  const workbox = { clientsClaim() {}, cleanupOutdatedCaches() {}, precacheAndRoute() {}, createHandlerBoundToURL() { return () => {}; }, registerRoute() {},
    NavigationRoute: class {}, CacheFirst: class {}, ExpirationPlugin: class {} };
  load('frontend/sw.ts', Object.fromEntries(['core', 'precaching', 'routing', 'strategies', 'expiration'].map(name => [`workbox-${name}`, workbox])), {
    self: { clients: { matchAll: async () => [] }, __WB_MANIFEST: [], addEventListener: (name, handler) => { listeners[name] = handler; }, skipWaiting: async () => { skips++; } }, caches: { delete: async () => true },
  });
  await check('New worker ignores legacy automatic SKIP_WAITING and accepts explicit approval', async () => {
    listeners.message({ data: { type: 'SKIP_WAITING' } }); assert.equal(skips, 0);
    listeners.message({ data: { type: 'TT_UPDATE_APPROVED' }, waitUntil: promise => waiting.push(promise) }); await Promise.all(waiting); assert.equal(skips, 1);
  });
  let reloads = 0, message, controllerHandler;
  const registration = { waiting: { postMessage: data => { message = data; } }, addEventListener() {}, removeEventListener() {} };
  const react = { useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect: fn => fn() };
  const update = load('frontend/state/useAppUpdates.ts', { react }, {
    navigator: { serviceWorker: { register: async () => registration, addEventListener: (name, handler) => { if (name === 'controllerchange') controllerHandler = handler; }, removeEventListener() {} } },
    window: { location: { reload() { reloads++; } } },
  }).useAppUpdates();
  await new Promise(resolve => setImmediate(resolve));
  await check('First install and external controller changes never navigate', () => {
    controllerHandler(); assert.equal(reloads, 0);
  });
  await check('Updates are blocked by work and reload only after explicit approval', async () => {
    safety.setWorkBlocker('dirty', true); assert.equal(await update.updateServiceWorker(), false); assert.equal(message, undefined);
    safety.setWorkBlocker('dirty', false); assert.equal(await update.updateServiceWorker(), true);
    assert.equal(message.type, 'TT_UPDATE_APPROVED'); controllerHandler(); assert.equal(reloads, 1);
  });
  console.log(`${checks.length} Step 3 frontend checks passed. Synthetic state/transports only.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
