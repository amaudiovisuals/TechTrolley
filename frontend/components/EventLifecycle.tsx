import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LifecycleAction, LifecyclePending, LifecycleWorkQueue, lifecycleScope } from '../state/eventLifecycle';
import { setWorkBlocker } from '../state/workSafety';

type ApiFetch = (url: string, options?: RequestInit) => Promise<Response>;
interface Review {
  mode: 'lifecycle_review'; conference_id: number; name: string; revision: number;
  state: 'open' | 'completed' | 'archived'; snapshot_sha256: string;
  can_complete: boolean; can_archive: boolean;
  completed_at: string | null; completed_by_id: number | null; archived_at: string | null;
  blockers: Array<{ reason: string; asset_id?: number | string; ticket_item_id?: number; asset_ids?: number[]; detail?: string }>;
  review_notes?: Array<{ reason: string; asset_id?: number; detail?: string }>;
  physical_returns: Array<{ asset_id: number; label: string; terminal_movement: { action: string; recorded_at: string; operator_id: number } | null }>;
  quantity_allocations: Array<{ asset_id: number; reserved: number; dispatched: number; awaiting_verification: number; dispatched_total: number; verified_total: number }>;
  consumable_allocations: Array<{ asset_id: number; requested: number; returned: number | null; consumed: number; status: string }>;
  history: Array<{ id: number; action: string; reason: string; operator_id: number; recorded_at: string }>;
  documents: Array<{ id: string; number: string; state: string }>;
}
const reasons: Record<string, string> = {
  pending_assets: 'Equipment is still dispatched', pending_crosscheck_assets: 'Warehouse verification is still pending',
  pending_staged_assets: 'Packing entries must be explicitly cleared', pending_requirements: 'Planned requirements must be explicitly cleared',
  quantity_balance_outstanding: 'Bulk quantities are still reserved, dispatched or awaiting verification',
  quantity_return_evidence_inconsistent: 'Bulk return totals do not match recorded movements',
  consumable_return_not_settled: 'Consumable return counts need confirmed settlement',
  consumable_settlement_evidence_inconsistent: 'Consumable settlement lacks matching evidence',
  legacy_consumables_require_reconciliation: 'Old consumable counts need reviewed reconciliation',
  physical_return_evidence_missing: 'No recorded physical return or accepted transfer evidence',
  physical_return_not_verified: 'Physical return is not yet verified',
  transfer_acceptance_evidence_missing: 'Transfer acceptance evidence is missing',
  legacy_quantity_requires_reconciliation: 'Old bulk or consumable history needs reconciliation',
  unresolved_missing_item: 'Missing equipment is unresolved',
  supplier_return_evidence_not_implemented: 'Supplier returns require a separate recorded workflow',
  audit_lifecycle_requires_reviewed_conversion: 'Audit observations need the separate reviewed audit workflow',
  asset_custody_requires_review: 'Current equipment custody has a discrepancy',
  lifecycle_record_inconsistent: 'Completion history needs review',
};
const labels: Record<LifecycleAction, string> = { complete: 'Record verified completion', archive: 'Archive completed event', reopen: 'Reopen event' };

function usePending(queue: LifecycleWorkQueue) {
  const [pending, setPending] = useState<LifecyclePending | null>(null), [error, setError] = useState('');
  const reload = useCallback(() => {
    try { const value = queue.read(); setPending(value); setError(''); setWorkBlocker(queue.key, Boolean(value)); }
    catch (reason) { setPending(null); setError(reason instanceof Error ? reason.message : 'Saved event operation needs review.'); setWorkBlocker(queue.key, true); }
  }, [queue]);
  useEffect(() => {
    reload(); const storage = (event: StorageEvent) => { if (event.key === queue.key || event.key === null) reload(); };
    window.addEventListener('techtrolley-lifecycle-work', reload); window.addEventListener('storage', storage);
    return () => { window.removeEventListener('techtrolley-lifecycle-work', reload); window.removeEventListener('storage', storage); setWorkBlocker(queue.key, false); };
  }, [queue, reload]);
  return { pending, error, reload };
}

