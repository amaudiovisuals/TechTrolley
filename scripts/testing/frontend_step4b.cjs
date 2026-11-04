// Run actual quantity helpers, outbox and App handlers with synthetic state.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const crypto = require('node:crypto').webcrypto;
const ROOT = path.resolve(__dirname, '../..');
const ts = require(path.join(ROOT, 'frontend/node_modules/typescript'));
function moduleFile(file) {
  const exports = {};
  new Function('exports', ts.transpileModule(fs.readFileSync(path.join(ROOT, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports);
  return exports;
}
const helpers = moduleFile('frontend/state/quantityWorkflow.ts');
const documents = moduleFile('frontend/state/challanDocuments.ts');
const { MovementOutbox, RejectedMovement } = moduleFile('frontend/state/movementOutbox.ts');
const app = fs.readFileSync(path.join(ROOT, 'frontend/App.tsx'), 'utf8');
const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function appFunction(name, scope) {
  const nodes = []; function walk(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) nodes.push(node); ts.forEachChild(node, walk); } walk(ast);
  assert.equal(nodes.length, 1);
  const code = ts.transpileModule(`return (${nodes[0].initializer.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), code)(...Object.values(scope));
}
const checks = []; async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const bulk = { id: '1', sku: 'BULK', type: 'Cable', quantity: 10, quantity_tracking: true, quantity_available: 4 };
  const form = { id: '1', revision: 3, staged_assets: ['1', '2'], quantity_allocations: { '1': { reserved: 6, dispatched: 2, awaiting_verification: 1, dispatched_total: 2 } } };
  await check('Stable bulk mode and action limits retain zero and partial quantities', () => {
    assert(helpers.isBulkStock({ ...bulk, quantity: 1 }));
    for (const [action, amount] of [['stage', 4], ['unstage', 6], ['return', 2], ['verify_return', 1]]) assert.equal(helpers.quantityLimit(bulk, form, action), amount);
    assert.equal(helpers.quantityLimit({ ...bulk, quantity_available: 0 }, form, 'stage'), 0);
  });
  await check('Mixed dispatch sends recorded event quantity and physical IDs together', () => {
    assert.deepEqual(helpers.dispatchQuantities(form, [bulk, { id: '2', quantity: 1 }]), { action: 'dispatch', expected_revision: 3, items: [{ asset_id: 1, quantity: 6 }], physical_asset_ids: [2] });
    assert.throws(() => helpers.dispatchQuantities({ ...form, quantity_allocations: {} }, [bulk, { id: '2', quantity: 1 }]));
  });
  await check('New master challan uses event dispatch quantity rather than total warehouse stock', () => {
    const rows = documents.legacyDocumentAssets([bulk], [], form, 'master');
    assert.equal(rows[0].quantity, 8); assert.equal(bulk.quantity, 10);
  });
  await check('A lost quantity response retains the exact UUID across outbox reopening', async () => {
    const cache = new Map(); const storage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
    const calls = []; let lost = true; const send = async operation => { calls.push(JSON.parse(JSON.stringify(operation))); if (lost) throw Error('response lost'); return { status: 'saved' }; };
    const queue = new MovementOutbox('test', storage, send, () => {});
    global.crypto = crypto;
    await assert.rejects(queue.enqueueQuantity('1', { action: 'stage', expected_revision: 3, items: [{ asset_id: 1, quantity: 4 }] }));
    const first = queue.pending()[0]; assert.equal(first.endpoint, '/api/conferences/1/quantity-commands/');
    lost = false; await new MovementOutbox('test', storage, send, () => {}).flush();
    assert.deepEqual(calls[0], calls[1]); assert.equal(queue.pending().length, 0);
  });
  await check('Storage failure stops quantity HTTP before sending', async () => {
    let calls = 0; const queue = new MovementOutbox('broken', { getItem: () => null, setItem: () => { throw Error('full'); } }, async () => { calls++; }, () => {});
    await assert.rejects(queue.enqueueQuantity('1', { action: 'stage', items: [] })); assert.equal(calls, 0);
  });
  await check('Actual App bulk modal submits one command and closes only after acknowledgement', async () => {
    const calls = []; let closed = false;
    const scope = { quantityAsset: bulk, conferenceFormData: form, selectedQuantity: 3, quantityAction: 'stage', AssetCategory: { CONSUMABLES: 'Consumables' }, ...helpers,
      showScanToast() {}, setShowQuantityModal(value) { closed = !value; }, submitQuantityCommand: async payload => { calls.push(payload); return false; } };
    await appFunction('submitQuantityAssignment', scope)(); assert.equal(closed, false); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { action: 'stage', expected_revision: 3, items: [{ asset_id: 1, quantity: 3 }] });
    scope.submitQuantityCommand = async () => true; await appFunction('submitQuantityAssignment', scope)(); assert.equal(closed, true);
  });
  await check('Actual App suppresses duplicate quantity clicks and pending uncertain commands', async () => {
    let sends = 0, release; const flight = new Promise(resolve => { release = resolve; }); let pending = [];
    const scope = { quantityFlightRef: { current: false }, conferenceFormData: form, showScanToast() {}, setQuantitySaving() {}, setPendingMovementCount() {},
      getMovementOutbox: () => ({ pending: () => pending, enqueueQuantity: async () => { sends++; await flight; } }) };
    const submit = appFunction('submitQuantityCommand', scope); const first = submit({});
    assert.equal(await submit({}), false); release(); assert.equal(await first, true); assert.equal(sends, 1);
    pending = [{}]; assert.equal(await submit({}), false); assert.equal(sends, 1);
  });
  await check('Actual App shows a corrupt queue error without sending a new quantity request', async () => {
    let toast = '';
    const submit = appFunction('submitQuantityCommand', { quantityFlightRef: { current: false }, conferenceFormData: form,
      showScanToast: message => { toast = message; }, getMovementOutbox: () => { throw Error('corrupt queue'); } });
    assert.equal(await submit({}), false); assert.match(toast, /corrupt queue/);
  });
  console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Actual TypeScript modules and App functions; synthetic state and transports' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
