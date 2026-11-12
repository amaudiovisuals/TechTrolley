const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '../..'), ts = require(path.join(ROOT, 'frontend/node_modules/typescript'));
global.crypto = require('node:crypto').webcrypto;
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(ROOT, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'require', code)(exports, name => load(path.join(path.dirname(file), name + '.ts')));
  return exports;
}
const helpers = load('frontend/state/consumableWorkflow.ts'), drafts = load('frontend/state/eventDrafts.ts');
const { mapConference } = load('frontend/state/conferences.ts'), { acceptRevision } = load('frontend/state/challanDrafts.ts');
const { MovementOutbox } = load('frontend/state/movementOutbox.ts');
const source = fs.readFileSync(path.join(ROOT, 'frontend/App.tsx'), 'utf8'), ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function appFunction(name, scope) {
  let node; function visit(n) { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === name) { assert(!node); node = n; } ts.forEachChild(n, visit); } visit(ast); assert(node);
  const code = ts.transpileModule(`return (${node.initializer.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), code)(...Object.values(scope));
}
const checks = []; async function check(name, run) { await run(); checks.push(name); }
(async () => {
  const canonical = mapConference({ id: 1, revision: 2, name: 'Synthetic event', assets: [], consumable_data: {} });
  const form = drafts.eventEditorData(canonical);
  const request = helpers.editConsumableRequest({}, '7', 6);
  await check('Requested consumables start with no presumed return and confirmations reset on edits', () => {
    assert.equal(request['7'].returned, null); assert.equal(request['7'].return_confirmed, false);
    assert.throws(() => helpers.editConsumableRequest({ '7': { status: 'settled', requested: 6 } }, '7', 1));
    const returned = helpers.editConsumableReturn({ '7': { requested: 6, ledger: true, status: 'dispatched', return_confirmed: true } }, '7', 0);
    assert.equal(returned['7'].returned, 0); assert.equal(returned['7'].return_confirmed, false);
  });
  await check('Availability retains zero and adds only the event own reservation', () => {
    assert.equal(helpers.consumableLimit({ quantity: 10, quantity_available: 0 }, { status: 'requested', requested: 6 }), 6);
    assert.equal(helpers.consumableLimit({ quantity: 10, quantity_available: 0 }, { status: 'dispatched', requested: 6 }), 0);
  });
  await check('Settlement requires an entered and explicitly confirmed zero return', async () => {
    const value = { ...form, consumable_data: { '7': { requested: 6, returned: null, status: 'dispatched', ledger: true } } };
    await assert.rejects(helpers.consumablePayload('settle', value, canonical, 'admin'));
    value.consumable_data['7'].returned = 0; await assert.rejects(helpers.consumablePayload('settle', value, canonical, 'admin'));
    value.consumable_data['7'].return_confirmed = true;
    const payload = await helpers.consumablePayload('settle', value, canonical, 'admin');
    assert.equal(payload.items[0].returned, 0); assert.equal(payload.items[0].confirmed, true); assert.match(payload.client_draft_hash, /^[a-f0-9]{64}$/);
  });
  await check('Unsupported metadata edits and technician metadata cannot be silently discarded', async () => {
    await assert.rejects(helpers.consumablePayload('save', { ...form, is_audit: true }, canonical, 'admin'));
    await assert.rejects(helpers.consumablePayload('save', { ...form, name: 'Changed' }, canonical, 'technician'));
    assert.deepEqual((await helpers.consumablePayload('save', { ...form, consumable_data: request }, canonical, 'technician')).metadata, {});
  });
  await check('Async acknowledgement completes before removing a durable pending command', async () => {
    const store = new Map(); let resolve, acknowledged = false;
    const gate = new Promise(done => { resolve = done; });
    const queue = new MovementOutbox('consume', { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }, async () => ({ operation: 'consumable' }), async () => { await gate; acknowledged = true; });
    const sent = queue.enqueueConsumable('1', { action: 'save', items: [] });
    await new Promise(done => setImmediate(done)); assert.equal(queue.pending().length, 1); assert.equal(acknowledged, false);
    resolve(); await sent; assert.equal(queue.pending().length, 0); assert.equal(acknowledged, true);
  });
  const receipt = { operation: 'consumable', conference: { id: 1, revision: 3, name: 'Synthetic event', consumable_data: request } };
  function publisher(current) {
    const state = { form: current, conflict: false };
    const scope = { ...helpers, ...drafts, mapConference, acceptRevision, conferenceFormDataRef: { current },
      conferenceSnapshotsRef: { current: new Map([['1', canonical]]) }, eventBaseMetadataRef: { current: '' },
      applyMovementReceipt() {}, setConferenceFormData: update => { state.form = update(state.form); }, setEventDraftConflict: value => { state.conflict = value; }, showScanToast() {} };
    return { state, publish: appFunction('publishConsumableReceipt', scope) };
  }
  await check('Actual App publishes canonical consumption after an unchanged draft is acknowledged', async () => {
    const submitted = { ...form, consumable_data: request }; const { state, publish } = publisher(submitted);
    await publish({ ...receipt, client_draft_hash: await helpers.consumableDraftHash(submitted) }, () => {});
    assert.equal(state.form.revision, 3); assert.equal(state.conflict, false); assert.deepEqual(state.form.consumable_data, request);
  });
  await check('Actual App preserves metadata edited while the consumable save was in flight', async () => {
    const submitted = { ...form, consumable_data: request }; const newer = { ...submitted, vehicle_number: 'NEWER-DRAFT' };
    const { state, publish } = publisher(newer);
    await publish({ ...receipt, client_draft_hash: await helpers.consumableDraftHash(submitted) }, () => {});
    assert.equal(state.form.vehicle_number, 'NEWER-DRAFT'); assert.equal(state.conflict, true);
  });
  console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Actual TypeScript modules and App publication; synthetic state/transports' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
