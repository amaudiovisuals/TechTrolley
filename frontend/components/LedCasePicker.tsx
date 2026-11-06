import React from 'react';
import type { Asset } from '../types';
import { setWorkBlocker } from '../state/workSafety';

export function LedCasePicker({ source, action, event, apiFetch, onConfirm, onClose, pending }: {
  source: Asset; action: string; event: any; apiFetch: (url: string) => Promise<Response>;
  onConfirm: (ids: string[]) => Promise<boolean>; onClose: () => void; pending: boolean;
}) {
  const [box, setBox] = React.useState<Asset | null>(null), [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]), [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setWorkBlocker('led-case-picker', true); return () => setWorkBlocker('led-case-picker', false); }, []);
  const eligible = (panel: NonNullable<Asset['led_case']>['panels'][number]) => {
    const id = String(panel.asset_id), ids = (field: string) => (event[field] || []).map(String).includes(id);
    if (action === 'return') return ids('assets');
    if (action === 'verify_return') return ids('crosscheck_assets');
    if (action === 'unstage') return ids('staged_assets');
    if (action === 'require') return !ids('requirements');
    if (action === 'audit_observe') return !ids('staged_assets') && !ids('assets');
    if (action === 'audit_remove') return ids('staged_assets') || ids('assets') || ids('crosscheck_assets');
    return panel.available > 0 && !ids('assets') && !ids('crosscheck_assets') && !ids('staged_assets');
  };
  React.useEffect(() => {
    let active = true;
    apiFetch(`/api/assets/${source.id}/`).then(async response => {
      const value = await response.json();
      if (!response.ok || value.stock_kind !== 'led_case' || value.led_case?.panels?.length !== 6) throw Error('The registered box panels could not be loaded. Reopen the program before scanning.');
      if (active) { setBox(value); setSelected(value.led_case.panels.filter(eligible).map((row: any) => String(row.asset_id))); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [source.id]);
  async function submit() {
    if (busy || pending || !selected.length) return;
    setBusy(true); setError('');
    try { if (await onConfirm(selected)) onClose(); else setError('Movement not confirmed. Review the saved movement status before trying again.'); }
    catch(e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-[150] bg-black/60 flex items-center justify-center p-3">
    <section role="dialog" aria-modal="true" aria-label="Select LED box panels" className="bg-white text-slate-900 rounded-xl p-5 w-full max-w-xl max-h-[90vh] overflow-y-auto space-y-4">
      <h2 className="font-bold text-lg">Select LED box panels</h2>
      <p className="font-bold break-words">{box?.led_case?.box_code || source.sku}</p>
      <p className="text-sm">The old box QR identifies six registered panels. Confirm which numbered panels are physically present and being {action.replaceAll('_', ' ')}. The box itself is not an extra stock item.</p>
      <p className="text-sm">Until individual QR labels are attached, keep panels in their registered box and mark positions 1–6. Owners below come from the panel records.</p>
      {!box && !error && <p role="status">Loading registered panels…</p>}
      {box?.led_case?.panels.map(panel => <label key={panel.asset_id} className="flex items-start gap-3 border rounded p-3 text-sm break-words">
        <input type="checkbox" aria-label={`Panel ${panel.slot} ${panel.sku}`} checked={selected.includes(String(panel.asset_id))} disabled={busy || pending || !eligible(panel)}
          onChange={e => setSelected(old => e.target.checked ? [...old, String(panel.asset_id)] : old.filter(id => id !== String(panel.asset_id)))} />
        <span><strong>Panel {panel.slot} — {panel.sku}</strong><span className="block">{panel.owner_name} · {panel.status}{!eligible(panel) ? ' · Not available for this action' : ''}</span></span>
      </label>)}
      {error && <p role="alert" className="text-red-800">{error}</p>}
      {pending && <p role="status" className="text-amber-900">A saved movement is awaiting confirmation. Close this window to review or recover it.</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || pending || !selected.length} onClick={submit} className="bg-sky-100 text-slate-900 border border-sky-300 rounded px-4 py-2 disabled:opacity-50">{busy ? 'Saving…' : `Confirm ${selected.length} panel${selected.length === 1 ? '' : 's'}`}</button>
        <button type="button" disabled={busy} onClick={onClose} className="bg-slate-200 text-slate-900 rounded px-4 py-2">Close</button>
      </div>
    </section>
  </div>;
}
