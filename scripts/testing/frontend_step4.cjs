// Execute actual document conversions, editor save and App transport with synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const ts = require(path.join(ROOT, 'frontend/node_modules/typescript'));
const crypto = require('node:crypto').webcrypto;
function moduleSource(file) {
  const exports = {};
  new Function('exports', 'require', ts.transpileModule(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText)(exports, ref => moduleSource(`frontend/state/${path.basename(ref)}.ts`));
  return exports;
}
const helpers = moduleSource('frontend/state/challanDocuments.ts');
const ownerHelpers = moduleSource('frontend/state/ownerSections.ts');
function sourceFunction(file, name, scope) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const tree = ts.createSourceFile(file, s, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes = [];
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) nodes.push(node); ts.forEachChild(node, visit); }
  visit(tree); assert.equal(nodes.length, 1);
  const code = ts.transpileModule(`return (${nodes[0].initializer.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), code)(...Object.values(scope));
}
const checks = [];
async function check(name, callback) { await callback(); checks.push(name); }
function editor(overrides = {}) {
  const cache = new Map(); const state = { edit: true, dirty: true, uncertain: false, toasts: [], calls: [] };
  const scope = { crypto, ...helpers, ...ownerHelpers, document: null, requiresCorrectionReason: false, sourcesReady: true, sourceWarnings: [], correctionReason: '', documentDate: '2026-10-08',
    draftConflict: false, isSavingRef: { current: false }, baseRevisionRef: { current: 5 }, baseDocumentRef: { current: null },
    draftKey: 'isolated-draft', pendingKey: 'isolated-draft:save', editorKeyRef: { current: 'isolated-draft' },
    dirtyRef: { current: true }, scope: 'master', booking: { id: '101' }, liveBooking: { revision: 5 },
    localAssets: [{ id: `new-${crypto.randomUUID()}`, aliasName: 'Manual two', quantity: 2, itemPrice: 12.5 }],
    challanNoOverride: 'TEST-1', totalValueOverride: 0,
    localStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    setIsSaving() {}, setSaveUncertain: value => { state.uncertain = value; },
    setLocalAssets: value => { state.rows = value; }, setChallanNoOverride() {}, setTotalValueOverride() {},
    setDirty: value => { state.dirty = value; }, setDraftConflict() {}, setIsEditMode: value => { state.edit = value; }, setCorrectionReason() {},
    removeDraft: (storage, key) => storage.removeItem(key), showScanToast: (...args) => state.toasts.push(args),
    onSaveDocument: async (scope, payload) => { state.calls.push(payload); return { id: 'document-1', ...payload, revision: 1, number: payload.number, header: {} }; },
    ...overrides,
  };
  return { state, scope, cache, save: sourceFunction('frontend/components/ChallanView.tsx', 'saveAllChanges', scope) };
}
(async () => {
  await check('Manual source has durable UUID without inventory or supplier reference', () => {
    const a = { id: `new-${crypto.randomUUID()}`, aliasName: 'Manual', quantity: 2, itemPrice: 12.5 };
    const line = helpers.assetLine(a, '101:master', 0);
    assert.equal(line.source_kind, 'manual'); assert.equal(line.asset_id, null); assert.equal(line.unit_value, '12.50');
    assert.equal(helpers.assetLine(a, '101:master', 0).id, line.id);
  });
  await check('Legacy browser manual IDs migrate deterministically and source IDs are isolated per document', () => {
    const a = { id: 'new-old-browser-123', aliasName: 'Manual', quantity: 1, itemPrice: 0 };
    const one = helpers.assetLine(a, '101:master', 0); const two = helpers.assetLine(a, '101:master', 0);
    assert.equal(one.id, two.id); assert.match(one.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(helpers.assetLine({ ...a, id: '4' }, '101:master', 0).id, helpers.assetLine({ ...a, id: '4' }, '101:truck-2', 0).id);
  });
  await check('Conflicting warehouse and ticket sources stay visible for overlap review', () => {
    const rows = helpers.legacyDocumentAssets([{ id: '4', aliasName: 'Cable', quantity: 100, itemPrice: 900 }], [{ company: 8, company_name: 'AM', items: [{ id: 9, asset: 4, quantity: 10, rental_price: 12.5 }] }], { id: '101' }, '101:master');
    assert.equal(rows.length, 2); assert.equal(rows[0].quantity, 100);
    assert.equal(rows[1].quantity, 10); assert.equal(rows[1].itemPrice, 12.5);
    assert.equal(rows[1].challanLine.ticket_item_id, 9);
  });
  await check('Saved unit value and header do not recalculate with stock ownership or dates', () => {
    const line = { id: crypto.randomUUID(), source_kind: 'owned', asset_id: 4, supplier_id: null, ticket_item_id: null,
      snapshot: { alias_name: 'Original' }, quantity: 10, unit_value: '12.50' };
    const row = helpers.lineAsset(line);
    assert.equal(helpers.documentUnitValue({ ...row, purchasedDate: '2000-01-01', depreciationPercentage: 99 }), 12.5);
    assert.equal(helpers.snapshotBooking({ conferenceName: 'New', billingAddress: 'New' }, { header: { name: 'Old', billing_address: 'Old' }, number: 'N', document_date: null, total_override: '0.00' }).billingAddress, 'Old');
  });
  await check('A complete save sends one request for all lines and preserves zero total', async () => {
    const e = editor(); await e.save();
    assert.equal(e.state.calls.length, 1); assert.equal(e.state.calls[0].total_override, 0);
    assert.equal(e.state.calls[0].expected_revision, 0); assert.equal(e.state.calls[0].expected_event_revision, 5);
    assert.equal(e.state.edit, false); assert.equal(e.state.dirty, false); assert.equal(e.cache.size, 0);
  });
  await check('Definitive rejection leaves edits open and removes only the failed retry command', async () => {
    const e = editor({ onSaveDocument: async () => { throw Object.assign(Error('Conflict'), { definitive: true }); } });
    e.cache.set('isolated-draft', 'preserved'); await e.save();
    assert.equal(e.state.edit, true); assert.equal(e.state.dirty, true); assert.equal(e.state.uncertain, false);
    assert.equal(e.cache.get('isolated-draft'), 'preserved'); assert.equal(e.cache.has('isolated-draft:save'), false);
  });
  await check('Lost response keeps exact command and retry ignores later draft changes', async () => {
    let first, calls = 0;
    const e = editor({ onSaveDocument: async (_scope, payload) => {
      calls++; if (calls === 1) { first = payload; throw Error('Connection lost after commit'); }
      assert.deepEqual(payload, first); return { ...payload, id: 'document-1', number: payload.number, revision: 1, header: {} };
    } });
    await e.save(); assert.equal(e.state.uncertain, true);
    e.scope.localAssets[0].quantity = 99;
    await e.save(); assert.equal(calls, 2); assert.equal(e.state.rows[0].quantity, 2); assert.equal(e.cache.size, 0);
  });
  await check('Duplicate clicks cannot send a second save while awaiting acknowledgement', async () => {
    let release, calls = 0;
    const e = editor({ onSaveDocument: (_scope, payload) => { calls++; return new Promise(resolve => { release = () => resolve({ ...payload, id: 'doc', number: payload.number, revision: 1, header: {} }); }); } });
    const pending = e.save(); await e.save(); assert.equal(calls, 1); release(); await pending;
  });
  await check('Account change cannot publish a save into another editor', async () => {
    let release;
    const e = editor({ onSaveDocument: (_scope, payload) => new Promise(resolve => { release = () => resolve({ ...payload, id: 'doc', number: payload.number, revision: 1, header: {} }); }) });
    const pending = e.save(); e.scope.editorKeyRef.current = 'other-account-draft'; release(); await pending;
    assert.equal(e.state.rows, undefined); assert.equal(e.cache.has('isolated-draft:save'), true);
  });
  await check('App document HTTP rejection is propagated before canonical state publication', async () => {
    let publications = 0;
    const f = sourceFunction('frontend/App.tsx', 'handleSaveChallanDocument', { API_BASE: 'https://synthetic.invalid', localStorage: { getItem: () => 'token' },
      conferenceSnapshotsRef: { current: new Map() },
      apiFetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'document_changed' }) }), applyMovementReceipt: () => publications++ });
    await assert.rejects(f('101', 'master', {}), error => error.definitive && error.message === 'document_changed');
    assert.equal(publications, 0);
  });
  console.log(JSON.stringify({ checks: checks.length, names: checks, environment: 'Synthetic state/transports; actual TypeScript functions' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
