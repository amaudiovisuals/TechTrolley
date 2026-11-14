import React, { useState } from 'react';

type Review = {
  revision: number;
  review_hash: string;
  unit_count: number;
  rows: { asset_id: number; sku: string; name: string; quantity: number | null }[];
  blockers: { asset_id: number; sku?: string; reason: string }[];
};

export const SkipPackup: React.FC<{
  disabled: boolean;
  getReview: () => Promise<Review>;
  confirm: (payload: { expected_revision: number; review_hash: string; reason: string }) => Promise<void>;
}> = ({ disabled, getReview, confirm }) => {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setOpen(true);
    setBusy(true);
    setReview(null);
    setError('');
    try { setReview(await getReview()); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!review?.unit_count || review.blockers.length || !reason.trim() || busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await confirm({ expected_revision: review.revision, review_hash: review.review_hash, reason: reason.trim() });
      setOpen(false);
    } catch (error) {
      setReview(null);
      setError((error as Error).message);
    } finally { setBusy(false); }
  }

  return <>
    <button type="button" disabled={disabled || busy} onClick={() => { setReason(''); void refresh(); }}
      className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-50">
      Skip Packup
    </button>
    {open && <div className="fixed inset-0 z-[120] grid place-items-center bg-slate-950/60 p-4">
      <form role="dialog" aria-modal="true" aria-labelledby="skip-packup-title" onSubmit={submit}
        className="max-h-[85dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl bg-white p-5 text-slate-900 shadow-xl">
        <h2 id="skip-packup-title" className="text-lg font-semibold">Skip Packup</h2>
        <p className="text-sm">Move the full Packup list to Crosscheck. The godown team still needs to verify receipt.</p>
        {busy && <p role="status" className="text-sm">Checking Packup records…</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {review && <>
          <p className="text-sm font-semibold">{review.unit_count} units across {review.rows.length} equipment records</p>
          {review.blockers.length > 0 && <ul className="space-y-1 text-sm text-red-700">
            {review.blockers.map(row => <li key={row.asset_id}>{row.sku || row.asset_id} — {row.reason}</li>)}
          </ul>}
          {review.rows.length > 0 && <ul className="max-h-48 divide-y divide-slate-200 overflow-y-auto text-sm" aria-label="Full Packup review">
            {review.rows.map(row => <li className="flex justify-between gap-2 py-1.5" key={row.asset_id}>
              <span>{row.name} ({row.sku})</span><span>{row.quantity ?? 'Review'}</span>
            </li>)}
          </ul>}
          {review.unit_count > 0 && review.blockers.length === 0 && <label className="grid gap-1 text-sm font-semibold">
            Reason for skipping Packup
            <textarea required maxLength={500} value={reason} disabled={busy}
              onChange={event => setReason(event.target.value)} className="rounded-lg border border-slate-300 p-2 font-normal" />
          </label>}
        </>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setOpen(false)} disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium">Close review</button>
          {!review && error && <button type="button" disabled={busy || disabled} onClick={() => void refresh()}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium">Refresh Packup review</button>}
          {review && <button type="submit"
            disabled={busy || disabled || !review.unit_count || Boolean(review.blockers.length) || !reason.trim()}
            className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Move {review.unit_count} units to Crosscheck
          </button>}
        </div>
      </form>
    </div>}
  </>;
};
