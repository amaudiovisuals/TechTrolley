import React, { useEffect, useRef, useState } from 'react';
import { OfflinePackage, OfflinePackageStore, validateOfflinePackage } from '../state/offlinePackages';
import { resolveScan } from '../state/scanIdentity';
import { Scanner } from './Scanner';
import { setWorkBlocker } from '../state/workSafety';

interface Props {
  key?: string;
  accountId: number; role: string; events: Array<{ id: string; conferenceName: string; isAudit?: boolean; lifecycle_state?: string }>;
  loadEvents: () => void; prepare: (id: number) => Promise<unknown>;
  queue: (event: number, asset: number) => Promise<unknown>;
}
export default function OfflineScanning(props: Props) {
  const [open, setOpen] = useState(false), [online, setOnline] = useState(navigator.onLine);
  const [rows, setRows] = useState<Array<{ eventId: number; state: string; package?: OfflinePackage }>>([]);
  const [eventId, setEventId] = useState(''), [selected, setSelected] = useState(0);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [camera, setCamera] = useState(false), [code, setCode] = useState('');
  const epoch = useRef(0), flight = useRef(false);
  const context = { origin: location.origin, accountId: props.accountId, role: props.role };
  useEffect(() => {
    const key = `offline-workspace:${props.accountId}:${props.role}`;
    setWorkBlocker(key, busy || camera);
    return () => setWorkBlocker(key, false);
  }, [busy, camera, props.accountId, props.role]);
  useEffect(() => { const changed = () => setOnline(navigator.onLine); window.addEventListener('online', changed); window.addEventListener('offline', changed); return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); }; }, []);
  useEffect(() => { const id = ++epoch.current; if (!open) return;
    const refresh = () => new OfflinePackageStore().list(context).then(value => { if (id === epoch.current) setRows(value); }).catch(e => { if (id === epoch.current) setMessage(e.message); });
    void refresh(); const timer = setInterval(refresh, 30000);
    if (navigator.onLine) props.loadEvents();
    return () => { epoch.current++; clearInterval(timer); };
  }, [open, props.accountId, props.role]);
  const prepare = async () => {
    if (flight.current || !online || !eventId) return;
    flight.current = true; setBusy(true); setMessage('Preparing offline data…'); const id = epoch.current;
    try {
      const value = await props.prepare(Number(eventId));
      if (id !== epoch.current) return;
      const pack = await new OfflinePackageStore().save(value, { ...context, eventId: Number(eventId) });
      if (id !== epoch.current) return;
      setRows(await new OfflinePackageStore().list(context)); setSelected(pack.event.id);
      setMessage('Offline data prepared. Scans remain unconfirmed until server Retry.');
    } catch (e) { if (id === epoch.current) setMessage((e as Error).message); }
    finally { flight.current = false; if (id === epoch.current) setBusy(false); }
  };
  const scan = async (input: string) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); const id = epoch.current; setMessage('Checking prepared data…');
    try {
      const result = await new OfflinePackageStore().read({ ...context, eventId: selected });
      if (id !== epoch.current) return;
      if (result.state !== 'ready' || !result.package) throw Error(result.state === 'expired' ? 'Prepared data expired. Reconnect and prepare this event again.' : 'No valid prepared data. Prepare this event online first.');
      const pack = validateOfflinePackage(result.package, { ...context, eventId: selected });
      const match = resolveScan(input, pack.assets.map(a => ({ id: String(a.id), sku: a.sku, barcode: a.barcode, qrCode: a.qr_code, serialNumber: a.serial_number })) as any);
      if (match.kind !== 'matched') throw Error(match.kind === 'ambiguous' ? 'Duplicate identifier in prepared data. Ask the warehouse manager to review it.' : 'Code not in this prepared unit-stock index. Other stock workflows need an online connection.');
      const asset = pack.assets.find(a => String(a.id) === match.asset.id)!;
      if (pack.event.staged_ids.includes(asset.id)) throw Error('Already staged in the prepared snapshot. Refresh online to review current status.');
      if (asset.last_known_status !== 'Available') throw Error('Last-known status was not Available. Review current stock online.');
      await props.queue(selected, asset.id);
      if (id !== epoch.current) return;
      setMessage(`Queued — not confirmed: ${asset.label || asset.sku}. Use pending movements Retry when online.`); setCode('');
    } catch (e) { if (id === epoch.current) setMessage((e as Error).message); }
    finally { flight.current = false; if (id === epoch.current) setBusy(false); }
  };
  const row = rows.find(r => r.eventId === selected);
  return <section className="p-3 bg-sky-50 border-b border-sky-200">
    {!online && <p role="status">Offline — use Offline scanning. Other screens need a connection and may show incomplete data.</p>}
    <button type="button" disabled={busy} className="px-4 py-2 rounded bg-sky-700 text-white" onClick={() => { setCamera(false); setOpen(!open); }}>{open ? 'Close offline scanning' : 'Offline scanning'}</button>
    {open && <div role="region" aria-label="Offline scanning workspace" className="mt-3 p-4 rounded border border-sky-300 space-y-3 break-words">
      <h2 className="text-xl font-bold">Prepared event scanning</h2>
      <p>Only independent unit-stock additions to Requirements are supported here. Dispatch, returns, kits, quantities, consumables, supplier balances and RFID batches need their online workflows.</p>
      <label className="block">Event to prepare<select aria-label="Event to prepare" value={eventId} disabled={!online || busy} onChange={e => setEventId(e.target.value)} className="block w-full min-w-0 p-2 border rounded">
        <option value="">Select an online event</option>{props.events.filter(e => !e.isAudit && (!e.lifecycle_state || e.lifecycle_state === 'open')).map(e => <option key={e.id} value={e.id}>{e.conferenceName}</option>)}
      </select></label>
      <button type="button" disabled={!online || busy || !eventId} onClick={prepare} className="p-2 border rounded">Prepare this event for offline scanning</button>
      {!rows.length && <p>No prepared offline data for this account. Connect and prepare an event first.</p>}
      <label className="block">Prepared event<select aria-label="Prepared event" disabled={busy} value={selected || ''} onChange={e => { setSelected(Number(e.target.value)); setCamera(false); setMessage(''); }} className="block w-full min-w-0 p-2 border rounded">
        <option value="">Select prepared data</option>{rows.map(r => <option key={r.eventId} value={r.eventId}>{r.package?.event.name || `Event ${r.eventId}`} — {r.state}</option>)}
      </select></label>
      {row?.package && <p>Last-known snapshot: {row.package.generated_at}. Valid until {row.package.expires_at}. Status and availability may have changed. Refresh preparation online before another session.</p>}
      {row && row.state !== 'ready' && <p role="alert">Prepared data {row.state}. Prepare again online before new scans.</p>}
      <form onSubmit={e => { e.preventDefault(); void scan(code); }} className="flex flex-wrap gap-2">
        <input aria-label="Offline equipment code" value={code} onChange={e => setCode(e.target.value)} disabled={!selected || row?.state !== 'ready'} className="w-full min-w-0 p-2 border rounded" />
        <button disabled={!selected || row?.state !== 'ready'} className="p-2 border rounded">Queue scanned item</button>
        <button type="button" disabled={!selected || row?.state !== 'ready'} onClick={() => setCamera(true)} className="p-2 border rounded">Offline camera</button>
      </form>
      <p role="status">{message}</p>
      {camera && <Scanner onScan={scan} onClose={() => setCamera(false)} />}
    </div>}
  </section>;
}
