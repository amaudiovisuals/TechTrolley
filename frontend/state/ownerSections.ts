import type { Asset, Booking } from '../types';
import { assetLine, documentUnitValue, lineAsset, masterQuantityPreview } from './challanDocuments';
export interface OwnerSection { key: string; title: string; rows: Asset[]; total: number; }
export function ownerSections(rows: Asset[], mainName='Main company'): OwnerSection[] {
  const groups=new Map<string,OwnerSection>();
  for(const row of rows){
    const line=row.challanLine, supplier=line?.source_kind==='supplier'||!line&&Boolean(row.subrental_company);
    const manual=line?.source_kind==='manual'||!line&&String(row.id).startsWith('new-');
    const name=line?.snapshot.supplier_name||row.subrental_company_name||`Supplier ${line?.supplier_id||row.subrental_company}`;
    const key=supplier?`supplier:${line?.supplier_id||row.subrental_company}:${name}`:manual?'manual':'owned';
    if(!groups.has(key))groups.set(key,{key,title:supplier?`Rented from ${name}`:manual?'Manual additions':`Owned stock — ${mainName}`,rows:[],total:0});
    const group=groups.get(key)!;group.rows.push(row);group.total=Math.round(group.total*100+Math.round(documentUnitValue(row)*100)*Number(row.quantity))/100;
  }
  return [...groups.values()].sort((a,b)=>a.key==='owned'?-1:b.key==='owned'?1:a.key==='manual'?1:b.key==='manual'?-1:0);
}
function sourceKey(row:Asset){const line=row.challanLine;return line?.ticket_item_id?`ticket:${line.ticket_item_id}`:line?.asset_id?`asset:${line.asset_id}`:`manual:${row.id}`;}
export function overlappingSourceIds(rows:Asset[]):number[]{
  const types=new Map<number,Set<string>>();
  for(const row of rows){const line=row.challanLine;if(!line?.asset_id)continue;const set=types.get(line.asset_id)||new Set<string>();set.add(line.ticket_item_id?'ticket':'inventory');types.set(line.asset_id,set);}
  return [...types].filter(([,types])=>types.size>1).map(([id])=>id);
}
export function importChallanSources(existing:Asset[],incoming:Asset[]):Asset[]{
  const keys=new Set(existing.map(sourceKey)), merged=[...existing];
  for(const row of incoming){const key=sourceKey(row);if(!keys.has(key)){merged.push(row);keys.add(key);}}
  if(overlappingSourceIds(merged).length)throw Error('Warehouse scans and supplier ticket rows refer to the same equipment. Review the overlap before importing; your saved and manual rows were kept.');
  return merged;
}
export function challanExportRows(rows:Asset[], mainName='Main company'){
  return ownerSections(rows,mainName).flatMap(section=>section.rows.map(row=>({
    Section:section.title,'Source Kind':row.challanLine?.source_kind||'manual','Owner ID':row.challanLine?.supplier_id??'',
    'Source Asset ID':row.challanLine?.asset_id??'','Ticket Item ID':row.challanLine?.ticket_item_id??'',
    'Line ID':row.challanLine?.id||row.id,'Stored Position':row.challanLine?.position??'',
    SKU:row.sku||'','Alias Name':row.aliasName||row.sku||'','Serial Number':row.serialNumber||'',
    Quantity:row.quantity,'Unit Value':documentUnitValue(row),'Line Total':Math.round(documentUnitValue(row)*100)*Number(row.quantity)/100,
  })));
}
export function conferenceDocumentRows(booking:Booking,assets:Asset[],mode:'dispatch'|'return'='dispatch'):Asset[]{
  const document=booking.challan_documents?.find(doc=>doc.scope==='master');
  if(mode==='dispatch'&&document)return document.lines.map(lineAsset);
  const normalized={...booking,challanAssets:booking.challanAssets||(booking as any).challan_assets||[]};
  return masterQuantityPreview(normalized,assets,mode).map(row=>{
    const saved=document?.lines.find(line=>!line.ticket_item_id&&line.asset_id===row.challanLine?.asset_id);
    return saved?lineAsset({...saved,quantity:row.quantity}):row;
  });
}
