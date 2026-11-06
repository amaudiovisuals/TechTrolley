import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SupplierAck, SupplierCommand, SupplierPending, SupplierWorkQueue, supplierScope } from '../state/supplierSaves';
import { setWorkBlocker } from '../state/workSafety';
type Fetch = (url: string, options?: RequestInit) => Promise<Response>;
export function useSupplierSaving(user: any, apiFetch: Fetch, refresh: (ack: Pick<SupplierAck, 'ticket_id' | 'conference_id'>) => Promise<void>) {
  const account = String(user?.user_id || user?.email || ''), queue = useMemo(() => new SupplierWorkQueue(supplierScope(location.origin, account)), [account]);
  const current = useRef(queue); current.current = queue;
  const [pending,setPending] = useState<SupplierPending | null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false); const active = useRef(false);
  const read = useCallback(() => { if (current.current !== queue) return; try { const p = queue.read(); setPending(p); setError(''); setWorkBlocker(queue.key,Boolean(p)); } catch (e) { setPending(null); setError(e instanceof Error ? e.message : 'Supplier save needs review.'); setWorkBlocker(queue.key,true); } },[queue]);
  useEffect(() => { active.current=false;setBusy(false);read();const storage=(e:StorageEvent)=>{if(e.key===queue.key||e.key===null)read();};window.addEventListener('storage',storage);window.addEventListener('techtrolley-supplier-work',read);return()=>{window.removeEventListener('storage',storage);window.removeEventListener('techtrolley-supplier-work',read);setWorkBlocker(queue.key,false);}; },[queue,read]);
  const run = async (action:()=>Promise<void>) => { if(current.current!==queue)throw Error('Account changed before the supplier save.');if(active.current)throw Error('A supplier save is already running.'); active.current=true;setBusy(true);try{await action();}finally{if(current.current===queue){active.current=false;setBusy(false);read();}} };
  const execute = async (id:string, token:string|null) => {
    const check = () => { if(current.current!==queue||localStorage.getItem('token')!==token)throw Error('Account changed during supplier saving. Recover from the original account.'); };
    await queue.execute(id, async(url,options)=>{check();return apiFetch(url,options);},async ack=>{check();await refresh(ack);check();});
  };
  const save = async (payload:SupplierCommand) => run(async()=>{const token=localStorage.getItem('token');const p=await queue.prepare(payload);await execute(p.payload.request_id,token);});
  const recover = async()=>run(async()=>{const p=queue.read();if(p)await execute(p.payload.request_id,localStorage.getItem('token'));});
  const discard = async()=>run(async()=>{
    const token=localStorage.getItem('token'),p=queue.read();if(!p)return;
    const check=()=>{if(current.current!==queue||localStorage.getItem('token')!==token)throw Error('Account changed during supplier review.');};
    if(p.status!=='rejected')throw Error('Recover this uncertain supplier save first.');
    if(p.payload.conference_id!==null){check();const r=await apiFetch(`/api/conferences/${p.payload.conference_id}/`);check();if(!r.ok&&r.status!==404)throw Error('Current event could not load. Keep this rejected attempt for review.');}
    if(p.payload.data.ticket_id){check();const r=await apiFetch(`/api/subrental-tickets/${p.payload.data.ticket_id}/`);check();if(r.ok)await refresh({ticket_id:Number(p.payload.data.ticket_id),conference_id:Number(p.payload.conference_id)});else if(r.status!==404)throw Error('Current ticket could not load. Keep this rejected attempt for review.');}
    check();await queue.discardRejected(p.payload.request_id);
  });
  return {save,recover,discard,pending,busy,error};
}
export default function SupplierSaveNotice({saving}:{saving:ReturnType<typeof useSupplierSaving>}) {
  const [error,setError]=useState('');const run=async(action:()=>Promise<void>)=>{setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'Supplier save remains unresolved.');}};
  if(!saving.pending&&!saving.error)return null;
  return <div role="status" className="fixed bottom-44 right-4 z-[1100] rounded-lg border border-amber-500 bg-slate-900 text-white p-4 max-w-lg"><p>{saving.error||saving.pending?.error||'A supplier save needs exact recovery before another save.'}</p>{(error||saving.busy)&&<p role="alert">{saving.busy?'Checking saved supplier operation…':error}</p>}{saving.pending&&<button disabled={saving.busy||Boolean(saving.error)} onClick={()=>run(saving.pending?.status==='rejected'?saving.discard:saving.recover)} className="mt-2 px-3 py-2 rounded bg-amber-600">{saving.pending.status==='rejected'?'Discard rejected supplier attempt':'Recover saved supplier operation'}</button>}</div>;
}