export default function EventLifecycle({ user, eventId, apiFetch, onClose, refreshEvent }: {
  key?: string; user: any; eventId: number | null; apiFetch: ApiFetch; onClose: () => void; refreshEvent: (id: number) => Promise<void>;
}) {
  const account = String(user?.user_id || user?.email || '');
  const queue = useMemo(() => new LifecycleWorkQueue(lifecycleScope(location.origin, account)), [account]);
  const { pending, error: storageError, reload } = usePending(queue);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [epoch, setEpoch] = useState(0);
  const busyRef = useRef(false);
  const retry = async () => {
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await queue.execute(pending.payload.request_id, apiFetch, refreshEvent); setEpoch(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Event save could not be confirmed.'); }
    finally { busyRef.current = false; setBusy(false); reload(); }
  };
  const discard = async () => {
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await queue.discardRejected(pending.payload.request_id); await refreshEvent(pending.event_id); setEpoch(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not refresh the event.'); }
    finally { busyRef.current = false; setBusy(false); reload(); }
  };
  return <>
    {(pending || storageError) && <div className="fixed top-4 left-4 right-4 z-[260] rounded-xl bg-amber-100 text-slate-900 p-4 shadow-xl" role="alert">
      <p>{storageError || `Saved ${pending?.payload.action} operation for event ${pending?.event_id}. ${pending?.status === 'rejected' ? 'It was rejected; review current records before a new attempt.' : 'Its result still needs confirmation. Retry the exact saved operation.'}`}</p>
      {pending?.status === 'pending' && <button disabled={busy} onClick={retry} className="p-2 rounded bg-slate-900 text-white mt-2">Retry saved event operation</button>}
      {pending?.status === 'rejected' && <button disabled={busy} onClick={discard} className="p-2 rounded bg-slate-900 text-white mt-2">Discard rejected event attempt and reload</button>}
      {error && <p>{error}</p>}
    </div>}
    {eventId !== null && <LifecyclePanel key={`${account}:${eventId}`} refreshEpoch={epoch} eventId={eventId} user={user} queue={queue} pending={pending} storageError={storageError} outerBusy={busy} apiFetch={apiFetch} refreshEvent={refreshEvent} onClose={onClose} reloadPending={reload} />}
  </>;
}

function LifecyclePanel({ eventId, refreshEpoch, user, queue, pending, storageError, outerBusy, apiFetch, refreshEvent, onClose, reloadPending }: {
  key?: string; eventId: number; refreshEpoch: number; user: any; queue: LifecycleWorkQueue; pending: LifecyclePending | null; storageError: string; outerBusy: boolean;
  apiFetch: ApiFetch; refreshEvent: (id: number) => Promise<void>; onClose: () => void; reloadPending: () => void;
}) {
  const [data, setData] = useState<Review | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [action, setAction] = useState<LifecycleAction>('complete');
  const panel = useRef<HTMLDivElement | null>(null), busyRef = useRef(false), closeRef = useRef(onClose);
  closeRef.current = onClose;
  const draftKey = `${queue.key}:draft:${eventId}`;
  useEffect(() => { setWorkBlocker(draftKey, Boolean(reason || confirmed || busy)); return () => setWorkBlocker(draftKey, false); }, [draftKey, reason, confirmed, busy]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])') || []) as HTMLElement[];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let current = true; setData(null); setError(''); setReason(''); setConfirmed(false);
    apiFetch(`/api/conferences/${eventId}/lifecycle-review/`).then(async response => {
      const value = await response.json();
      if (!response.ok) throw Error(value.error || `Event review failed (${response.status})`);
      if (value.mode !== 'lifecycle_review' || value.conference_id !== eventId || !Array.isArray(value.blockers) || !/^[a-f0-9]{64}$/.test(value.snapshot_sha256)) throw Error('Unexpected event review response.');
      if (current) { setData(value); setAction(value.state === 'open' ? 'complete' : value.state === 'completed' ? 'archive' : 'reopen'); }
    }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : 'Could not load event review.'); });
    return () => { current = false; };
  }, [eventId, apiFetch, attempt, refreshEpoch]);
  const administrator = ['admin', 'boss'].includes(user?.role);
  const allowed = data && (action === 'complete' ? data.can_complete : action === 'archive' ? data.can_archive : administrator && data.state !== 'open');
  const save = async () => {
    if (!data || !allowed || pending || storageError || outerBusy || busyRef.current || !confirmed || !reason.trim()) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const saved = await queue.prepare(eventId, { request_id: crypto.randomUUID(), action, expected_revision: data.revision, expected_snapshot_sha256: data.snapshot_sha256, reason, confirmed: true });
      await queue.execute(saved.payload.request_id, apiFetch, refreshEvent);
      setAttempt(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Event save could not be confirmed.'); }
    finally { busyRef.current = false; setBusy(false); reloadPending(); }
  };
  return <div role="dialog" aria-modal="true" aria-labelledby="event-lifecycle-title" className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4">
    <div ref={panel} className="bg-slate-900 text-slate-100 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[88vh] overflow-auto p-5">
      <div className="flex justify-between gap-4"><h2 id="event-lifecycle-title" className="text-xl font-bold">Event completion review</h2><button disabled={busy} onClick={onClose} aria-label="Close event completion review" className="px-3 py-2 rounded bg-slate-700">Close</button></div>
      {!data && !error && <p role="status">Loading return evidence…</p>}
      {error && <p role="alert" className="text-amber-200 mt-3">{error}</p>}
      {data && <>
        <h3 className="font-bold mt-4">{data.name}</h3><p>Recorded state: {data.state}</p>
        <p className="text-sm text-slate-300 mt-3">Dates and empty queues do not prove returns. Review recorded warehouse verification or accepted transfers before completing this event. Archiving preserves its equipment history and paperwork.</p>
        {data.completed_at && <p className="text-sm mt-2">Completion recorded: {new Date(data.completed_at).toLocaleString()} · Operator #{data.completed_by_id}</p>}
        {data.archived_at && <p className="text-sm">Archived: {new Date(data.archived_at).toLocaleString()}</p>}
        {data.blockers.length > 0 ? <div className="mt-4 rounded border border-amber-600 p-3"><p className="font-bold">Completion needs attention</p>{data.blockers.map((row, index) => <p key={index} className="text-sm mt-1">{reasons[row.reason] || row.reason}{row.asset_id ? ` · Item #${row.asset_id}` : ''}{row.asset_ids?.length ? ` · Items ${row.asset_ids.join(', ')}` : ''}{row.ticket_item_id ? ` · Supplier entry #${row.ticket_item_id}` : ''}{row.detail ? ` · ${row.detail.replaceAll('_', ' ')}` : ''}</p>)}</div> : <p role="status" className="mt-4 text-emerald-300">No outstanding operational balances in this reviewed snapshot.</p>}
        {Boolean(data.review_notes?.length) && <div className="mt-3 text-sm text-amber-200"><p>Current equipment needs separate attention. This does not reverse its previously recorded return; archiving will preserve these records.</p>{data.review_notes?.map((row, index) => <p key={index}>{reasons[row.reason] || row.reason} · Item #{row.asset_id}</p>)}</div>}
        {data.physical_returns.map(row => <p key={row.asset_id} className="text-sm mt-2">{row.label} · {row.terminal_movement ? `${row.terminal_movement.action === 'transfer_out' ? 'Accepted transfer' : row.terminal_movement.action === 'legacy_return_review' ? 'Legacy return reviewed · original date not recorded' : row.terminal_movement.action.replaceAll('_', ' ')} · ${new Date(row.terminal_movement.recorded_at).toLocaleString()} · Operator #${row.terminal_movement.operator_id}` : 'Return evidence not recorded'}</p>)}
        {data.quantity_allocations.map(row => <p key={row.asset_id} className="text-sm mt-2">Bulk item #{row.asset_id}: {row.reserved} packed, {row.dispatched} dispatched, {row.awaiting_verification} awaiting verification · {row.verified_total}/{row.dispatched_total} verified returns</p>)}
        {data.consumable_allocations.map(row => <p key={row.asset_id} className="text-sm mt-2">Consumable #{row.asset_id}: {row.status} · Requested {row.requested}, returned {row.returned ?? 'unknown'}, consumed {row.consumed}</p>)}
        <p className="text-sm mt-3">{data.documents.length} saved challan documents will be retained.</p>
        <div className="mt-5 space-y-3 border-t border-slate-700 pt-4">
          <label className="block">Event lifecycle action<select aria-label="Event lifecycle action" value={action} disabled={busy || Boolean(pending) || outerBusy} onChange={event => { setAction(event.target.value as LifecycleAction); setConfirmed(false); }} className="block w-full p-2 rounded bg-slate-800 mt-1">
            {data.state === 'open' && <option value="complete">{labels.complete}</option>}
            {data.state === 'completed' && <option value="archive">{labels.archive}</option>}
            {data.state !== 'open' && administrator && <option value="reopen">{labels.reopen}</option>}
          </select></label>
          {data.state === 'archived' && !administrator && <p>Only an administrator can reopen an archived event.</p>}
          <label className="block">Reason for event operation<textarea aria-label="Reason for event operation" maxLength={1000} value={reason} disabled={busy || Boolean(pending) || outerBusy} onChange={event => setReason(event.target.value)} className="block w-full rounded bg-slate-800 p-2 mt-1" /></label>
          <label className="block text-sm"><input type="checkbox" aria-label="Confirm event evidence review" disabled={busy || Boolean(pending) || outerBusy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {action === 'complete' ? 'I verified the equipment return/transfer evidence and operational balances.' : action === 'archive' ? 'I reviewed the recorded completion and will retain its history and paperwork.' : 'I authorize reopening; this preserves history and does not restore any equipment allocation.'}</label>
          <button onClick={save} disabled={!allowed || !reason.trim() || !confirmed || busy || outerBusy || Boolean(pending) || Boolean(storageError)} className="rounded bg-sky-600 px-4 py-2 disabled:opacity-40">{labels[action]}</button>
        </div>
        {data.history.length > 0 && <div className="mt-4 border-t border-slate-700 pt-3"><h3 className="font-bold">Recorded lifecycle history</h3>{data.history.map(row => <p key={row.id} className="text-sm mt-2">{row.action} · {new Date(row.recorded_at).toLocaleString()} · Operator #{row.operator_id} · {row.reason}</p>)}</div>}
      </>}
      <button disabled={busy || outerBusy} onClick={() => setAttempt(value => value + 1)} className="mt-4 rounded bg-slate-700 px-3 py-2">Reload event evidence</button>
    </div>
  </div>;
}
