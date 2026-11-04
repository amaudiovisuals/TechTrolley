const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..'), ts = require(path.join(root, 'frontend/node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'frontend/state/programDeliveryDrafts.ts'), 'utf8');
const helpers = {};
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(helpers);
const { deliveryPendingKey, readPendingDelivery, savePendingDelivery, clearPendingDelivery } = helpers;
const cache = new Map(), storage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) };
const request = { request_key: '12345678-1234-1234-1234-123456789abc', source_hash: 'a'.repeat(64), truck_id: null,
  reference: 'Synthetic delivery', delivery_date: '2026-11-04', vehicle_number: 'TEST', driver_phone: '', rows: [{ key: 'asset:1', name: 'Synthetic cable', quantity: 6 }] };
const key = deliveryPendingKey('https://preview.example.test', 'actor-1', 'program-1');
const checks = []; const check = (name, run) => { run(); checks.push(name); };
check('An uncertain delivery reopens with its exact UUID and payload', () => {
  savePendingDelivery(storage, key, request); assert.deepEqual(readPendingDelivery(storage, key), request);
  savePendingDelivery(storage, key, structuredClone(request)); assert.equal(cache.size, 1);
});
check('Actor, origin, program and truck separate recovery records', () => {
  const scopes = [deliveryPendingKey('https://other.example.test', 'actor-1', 'program-1'), deliveryPendingKey('https://preview.example.test', 'actor-2', 'program-1'),
    deliveryPendingKey('https://preview.example.test', 'actor-1', 'program-2'), deliveryPendingKey('https://preview.example.test', 'actor-1', 'program-1', 2)];
  for (const scope of scopes) { assert.notEqual(scope, key); assert.equal(readPendingDelivery(storage, scope), null); }
  assert.throws(() => deliveryPendingKey('https://preview.example.test', '', '1'));
});
check('A second request cannot overwrite or clear uncertain saved work', () => {
  assert.throws(() => savePendingDelivery(storage, key, { ...request, request_key: '12345678-1234-1234-1234-123456789abd' }));
  assert.throws(() => clearPendingDelivery(storage, key, 'another-key'));
  assert.deepEqual(readPendingDelivery(storage, key), request);
});
check('Malformed, cross-scope and invalid quantity recovery data fails closed', () => {
  for (const raw of ['{', JSON.stringify({ schema: 1, scope: 'other', request }), JSON.stringify({ schema: 1, scope: key, request: { ...request, rows: [{ ...request.rows[0], quantity: 0 }] } })]) {
    storage.setItem('corrupt', raw); assert.throws(() => readPendingDelivery(storage, 'corrupt'));
  }
  assert.throws(() => savePendingDelivery(storage, 'new', { ...request, rows: [] }));
});
check('Unavailable, quota-limited or silently discarded storage cannot permit a send', () => {
  assert.throws(() => readPendingDelivery({ getItem() { throw Error('denied'); } }, key));
  assert.throws(() => savePendingDelivery({ getItem: () => null, setItem() { throw Error('quota'); } }, key, request));
  assert.throws(() => savePendingDelivery({ getItem: () => null, setItem() {} }, key, request));
});
check('Confirmed recovery removes only its matching request', () => {
  clearPendingDelivery(storage, key, request.request_key); assert.equal(readPendingDelivery(storage, key), null);
});
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
