const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),ts=require(path.join(root,'frontend/node_modules/typescript'));
function load(file){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,name=>load(path.posix.join(path.posix.dirname(file),name+'.ts')));return exports;}
const {transferSelection}=load('frontend/state/quantityTransfers.ts'),{paperOrigins}=load('frontend/state/dispatchOrigins.ts'),{MovementOutbox}=load('frontend/state/movementOutbox.ts');
const bulk={id:'1',sku:'CABLE',quantity:100,quantity_tracking:true},physical={id:'2',quantity:1},form={assets:['1','2'],quantity_allocations:{'1':{dispatched:20,awaiting_verification:2}}};
(async()=>{
 assert.deepEqual(transferSelection(['1','2'],{'1':8},[bulk,physical],form),{items:[{asset_id:1,quantity:8}],physical_asset_ids:[2],total:9});
 assert.equal(transferSelection(['1'],{},[bulk],form).total,20);
 for(const n of [0,-1,21,1.5,NaN])assert.throws(()=>transferSelection(['1'],{'1':n},[bulk],form));
 for(const asset of [{...bulk,type:'Consumables'},{...bulk,stock_kind:'led_case'}])assert.throws(()=>transferSelection(['1'],{},[asset],form));
 assert.throws(()=>transferSelection(['3'],{},[bulk],form));assert.throws(()=>transferSelection([],{},[bulk],form));
 const origins=[{kind:'warehouse',address:'Godown',asset_ids:[1],asset_quantities:{'1':10}},{kind:'venue',address:'A',asset_ids:[1],asset_quantities:{'1':8}}];
 assert.deepEqual(paperOrigins({dispatchOrigins:origins},[{...bulk,quantity:12}]).map(o=>o.asset_quantities),[{'1':10},{'1':2}]);
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},calls=[];let lost=true;
 global.crypto=require('node:crypto').webcrypto;
 const send=async op=>{calls.push(structuredClone(op));if(lost)throw Error('Reply lost');return {action:'transfer'};};
 const queue=new MovementOutbox('quantity-transfer',storage,send,()=>{});
 await assert.rejects(queue.enqueueQuantityTransfer('7',{expected_revision:3,expected_target_revision:4,target_conference_id:8,items:[{asset_id:1,quantity:8}],physical_asset_ids:[]}));
 assert.equal(queue.pending()[0].endpoint,'/api/conferences/7/quantity-transfers/');
 lost=false;await new MovementOutbox('quantity-transfer',storage,send,()=>{}).flush();assert.deepEqual(calls[0],calls[1]);assert.equal(queue.pending().length,0);
 let sent=false;const broken=new MovementOutbox('broken',{getItem:()=>null,setItem:()=>{throw Error('Storage full');}},async()=>{sent=true;},()=>{});
 await assert.rejects(broken.enqueueQuantityTransfer('7',{}));assert.equal(sent,false);
 console.log(JSON.stringify({passed:18,checks:'Partial and mixed quantities, on-site limits, exclusion rules, FIFO paper quantities, durable exact transfer retry and storage failure'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
