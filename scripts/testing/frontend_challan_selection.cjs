const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),ts=require(path.join(root,'frontend/node_modules/typescript'));
function load(file){const out={};new Function('exports',ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out);return out;}
const {challanAssetIds}=load('frontend/state/challanSelection.ts'),{paperOrigins}=load('frontend/state/dispatchOrigins.ts');
const first={id:'1',truck_number:1,assets:['1','2']},second={id:'2',truck_number:2,assets:['3']};
const booking={assets:['2','4'],challanAssets:['1','2','3','4'],truckChallans:[first,second],dispatchOrigins:[
 {kind:'venue',name:'Venue A',address:'Original A',asset_ids:[1,2]}, {kind:'warehouse',name:'Godown',address:'Godown road',asset_ids:[3,4]}]};
assert.deepEqual(challanAssetIds(booking,'dispatch'),['1','2','3','4']);
assert.deepEqual(challanAssetIds(booking,'return'),['2','4']);
assert.deepEqual(challanAssetIds(booking,'dispatch',first),['1','2','4']);
assert.deepEqual(challanAssetIds(booking,'return',first),['2','4']);
assert.deepEqual(challanAssetIds(booking,'return',second),[]);
assert.deepEqual(paperOrigins(booking,[{id:'manual:1',challanLine:{asset_id:2}}]),[booking.dispatchOrigins[0]]);
assert.deepEqual(paperOrigins(booking,[]),[]);
console.log(JSON.stringify({passed:7,checks:'Historical dispatch, master/truck current return membership, unassigned first-truck equipment and document-line origin filtering'}));
