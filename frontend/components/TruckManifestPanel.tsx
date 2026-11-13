import React, { useState } from 'react';
import type { Booking } from '../types';
import { manifestQuantity, manifestCommand } from '../state/truckManifests';

type Props = {
  booking: Booking; canWrite: boolean; disabled: boolean; onCommand: (action: string, fields?: Record<string, any>) => Promise<any>;
  onViewTruck: (id: string | null) => void;
};
export const TruckManifestPanel: React.FC<Props> = ({ booking, canWrite, disabled, onCommand, onViewTruck }) => {
  const master = booking.challan_documents?.find(doc => doc.scope === 'master');
  const trucks = booking.truckChallans || [];
  const hasIssuedTruck = booking.challan_documents?.some(doc => doc.truck_id && doc.state === 'issued');
  const recorded = { ...Object.fromEntries(Object.entries((booking.quantity_allocations || {}) as Record<string, any>).map(([id, row]) => [id, Number(row.dispatched_total || 0) + Number(row.reserved || 0)])),
    ...Object.fromEntries(Object.entries((booking.consumable_ledger || {}) as Record<string, any>).map(([id, row]) => [id, row.requested])) };
  const missing = Object.entries(recorded).filter(([id, quantity]) => Number(quantity) > 0 && Number(quantity) > (master?.lines.find(line => String(line.asset_id) === id && !line.ticket_item_id)?.quantity || 0));
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState(''), [documentDate, setDocumentDate] = useState(master?.document_date || '');
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [metadata, setMetadata] = useState<Record<string, any>>({});
  const run = async (action: string, fields: Record<string, any> = {}) => {
    setError('');
    try {
      await onCommand(action, fields); setQuantities({});
      if (action === 'cancel') {
        setFrom(''); setTo(''); setMetadata({}); setConfirmCancel(false);
        onViewTruck(null);
      }
      if (action === 'metadata') setMetadata(prev => { const next = { ...prev }; delete next[String(fields.truck_id)]; return next; });
    }
    catch (error) { setError((error as Error).message); }
  };
  if (!booking.truck_manifest && !trucks.length && !missing.length) return null;
  return <section className="p-5 rounded-2xl bg-slate-900 border border-slate-700 space-y-4 text-white" data-testid="truck-manifest-panel">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-bold">Truck quantities</h3>
      {canWrite && booking.truck_manifest && !hasIssuedTruck && !booking.challans_locked && !confirmCancel &&
        <button type="button" disabled={disabled} onClick={() => setConfirmCancel(true)} className="rounded border border-red-400 px-3 py-2 text-sm text-red-200">Cancel draft split</button>}
    </div>
    {confirmCancel && <div className="rounded border border-amber-400 bg-slate-800 p-3 text-sm">
      <p>Remove the draft trucks and return to the master challan?</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={disabled} onClick={() => void run('cancel', { reason: 'Draft truck split cancelled' })} className="rounded bg-red-700 px-3 py-2">Remove draft trucks</button>
        <button type="button" disabled={disabled} onClick={() => setConfirmCancel(false)} className="rounded border border-slate-400 px-3 py-2">Keep split</button>
      </div>
    </div>}
    <p className="text-sm text-slate-300">Split saved challan lines between trucks. Inventory scans and warehouse returns remain separate operations.</p>
    {master && missing.length > 0 && <p role="alert" className="text-amber-300">New recorded quantities need master review. Open the master challan, update existing quantities or use Add latest event items, then save before allocating those units.</p>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {!booking.truck_manifest ? <>
      {trucks.length > 0 && <p>Existing legacy trucks need review before conversion.</p>}
    </> : <>
      <div className="flex gap-3 flex-wrap"><button type="button" onClick={() => onViewTruck(null)}>View master challan</button>{trucks.map(truck => <button type="button" key={truck.id} onClick={() => onViewTruck(truck.id)}>View {truck.label} challan</button>)}</div>
      <div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th>Saved master source</th><th>Total</th><th>Unassigned</th>{trucks.map(truck => <th key={truck.id}>{truck.label}</th>)}</tr></thead>
        <tbody>{master?.lines.map(line => <tr key={line.id} data-testid={`manifest-source-${line.id}`}><td>{line.snapshot.alias_name || line.snapshot.sku} · {line.source_kind}{line.snapshot.supplier_name ? ` · ${line.snapshot.supplier_name}` : ''}</td>
          <td>{line.quantity}</td><td>{manifestQuantity(booking, line, '')}</td>{trucks.map(truck => <td key={truck.id}>{manifestQuantity(booking, line, truck.id)}</td>)}</tr>)}</tbody></table></div>
      {canWrite && <>
        {trucks.map(truck => <div key={truck.id} className="flex gap-3 flex-wrap items-center border border-slate-700 p-3">
          <span>{truck.label}</span>
          <input aria-label={`Vehicle ${truck.label}`} value={metadata[truck.id]?.vehicle_number ?? truck.vehicle_number} disabled={disabled} onChange={event => setMetadata(prev => ({ ...prev, [truck.id]: { ...manifestCommand(booking, 'metadata', { vehicle_number: truck.vehicle_number, driver_phone: truck.driver_phone }), ...prev[truck.id], vehicle_number: event.target.value } }))} className="bg-slate-800 p-2" />
          <input aria-label={`Driver phone ${truck.label}`} value={metadata[truck.id]?.driver_phone ?? truck.driver_phone} disabled={disabled} onChange={event => setMetadata(prev => ({ ...prev, [truck.id]: { ...manifestCommand(booking, 'metadata', { vehicle_number: truck.vehicle_number, driver_phone: truck.driver_phone }), ...prev[truck.id], driver_phone: event.target.value } }))} className="bg-slate-800 p-2" />
          <button type="button" disabled={disabled} onClick={() => { void run('metadata', { ...metadata[truck.id], truck_id: Number(truck.id), vehicle_number: metadata[truck.id]?.vehicle_number ?? truck.vehicle_number, driver_phone: metadata[truck.id]?.driver_phone ?? truck.driver_phone }); }}>Save {truck.label} details</button>
          {metadata[truck.id] && metadata[truck.id].expected_event_revision !== booking.revision && <div>
            <p>Saved details changed. Current vehicle: {truck.vehicle_number || 'blank'}; driver: {truck.driver_phone || 'blank'}. Compare your draft before saving.</p>
            <button type="button" disabled={disabled} onClick={() => setMetadata(prev => ({ ...prev, [truck.id]: { ...prev[truck.id], ...manifestCommand(booking, 'metadata') } }))}>Keep reviewed {truck.label} details</button>
            <button type="button" disabled={disabled} onClick={() => setMetadata(prev => { const next = { ...prev }; delete next[truck.id]; return next; })}>Load saved {truck.label} details</button>
          </div>}
        </div>)}
        <button type="button" disabled={disabled} onClick={() => { void run('add'); }} className="rounded bg-sky-600 p-3">Add empty manifest truck</button>
        <div className="flex gap-4 flex-wrap">
          <label>From<select aria-label="Manifest from" value={from} disabled={disabled} onChange={event => { setFrom(event.target.value); setQuantities({}); }} className="block bg-slate-800 p-2"><option value="">Unassigned</option>{trucks.map(truck => <option key={truck.id} value={truck.id}>{truck.label}</option>)}</select></label>
          <label>To<select aria-label="Manifest to" value={to} disabled={disabled} onChange={event => setTo(event.target.value)} className="block bg-slate-800 p-2"><option value="">Unassigned</option>{trucks.map(truck => <option key={truck.id} value={truck.id}>{truck.label}</option>)}</select></label>
        </div>
        {master?.lines.map(line => <label key={line.id} className="block text-sm">{line.snapshot.alias_name || line.snapshot.sku} · available {manifestQuantity(booking, line, from)}
          <input aria-label={`Move ${line.snapshot.alias_name || line.snapshot.sku}`} type="number" min="0" max={manifestQuantity(booking, line, from)} value={quantities[line.id] || 0} disabled={disabled}
            onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0 && value <= manifestQuantity(booking, line, from)) setQuantities(prev => ({ ...prev, [line.id]: value })); }} className="ml-3 w-24 bg-slate-800 p-2" /></label>)}
        <label className="block">Reason for correcting issued truck copies<input aria-label="Manifest correction reason" value={reason} disabled={disabled} onChange={event => setReason(event.target.value)} className="block w-full bg-slate-800 p-2" /></label>
        <button type="button" disabled={disabled || from === to || !Object.values(quantities as Record<string, number>).some(value => value > 0)} onClick={() => { void run('move', {
          from_truck_id: from ? Number(from) : null, to_truck_id: to ? Number(to) : null, reason,
          items: Object.entries(quantities as Record<string, number>).filter(([, quantity]) => quantity > 0).map(([master_line_id, quantity]) => ({ master_line_id, quantity })) }); }} className="rounded bg-emerald-700 p-3">Move selected manifest quantities</button>
        <label className="block">Truck document date<input aria-label="Truck document date" type="date" value={documentDate} disabled={disabled} onChange={event => setDocumentDate(event.target.value)} className="ml-3 bg-slate-800 p-2" /></label>
        {trucks.map(truck => { const doc = booking.challan_documents?.find(doc => doc.scope === `truck-${truck.id}`); return doc?.state === 'issued' ? <p key={truck.id}>{truck.label} issued · revision {doc.revision}</p> :
          <button type="button" key={truck.id} disabled={disabled || !documentDate || !doc?.lines.length} onClick={() => { void run('issue', { truck_id: Number(truck.id), document_date: documentDate }); }} className="mr-3 rounded bg-indigo-600 p-3">Issue {truck.label} challan</button>; })}
        <p className="text-sm text-slate-400">Before reducing or deleting a master line, move its truck quantities to Unassigned. Master edits revise the linked truck copies; issued corrections require a reason.</p>
      </>}
    </>}
  </section>;
};
