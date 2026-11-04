import React from 'react';
import type { Asset } from '../types';
import { consumableLimit } from '../state/consumableWorkflow';

export function ConsumablePanel({ mode, data, ledger, assets, warehouse, disabled, onRequest, onReturn, onConfirm, onSave, onDispatch }: {
  mode: 'requests' | 'returns'; data: Record<string, any>; ledger: Record<string, any>; assets: Asset[];
  warehouse: boolean; disabled: boolean; onRequest: (id: string, delta: number) => void;
  onReturn: (id: string, count: number | null) => void; onConfirm: (id: string, confirmed: boolean) => void;
  onSave: () => void; onDispatch: () => void;
}) {
  const entries = Object.entries(data || {}).filter(([, row]) => Number(row.requested) > 0 && (mode === 'requests' || row.status !== 'settled'));
  if (!entries.length) return null;
  return <section className="col-span-2 space-y-4 mt-6 p-4 border border-amber-200 rounded-2xl bg-amber-50 text-slate-900">
    <h4 className="font-black uppercase text-xs">{mode === 'requests' ? 'Consumable requests' : 'Consumable returns'}</h4>
    <p className="text-xs">{mode === 'requests' ? 'Save requests to reserve stock. Dispatch confirms the quantities sent to the venue.' : 'Enter the counted returns. Stock is deducted only after warehouse settlement.'}</p>
    {entries.map(([id, row]) => {
      const asset = assets.find(a => String(a.id) === id), saved = ledger?.[id];
      const editable = mode === 'requests' ? row.status === 'requested' : row.ledger && row.status === 'dispatched';
      const limit = consumableLimit(asset, saved);
      return <div key={id} data-testid={`consumable-${mode}-${id}`} className="p-3 rounded-xl border border-amber-200 bg-white space-y-2">
        <p className="font-bold">{asset?.aliasName || asset?.sku || `Consumable #${id}`}</p>
        <p className="text-xs">{row.requested} units · {row.ledger ? row.status : 'Unsaved request / older record'}</p>
        {!row.ledger && row.status && row.status !== 'requested' && <p className="text-xs text-red-700">This older record needs reconciliation before settlement.</p>}
        {mode === 'requests' ? <label className="block text-xs">Requested quantity
          <input aria-label="Requested quantity" type="number" min="0" max={limit} value={row.requested}
            disabled={disabled || !editable} className="ml-3 border rounded px-2 py-1 w-24 text-slate-900"
            onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0 && value <= limit) onRequest(id, value - row.requested); }} />
          <span className="ml-3">Maximum available to this event: {limit}</span>
        </label> : <>
          <label className="block text-xs">Returned to warehouse
            <input aria-label="Returned to warehouse" type="number" min="0" max={row.requested} value={row.returned ?? ''}
              disabled={disabled || !editable} className="ml-3 border rounded px-2 py-1 w-24 text-slate-900"
              onChange={event => onReturn(id, event.target.value === '' ? null : Number(event.target.value))} />
          </label>
          {warehouse && <label className="flex gap-2 items-center text-xs">
            <input type="checkbox" checked={row.return_confirmed === true} disabled={disabled || !editable || row.returned == null}
              onChange={event => onConfirm(id, event.target.checked)} />I verified this return count
          </label>}
          <p className="text-xs">Consumption: {row.returned == null ? 'Return count not entered' : row.requested - row.returned}{row.status !== 'settled' && ' (not yet deducted)'}</p>
          {!editable && <p className="text-xs text-red-700">Save and dispatch the request before reporting its returns.</p>}
        </>}
      </div>;
    })}
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={disabled} onClick={onSave} className="px-4 py-2 rounded-lg bg-slate-800 text-white font-bold text-xs">{mode === 'requests' ? 'Save consumable requests' : 'Save reported returns'}</button>
      {warehouse && mode === 'requests' && entries.some(([, row]) => row.status === 'requested') && <button type="button" disabled={disabled} onClick={onDispatch} className="px-4 py-2 rounded-lg bg-emerald-700 text-white font-bold text-xs">Dispatch consumables</button>}
    </div>
  </section>;
}
