import React, { useEffect, useRef, useState } from 'react';

export interface CustodyReviewData {
  mode: 'preview_only'; conference_id: number; name: string; revision: number;
  mismatch_count: number; blocked_count: number; snapshot_sha256: string;
  rows: Array<{
    asset_id: number; label: string; stored_status: string; expected_status: string;
    status_matches: boolean; blockers: string[];
    evidence: { asset: { assigned_to_id: number | null; flag: string; condition: string }; custody: {
      active_event_ids: number[]; unchecked_event_ids: number[]; audit_event_ids: number[];
      staged_event_ids: number[]; legacy_quantity_unknown: boolean;
      staff_issue_employee_ids?: number[];
    } };
  }>;
}

const reasons: Record<string, string> = {
  unknown_legacy_quantity: 'Old quantities need confirmation',
  multiple_event_holders: 'More than one current event holder',
  staff_and_event_custody_overlap: 'Staff issue overlaps event custody',
  active_and_unchecked_overlap: 'Both active and awaiting verification',
  held_quantity_exceeds_stock: 'Recorded held quantity exceeds stock',
  physical_custody_confirmation_required: 'Confirm physical custody before repair',
  staff_history_disagrees_with_custodian: 'Open staff issue differs from the inventory custodian; requires review',
};

export default function CustodyReview({ conferenceId, loadReview, onClose }: {
  key?: string; conferenceId: number; loadReview: (id: number) => Promise<CustodyReviewData>; onClose: () => void;
}) {
  const [data, setData] = useState<CustodyReviewData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [onlyReview, setOnlyReview] = useState(true);
  const panel = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') || []) as HTMLElement[];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let current = true;
    setData(null); setError('');
    loadReview(conferenceId).then(result => {
      if (result.conference_id !== conferenceId || result.mode !== 'preview_only' || !Array.isArray(result.rows)) throw new Error('Unexpected review response.');
      if (current) setData(result);
    }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : 'Could not load custody review.'); });
    return () => { current = false; };
  }, [conferenceId, loadReview, attempt]);
  const rows = data?.rows.filter(row => !onlyReview || !row.status_matches || row.blockers.length > 0) || [];
  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="custody-review-title">
      <div ref={panel} className="bg-slate-900 text-slate-100 rounded-2xl border border-slate-700 w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="p-5 flex items-start justify-between gap-4 border-b border-slate-700">
          <div><h2 id="custody-review-title" className="font-bold text-xl">Custody review</h2>
            <p className="text-sm text-slate-300 mt-1">{data?.name || `Event ${conferenceId}`}</p>
            <p className="text-sm text-amber-200 mt-2">Read-only review. No inventory or history is changed.</p></div>
          <button type="button" onClick={onClose} aria-label="Close custody review" className="px-3 py-2 rounded bg-slate-700">Close</button>
        </div>
        <div className="p-5 overflow-auto">
          {!data && !error && <p role="status">Loading current custody…</p>}
          {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-3 px-3 py-2 bg-slate-700 rounded">Retry review</button></div>}
          {data && <>
            <p className="text-sm">{data.rows.length} items reviewed · {data.mismatch_count} status differences · {data.blocked_count} items needing confirmation</p>
            <p className="text-sm text-slate-300 mt-2">Audit observations, packing plans and challan history do not establish where equipment is now. Dates and empty return queues do not prove a completed return.</p>
            <label className="block text-sm my-4"><input type="checkbox" checked={onlyReview} onChange={event => setOnlyReview(event.target.checked)} /> Show items needing review only</label>
            {!rows.length && <p role="status">{onlyReview ? 'No status differences or review blockers in this snapshot.' : 'No related items in this event.'}</p>}
            {rows.map(row => <div key={row.asset_id} className="rounded border border-slate-700 p-4 mb-3" data-asset-id={row.asset_id}>
              <h3 className="font-bold">{row.label} <span className="text-slate-400 text-sm">#{row.asset_id}</span></h3>
              <p className="text-sm mt-1">Stored: {row.stored_status} · Expected from current records: {row.expected_status}</p>
              <p className="text-sm text-slate-300 mt-1">Active events: {row.evidence.custody.active_event_ids.join(', ') || 'None'} · Awaiting verification: {row.evidence.custody.unchecked_event_ids.join(', ') || 'None'} · Staff custodian: {row.evidence.asset.assigned_to_id ?? 'None'}</p>
              {Boolean(row.evidence.custody.staff_issue_employee_ids?.length) && <p className="text-sm">Recorded staff issue: {row.evidence.custody.staff_issue_employee_ids?.join(', ')}</p>}
              {(row.evidence.asset.flag || row.evidence.asset.condition === 'Damaged') && <p className="text-sm text-amber-200 mt-1">Restriction: {row.evidence.asset.flag || row.evidence.asset.condition}</p>}
              {row.blockers.map(reason => <p key={reason} className="text-sm text-amber-200 mt-1">{reasons[reason] || reason}</p>)}
            </div>)}
            <p className="text-xs text-slate-400 mt-4">Reload this review after changes. Any future repair requires physical confirmation and a fresh comparison.</p>
            <button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-3 px-3 py-2 bg-slate-700 rounded">Reload review</button>
          </>}
        </div>
      </div>
    </div>
  );
}
