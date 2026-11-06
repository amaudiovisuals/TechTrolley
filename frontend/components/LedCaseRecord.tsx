import React from 'react';
import type { Asset } from '../types';

export function LedCaseRecord({asset, canReview, apiFetch}: {key?: string; asset: Asset; canReview: boolean; apiFetch: (url: string) => Promise<Response>}) {
  const [review, setReview] = React.useState<any>(null), [error, setError] = React.useState(''), [loading, setLoading] = React.useState(false);
  async function load() {
    setLoading(true); setError('');
    try { const response=await apiFetch(`/api/assets/${asset.id}/led-case-conversion/`), body=await response.json();
      if (!response.ok) throw Error(body.error || 'Conversion review unavailable.'); setReview(body);
    } catch(e) { setError((e as Error).message); } finally {setLoading(false);}
  }
  if (asset.stock_kind === 'led_panel') return <section aria-label="LED panel origin" className="rounded-xl border border-slate-300 bg-white text-slate-900 p-4 space-y-2">
    <h3 className="font-bold">Individual normal P2 panel</h3>
    <p className="break-words">Original box: {asset.led_panel_origin?.box_code} · Panel position {asset.led_panel_origin?.slot}/6</p>
    <p className="text-sm">Quantity 1 means one panel. Until individually labelled, keep this panel in its registered box with its temporary position number.</p>
  </section>;
  if (asset.stock_kind === 'led_case') return <section aria-label="Converted LED box" className="rounded-xl border border-slate-300 bg-white text-slate-900 p-4 space-y-3">
    <h3 className="font-bold">Converted LED box — container and history</h3>
    <p>The original box QR still works. Select the registered panels when scanning; this box is excluded from current stock totals and cannot be dispatched as another panel.</p>
    {asset.led_case?.panels.map(panel=><p key={panel.asset_id} className="text-sm break-words">Panel {panel.slot}: {panel.sku} · {panel.owner_name}</p>)}
  </section>;
  if (!canReview || asset.aliasName !== 'LED WALL BOX P2') return null;
  return <section aria-label="Review LED box conversion" className="rounded-xl border border-slate-300 bg-white text-slate-900 p-4 space-y-3">
    <h3 className="font-bold">Normal P2 box → six panels</h3>
    <p className="text-sm">Review only. The original box QR and history will remain. Ownership is handled separately during the reviewed transfer.</p>
    <button type="button" disabled={loading} onClick={load} className="rounded bg-slate-800 text-white px-4 py-2">{loading ? 'Loading…' : 'Review panel conversion'}</button>
    {error && <p role="alert" className="text-red-800">{error.replaceAll('_',' ')}</p>}
    {review && <div className="space-y-2 text-sm">
      <p>Before: 1 box. After: 6 panels; the box is retained as a container and historical record.</p>
      {review.panels.map((panel:any)=><p key={panel.slot} className="break-words">Panel {panel.slot}: {panel.sku}</p>)}
      {!!review.blockers.length && <p role="alert" className="text-amber-900">Review needed: {review.blockers.join('; ').replaceAll('_',' ')}</p>}
      <p>No stock has changed. Conversion is applied through the reviewed transfer process after the six physical panels are confirmed.</p>
    </div>}
  </section>;
}
