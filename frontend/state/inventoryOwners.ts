export type InventoryMode = 'main_company' | 'shared_warehouse' | 'external_supplier' | 'unreviewed';
export interface InventoryOwnerRow { owner_id:number|null; owner_name:string; inventory_mode:InventoryMode; records:number; available_status_records:number; in_use_status_records:number; crosscheck_status_records:number; restricted_records:number; bulk_records:number; consumable_records:number; }
export interface InventoryOwnerSummary { mode:'inventory_ownership_summary'; rows:InventoryOwnerRow[]; totals:{main_owned:number;shared_supplier_owned:number;shared_warehouse:number;external_supplier_catalog:number;unreviewed_supplier_catalog:number;all_permanent:number}; }
export const inventoryModeLabel=(mode:InventoryMode)=>({main_company:'Main company stock',shared_warehouse:'Shared godown stock',external_supplier:'External supplier catalogue',unreviewed:'Classification pending'})[mode];
export function readOwnerSummary(value:any):InventoryOwnerSummary{
 const fields=['records','available_status_records','in_use_status_records','crosscheck_status_records','restricted_records','bulk_records','consumable_records'];
 if(value?.mode!=='inventory_ownership_summary'||!Array.isArray(value.rows)||!value.rows.length||!value.totals)throw Error('Inventory ownership records could not be verified.');
 const ids=new Set();
 for(const row of value.rows){if(!row||!['main_company','shared_warehouse','external_supplier','unreviewed'].includes(row.inventory_mode)||typeof row.owner_name!=='string'||row.owner_id!==null&&(!Number.isSafeInteger(row.owner_id)||row.owner_id<=0)||ids.has(row.owner_id)||fields.some(k=>!Number.isSafeInteger(row[k])||row[k]<0||k!=='records'&&row[k]>row.records))throw Error('Inventory ownership records could not be verified.');ids.add(row.owner_id);}
 if(value.rows.filter((r:any)=>r.owner_id===null&&r.inventory_mode==='main_company').length!==1||value.rows.some((r:any)=>r.owner_id!==null&&r.inventory_mode==='main_company'||r.owner_id===null&&r.inventory_mode!=='main_company'))throw Error('Inventory ownership identity could not be verified.');
 const sum=(mode:InventoryMode)=>value.rows.filter((r:any)=>r.inventory_mode===mode).reduce((n:number,r:any)=>n+r.records,0);
 const main=sum('main_company'),shared=sum('shared_warehouse'),external=sum('external_supplier'),unreviewed=sum('unreviewed');
 const totals={main_owned:main,shared_supplier_owned:shared,shared_warehouse:main+shared,external_supplier_catalog:external,unreviewed_supplier_catalog:unreviewed,all_permanent:main+shared+external+unreviewed};
 if(Object.entries(totals).some(([key,n])=>value.totals[key]!==n))throw Error('Inventory ownership totals changed or are inconsistent.');
 return value;
}
export function ownershipExportRows(summary:InventoryOwnerSummary){return summary.rows.map(row=>({Owner:row.owner_name,'Owner ID':row.owner_id??'main','Inventory classification':inventoryModeLabel(row.inventory_mode),'Inventory records':row.records,'Stored Available':row.available_status_records,'Stored In Use':row.in_use_status_records,'Stored Crosscheck':row.crosscheck_status_records,'Restricted records':row.restricted_records,'Reusable bulk records':row.bulk_records,'Consumable records':row.consumable_records}));}
