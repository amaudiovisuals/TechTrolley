import React, { useEffect, useState } from 'react';
import { findSavedWork, copySavedWork, RecoveryIdentity, SavedWork } from '../state/savedWorkRecovery';
import { setWorkBlocker } from '../state/workSafety';

export function SavedWorkRecovery({account,apiFetch,onCopied}:{key?:string;account:string;onCopied?:()=>void;apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}) {
  const [identity,setIdentity]=useState<RecoveryIdentity|null>(null),[rows,setRows]=useState<SavedWork[]>([]);
  const [open,setOpen]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false);
  useEffect(()=>{
    const token=localStorage.getItem('token');let closed=false;
    void (async()=>{
      try { const res=await apiFetch('/api/my-profile/');if(!res.ok)return;const profile=await res.json();
        if(closed||token!==localStorage.getItem('token')||String(profile.user_id)!==account)return;
        const found=await findSavedWork(localStorage,location.origin,profile);if(closed||token!==localStorage.getItem('token'))return;setIdentity(profile);setRows(found);
      }catch { /* Offline startup never guesses the ownership of old email work. */ }
    })();
    return()=>{closed=true;};
  },[account,apiFetch]);
  useEffect(()=>{const key=`saved-work-review:${account}`;setWorkBlocker(key,open);return()=>setWorkBlocker(key,false);},[open,account]);
  const refresh=async()=>{if(identity)setRows(await findSavedWork(localStorage,location.origin,identity));};
  useEffect(()=>{const changed=()=>{void refresh().catch(()=>setError('Browser storage could not be read. Keep this device’s saved work.'));};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[identity]);
  const copy=async(row:SavedWork)=>{
    if(!identity||!confirmed||busy)return;setBusy(true);setError('');const token=localStorage.getItem('token');
    const assertSession=()=>{if(!token||token!==localStorage.getItem('token'))throw Error('Account changed. Sign in and review again.');};
    try{
      await copySavedWork(row,localStorage,location.origin,identity,async ids=>{
        const res=await apiFetch('/api/saved-work/recovery-check/',{method:'POST',body:JSON.stringify({email:identity.email,request_ids:ids,confirmed_own_work:true})});const data=await res.json();
        if(!res.ok||data.review_allowed!==true||data.user_id!==identity.user_id)throw Error(data.error||'Ownership of this saved work could not be confirmed.');
      },assertSession);
      assertSession();await refresh();window.dispatchEvent(new StorageEvent('storage',{key:row.target}));onCopied?.();
    }catch(e){setError((e as Error).message);await refresh().catch(()=>{});}
    finally{setBusy(false);}
  };
  const download=(row:SavedWork)=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify({format:'techtrolley-saved-work-review-1',source:row.source,target:row.target,kind:row.kind,raw_value:row.raw},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='techtrolley-saved-work-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  };
  const outstanding=rows.filter(r=>r.state!=='copied');
  if(!outstanding.length&&!open)return null;
  return <section aria-label="Older saved work" className="fixed bottom-4 left-4 z-[70] bg-amber-100 text-slate-950 rounded-xl p-3 shadow-xl max-w-lg">
    {!open?<button onClick={()=>{setConfirmed(false);setOpen(true);}}>Review {outstanding.length} older saved work record(s)</button>:<div role="dialog" aria-label="Review older saved work" className="max-h-[80vh] overflow-auto space-y-3">
      <h2 className="font-bold">Review older saved work</h2>
      <p>These records were saved under your email. Originals stay on this device. Copying makes them available to the current login; it does not send scans or save changes to the server.</p>
      <p>Close editors for these records in other tabs before copying. If versions conflict, finish or review the current saved work first. Download the older version for comparison.</p>
      <label className="block"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I recognise these records as my own work under this same login.</label>
      {rows.map(row=><article key={row.source} className="border-t border-amber-400 py-2 space-y-2">
        <p>{row.kind} · {row.source.split(':').slice(-2).join(':')} · {row.state}</p>
        {row.state==='conflict'&&<p>Current saved work differs. Both versions are kept; no automatic merge.</p>}
        {row.state==='invalid'&&<p>This record needs technical review and cannot be copied automatically.</p>}
        {row.state==='uncertain'&&<p>A previous copy was interrupted. Review the original and current record, then retry copying. The same saved request IDs are retained.</p>}
        <details><summary>View saved details</summary><pre className="whitespace-pre-wrap break-all max-h-48 overflow-auto">{row.raw.slice(0,12000)}</pre></details>
        {row.state==='copied'?<p>Copied for review. Original retained; it will not be re-imported after a confirmed save.</p>:<>
          <button disabled={!confirmed||busy||!['ready','uncertain'].includes(row.state)} onClick={()=>void copy(row)}>Copy saved {row.kind} for review</button>{' '}
          <button disabled={busy} onClick={()=>{try{download(row);}catch{setError('This record is malformed; keep browser storage for technical recovery.');}}}>Download older {row.kind}</button>
        </>}
      </article>)}
      {error&&<p role="alert">{error}</p>}
      <p>After copying, close any current editor and reopen that event or refresh when your current edits are saved. Pending movements still need their normal explicit retry.</p>
      <button disabled={busy} onClick={()=>void refresh().catch(()=>setError('Could not reload browser storage.'))}>Check saved work again</button>{' '}
      <button disabled={busy} onClick={()=>setOpen(false)}>Close saved work review</button>
    </div>}
  </section>;
}
