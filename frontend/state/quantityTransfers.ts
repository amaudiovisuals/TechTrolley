import type {Asset} from '../types';
import {isBulkStock} from './quantityWorkflow';

export function transferSelection(ids: string[], quantities: Record<string,number>, pool: Asset[], form: any) {
  const items:{asset_id:number;quantity:number}[]=[],physical_asset_ids:number[]=[];
  let total=0;
  for (const id of ids) {
    const asset=pool.find(row=>String(row.id)===String(id));
    if (!asset || asset.type==='Consumables' || asset.stock_kind==='led_case' || !(form.assets||[]).map(String).includes(String(id))) throw Error('Reopen the program and select only equipment currently on site.');
    if (isBulkStock(asset)) {
      const maximum=Number(form.quantity_allocations?.[id]?.dispatched||0),amount=quantities[id]??maximum;
      if (!Number.isInteger(amount) || amount<1 || amount>maximum) throw Error(`Choose between 1 and ${maximum} on-site units for ${asset.sku}.`);
      items.push({asset_id:Number(id),quantity:amount});total+=amount;
    } else {physical_asset_ids.push(Number(id));total++;}
  }
  if (!total) throw Error('Select equipment to transfer.');
  return {items,physical_asset_ids,total};
}
