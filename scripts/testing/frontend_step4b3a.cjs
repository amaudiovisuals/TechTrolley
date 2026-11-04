// Exercise actual document helpers and App loading guards with synthetic transports.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '../..'), ts = require(path.join(ROOT, 'frontend/node_modules/typescript'));
const exportsModule = {};
new Function('exports', ts.transpileModule(fs.readFileSync(path.join(ROOT, 'frontend/state/challanDocuments.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exportsModule);
const helpers = exportsModule;
const app = fs.readFileSync(path.join(ROOT, 'frontend/App.tsx'), 'utf8'), ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function appFunction(name, scope) {
  let node; function visit(n) { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === name) { assert(!node); node = n; } ts.forEachChild(n, visit); } visit(ast); assert(node);
  return new Function(...Object.keys(scope), ts.transpileModule(`return (${node.initializer.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(scope));
}
const checks = []; async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const bulk = { id: '1', type: 'Cable', sku: 'BULK', quantity: 100, itemPrice: 25 };
  const consume = { id: 2, type: 'Consumables', sku: 'TAPE', alias_name: 'Event tape', quantity: 5, item_price: '10.00', current_value: '10.00' };
  const booking = { id: '12', revision: 4, assets: ['1'], challanAssets: ['1'], quantity_allocations: { '1': { dispatched_total: 6, dispatched: 4, reserved: 0 } },
    consumable_ledger: { '2': { ledger: true, requested: 8, returned: 3, status: 'settled' } }, consumable_assets_details: [consume] };
  await check('Scope and line identity are separate: event-prefixed UUID seed retains master quantities', () => {
    const rows = helpers.legacyDocumentAssets([bulk], [], booking, 'master', '12:master');
    assert.deepEqual(rows.map(row => row.quantity), [6, 8]);
    const other = helpers.legacyDocumentAssets([bulk], [], { ...booking, id: '13' }, 'master', '13:master');
    assert.notEqual(rows[0].id, other[0].id);
    const truck = helpers.legacyDocumentAssets([{ ...bulk, quantity: 2 }], [], { ...booking,
      challan_assets_details: [{ id: 1, quantity: 100, sku: 'BULK' }] }, 'truck-4', '12:truck-4');
    assert.equal(truck[0].quantity, 2);
    assert.match(helpers.documentSourceWarnings([{ ...bulk, type: 'Consumables' }], { id: '12' }, 'truck-4')[0].message, /coordinated manifest review/);
  });
  await check('Embedded consumables initialize even with no inventory pool or physical membership', () => {
    const rows = helpers.legacyDocumentAssets([], [], booking, 'master', '12:master');
    assert.equal(rows.length, 1); assert.equal(rows[0].quantity, 8); assert.equal(rows[0].aliasName, 'Event tape');
    assert.equal(consume.quantity, 5);
    const embedded = { ...booking, quantity_assets_details: [{ id: 1, type: 'Cable', sku: 'BULK', alias_name: 'Bulk cable', quantity: 100, item_price: 25 }] };
    assert.deepEqual(helpers.legacyDocumentAssets([], [], embedded, 'master', '12:master').map(row => row.quantity), [6, 8]);
    assert.deepEqual(helpers.documentSourceWarnings([], embedded, 'master'), []);
  });
  await check('Return preview uses current bulk balance and counted consumable returns, retaining zero', () => {
    const returned = helpers.masterQuantityPreview(booking, [bulk], 'return');
    assert.deepEqual(returned.map(row => row.quantity), [4, 3]);
    assert.equal(helpers.masterQuantityPreview({ ...booking, consumable_ledger: { '2': { ledger: true, requested: 8, returned: 0, status: 'settled' } } }, [bulk], 'return').length, 1);
    assert(helpers.hasRecordedQuantities(booking));
  });
  await check('Unknown/legacy returns are not assumed and missing source details warn', () => {
    const unknown = { ...booking, consumable_ledger: { '2': { ledger: true, requested: 8, returned: null, status: 'dispatched' } } };
    assert.equal(helpers.masterQuantityPreview(unknown, [bulk], 'return').length, 1);
    assert(helpers.documentSourceWarnings([bulk], unknown, 'master', 'return').some(warning => /not been entered/.test(warning.message)));
    assert(helpers.documentSourceWarnings([bulk], { ...booking, consumable_assets_details: [] }, 'master').some(warning => /missing/.test(warning.message)));
    const old = { id: '12', consumable_data: { '2': { requested: 8 } } };
    assert.equal(helpers.legacyDocumentAssets([{ ...bulk, id: '2', type: 'Consumables' }], [], old, 'master').length, 0);
    assert.match(helpers.documentSourceWarnings([], old, 'master')[0].message, /legacy/);
    assert.match(helpers.documentSourceWarnings([], { consumable_data: ['ambiguous'] }, 'master')[0].message, /invalid legacy format/);
    assert.equal(helpers.legacyDocumentAssets([bulk], [], { id: '12' }, 'master', '12:master', 'return').length, 0);
    assert.match(helpers.documentSourceWarnings([bulk], { id: '12' }, 'master', 'return')[0].message, /no recorded return balance/);
  });
  await check('Rental ticket sources appear once and are excluded from inferred return quantities', () => {
    const tickets = [{ company: 4, company_name: 'AM', items: [{ id: 5, asset: 2, quantity: 3, rental_price: '12.50' }] }];
    const rows = helpers.legacyDocumentAssets([{ id: '2', quantity: 50, type: 'Consumables' }], tickets, booking, 'master', '12:master');
    assert.equal(rows.length, 1); assert.equal(rows[0].quantity, 3); assert.equal(rows[0].challanLine.ticket_item_id, 5);
    assert.equal(helpers.legacyDocumentAssets([], tickets, { id: '12' }, 'master', '12:master', 'return').length, 0);
  });
  await check('Actual source loader ignores out-of-order responses and account changes, and keeps failures visible', async () => {
    const pending = [], states = [], rows = []; let token = 'A';
    const scope = { confTicketRequestRef: { current: 0 }, user: { user_id: 1 }, localStorage: { getItem: () => token },
      setConfTicketSourceState: state => states.push(state), setConfSubrentalTickets: data => rows.push(data),
      mapTicketData: value => value, showScanToast() {}, API_BASE: '', apiFetch: () => new Promise(resolve => pending.push(resolve)) };
    const load = appFunction('fetchConferenceSubrentalTickets', scope);
    load('1'); load('2'); pending[1]({ ok: true, json: async () => [{ id: 2 }] }); await new Promise(done => setImmediate(done));
    pending[0]({ ok: true, json: async () => [{ id: 1 }] }); await new Promise(done => setImmediate(done)); assert.deepEqual(rows, [[{ id: 2 }]]);
    load('3'); token = 'B'; pending[2]({ ok: true, json: async () => [{ id: 3 }] }); await new Promise(done => setImmediate(done)); assert.equal(rows.length, 1);
    load('4'); pending[3]({ ok: false, status: 500 }); await new Promise(done => setImmediate(done)); assert.equal(states.at(-1).status, 'error'); assert.equal(rows.length, 1);
  });
  await check('Saved documents bypass source loading; new masters require the correct account/event response', () => {
    const scope = { user: { user_id: 1 }, confTicketSourceState: { status: 'ready', eventId: '2', accountId: '1' } };
    const ready = appFunction('challanSourcesReady', scope); assert.equal(ready({ id: '1' }), false); assert.equal(ready({ id: '2' }), true);
    assert.equal(ready({ id: '1', challan_documents: [{ scope: 'master' }] }), true);
    scope.confTicketSourceState.status = 'error'; assert.equal(ready({ id: '2' }), false);
  });
  console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Actual TypeScript document helpers and App loaders; synthetic transports/state' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
