import React, {useEffect, useState} from 'react';
import {SupplierCommand} from '../state/supplierSaves';
import {setWorkBlocker} from '../state/workSafety';
import type {SubrentalTicket} from '../types';

export default function SupplierBalancePanel({ticket,account,role,save,busy,pending}:{
  key?:string;ticket:SubrentalTicket;account:string;role:string;save:(payload:SupplierCommand)=>Promise<void>;busy:boolean;pending:boolean;
}){
  const [selected,setSelected]=useState(''),[action,setAction]=useState('supplier_receive');
  const [quantity,setQuantity]=useState(''),[received,setReceived]=useState(''),[returned,setReturned]=useState(''),[cancelled,setCancelled]=useState('');
  const [reason,setReason]=useState(''),[evidence,setEvidence]=useState(''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
  const dirty=Boolean(selected||quantity||reason||evidence||received||returned||cancelled||confirmed);
  useEffect(()=>{const key=`supplier-balance-editor:${account}:${ticket.id}`;setWorkBlocker(key,dirty);return()=>setWorkBlocker(key,false);},[account,ticket.id,dirty]);
  const reset=()=>{setSelected('');setQuantity('');setReceived('');setReturned('');setCancelled('');setReason('');setEvidence('');setConfirmed(false);setError('');};
  const item=ticket.items?.find(row=>String(row.id)===selected),balance=item?.supplier_balance;
  const opening=balance?.state==='opening_review_required';
  const canWrite=['admin','boss','godown_incharge'].includes(role),canReview=['admin','boss'].includes(role);
  const submit=async()=>{
    setError('');
    try{
      if(!item||!balance||balance.state==='inconsistent')throw Error('Select an item with current rental counts.');
      if(!confirmed||!reason.trim()||!evidence.trim())throw Error('Confirm the counts and enter a reason and delivery/return evidence reference.');
      const count=(text:string)=>{if(!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text)))throw Error('Enter whole quantities; zero is allowed only for an opening review.');return Number(text);};
      const data={ticket_id:Number(ticket.id),item_id:Number(item.id),expected_balance_revision:opening?null:balance.revision??null,evidence_reference:evidence,confirmed:true,
        ...(opening?{received:count(received),returned:count(returned),cancelled:count(cancelled)}:{quantity:count(quantity)})};
      await save({request_id:crypto.randomUUID(),action:opening?'review_supplier_opening':action as SupplierCommand['action'],conference_id:Number(ticket.conference),expected_revision:ticket.conference_revision??null,reason,data});
      reset();
    }catch(e){setError(e instanceof Error?e.message:'Rental movement could not be confirmed.');}
  };
  return <section aria-label="Supplier receipts and returns" className="rounded-2xl border border-slate-700 bg-slate-900 p-5 text-white space-y-3">
    <h3 className="text-lg font-bold">Supplier receipts and returns</h3>
    <p className="text-sm text-slate-300">Order quantities, receipts and returns are separate. Cancel only units that have not arrived. These counts do not change warehouse inventory.</p>
    <div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Item</th><th>Ordered</th><th>Received</th><th>Returned</th><th>Cancelled</th><th>Awaiting arrival</th><th>With us</th></tr></thead><tbody>{ticket.items?.map(row=>{
      const b=row.supplier_balance;return <tr key={row.id}><td>{row.asset_details?.aliasName||row.asset_details?.alias_name||row.asset_details?.sku||row.id}</td><td>{row.quantity}</td>{b?.state==='recorded'?<><td>{b.received}</td><td>{b.returned}</td><td>{b.cancelled}</td><td>{b.pending_receipt}</td><td>{b.with_us}</td></>:<td colSpan={5}>{b?.state==='inconsistent'?'Counts need investigation':'Legacy opening needs administrator review'}</td>}</tr>;
    })}</tbody></table></div>
    {canWrite&&<fieldset disabled={busy||pending} className="space-y-3">
      <label className="block">Rental item<select aria-label="Rental movement item" value={selected} onChange={e=>{setSelected(e.target.value);setConfirmed(false);}} className="block bg-slate-800 p-2"><option value="">Select item</option>{ticket.items?.map(row=><option key={row.id} value={row.id}>{row.asset_details?.aliasName||row.asset_details?.alias_name||row.asset_details?.sku||row.id}</option>)}</select></label>
      {opening?<><p>Original receipt/return dates are unknown. Review the opening counts using actual supplier records; this does not backdate a movement.</p>{canReview?<div className="flex flex-wrap gap-3"><label>Total received<input aria-label="Opening received" value={received} onChange={e=>{setReceived(e.target.value);setConfirmed(false);}} inputMode="numeric" className="block bg-slate-800 p-2"/></label><label>Total returned<input aria-label="Opening returned" value={returned} onChange={e=>{setReturned(e.target.value);setConfirmed(false);}} inputMode="numeric" className="block bg-slate-800 p-2"/></label><label>Unreceived units cancelled<input aria-label="Opening cancelled" value={cancelled} onChange={e=>{setCancelled(e.target.value);setConfirmed(false);}} inputMode="numeric" className="block bg-slate-800 p-2"/></label></div>:<p>An administrator must review this legacy opening.</p>}</>:<><label className="block">Movement<select aria-label="Rental movement action" value={action} onChange={e=>{setAction(e.target.value);setConfirmed(false);}} className="block bg-slate-800 p-2"><option value="supplier_receive">Received from supplier</option><option value="supplier_return">Returned to supplier</option><option value="supplier_cancel">Cancel unreceived quantity</option></select></label><label className="block">Quantity<input aria-label="Rental movement quantity" inputMode="numeric" value={quantity} onChange={e=>{setQuantity(e.target.value);setConfirmed(false);}} className="block bg-slate-800 p-2"/></label></>}
      <label className="block">Reason<textarea aria-label="Rental movement reason" value={reason} onChange={e=>{setReason(e.target.value);setConfirmed(false);}} maxLength={1000} className="block w-full bg-slate-800 p-2"/></label>
      <label className="block">Delivery/return evidence reference<input aria-label="Rental movement evidence" value={evidence} onChange={e=>{setEvidence(e.target.value);setConfirmed(false);}} maxLength={1000} className="block w-full bg-slate-800 p-2"/></label>
      <label className="block"><input type="checkbox" aria-label="Confirm rental movement counts" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I checked these quantities and the supplier's delivery, return or cancellation evidence.</label>
      <button type="button" disabled={!selected||!confirmed||opening&&!canReview||balance?.state==='inconsistent'} onClick={submit} className="rounded bg-sky-600 px-4 py-2">{opening?'Record reviewed opening':'Record rental movement'}</button>
      <button type="button" onClick={reset} className="ml-3 underline">Clear rental form</button>
    </fieldset>}
    {pending&&<p>A supplier operation needs confirmation. Use the recovery notice before another movement.</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
