// Regression checks execute actual TypeScript functions with synthetic state/network.
// No live HTTP calls. These do not substitute for browser/device acceptance testing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const ts = require(path.join(ROOT, 'frontend/node_modules/typescript'));
const files = { app: 'frontend/App.tsx', challan: 'frontend/components/ChallanView.tsx' };
const trees = Object.fromEntries(Object.entries(files).map(([key, file]) => [key,
  ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]));
function find(key, predicate) {
  const matches = [];
  function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
  visit(trees[key]);
  assert.equal(matches.length, 1, `Expected one matching source node in ${files[key]}`);
  return matches[0];
}
function variable(key, name) {
  return find(key, node => ts.isVariableDeclaration(node) && node.name.getText(trees[key]) === name).initializer;
}
function compile(key, node, scope) {
  const quiet = { log() {}, error() {}, warn() {} };
  const bindings = { console: quiet, ...scope };
  const code = ts.transpileModule(`return (${node.getText(trees[key])});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}
const checks = [];
async function check(name, callback) { await callback(); checks.push(name); }
function appScope(extra = {}) {
  const state = { toasts: [], updates: [], requests: [] };
  const scope = {
    API_BASE: 'https://synthetic.invalid',
    selectedBookingForChallan: null, activeTruckChallanId: null,
    apiFetch: async (...args) => { state.requests.push(args); return { ok: true, json: async () => ({ assets: ['1'] }) }; },
    setSelectedBookingForChallan: update => state.updates.push(update),
    showScanToast: (...args) => state.toasts.push(args),
    fetchConferences() {}, fetchAssets() {}, fetchAllAssetsForScan() {}, setTimeout() {},
    ...extra,
  };
  return { state, scope };
}
(async () => {
  await check('Current custody excludes audits, staging and historical challans', () => {
    const map = compile('app', variable('app', 'assetConferenceMap').arguments[0], {
      backendConferences: [
        { isAudit: true, conferenceName: 'Audit', assets: ['1'], crosscheckAssets: ['2'], challanAssets: ['3'], staged_assets: ['4'] },
        { conferenceName: 'Live', assets: ['5'], crosscheckAssets: ['6'], challanAssets: ['7'], staged_assets: ['8'] },
      ],
    })();
    assert.deepEqual([...map], [['5', 'Live'], ['6', 'Live']]);
  });
  for (const helper of ['handleUpdateTruck']) {
    for (const failure of ['rejection', 'network']) {
      await check(`${helper} propagates ${failure} without success`, async () => {
        const { state, scope } = appScope({ apiFetch: async () => {
          if (failure === 'network') throw Error('offline');
          return { ok: false, status: 500 };
        } });
        await assert.rejects(compile('app', variable('app', helper), scope)('1', helper === 'handleUpdateTruck' ? {} : 10));
        assert.equal(state.toasts.some(t => t[1] === 'success'), false);
        assert.equal(state.updates.length, 0);
      });
    }
  }
  await check('ChallanView cannot call a retired inventory or multi-request writer', () => {
    const source = trees.challan.getText();
    for (const name of ['onUpdateAsset', 'onAddAdhocItem', 'onUpdateConferenceValue', 'onUpdateChallanNumber', 'onSaveFullChallan']) {
      assert.equal(source.includes(name), false, `Retired writer ${name} must not be wired into the editor`);
    }
  });
  process.stdout.write(`${checks.length} frontend regression checks passed. Synthetic network/state only.\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
