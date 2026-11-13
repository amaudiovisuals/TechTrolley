import React from 'react';
import { clearPendingDelivery, deliveryPendingKey, readPendingDelivery, savePendingDelivery, validDeliveryRequest, type DeliveryIssueRequest, type SupplierPaperDetails } from '../state/programDeliveryDrafts';
import { setWorkBlocker } from '../state/workSafety';

type Party = { name: string; address?: string; gst_number?: string; phone?: string; email?: string; website?: string };
type Row = { key: string; asset_id?:number; name: string; sku: string; serial: string; quantity: number; owner_id: number | null; owner: Party | null };
type Paper = { number: string; reference: string; direction: 'customer' | 'supplier'; issuer: Party; recipient: Party; rows: Row[];
  truck_id?: number | null;
  dispatch_origins?: { kind: string; name: string; address: string; asset_ids: number[]; asset_quantities?:Record<string,number> }[];
  delivery_date: string; vehicle_number: string; driver_phone: string; destination: string; program: { name: string; start_date: string; end_date: string } };
type Delivery = { id: number; reference: string; issued_at: string; issued_by: string; voided_at: string | null; void_reason: string;
  snapshot: { customer_document: Paper; supplier_documents: Paper[]; replaces_delivery_id?: number; correction_reason?: string } };
type Preview = { source_hash: string; suggested_reference: string; previously_delivered: Record<string, number>;
  source: { rows: Row[]; issuer: Party; customer: Party; vehicle_number: string; driver_phone: string;
    replaces_delivery_id?: number; supplier_defaults?: Record<string, Paper> } };
type Selection = { name: string; quantity: number; checked: boolean };

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// This HTML is also the print source. Every business string is escaped; there
// are no scripts, remote resources, live lookups or local draft dependencies.
export function deliveryPaperHtml(paper: Paper, delivery: Delivery): string {
  const party = (p: Party) => `<strong>${escape(p.name)}</strong><div>${escape(p.address)}</div>${p.gst_number ? `<div>GST: ${escape(p.gst_number)}</div>` : ''}${p.phone ? `<div>${escape(p.phone)}</div>` : ''}`;
  const sections = new Map<string, Row[]>();
  for (const row of paper.rows) {
    const section = paper.direction === 'supplier' ? 'Equipment' : row.owner_id ? `Subrental: ${row.owner?.name || ''}` : `${paper.issuer.name} — Owned inventory / manual additions`;
    sections.set(section, [...(sections.get(section) || []), row]);
  }
  let index = 0;
  const rows = Array.from(sections, ([section, items]) => `<tr><th colspan="5" class="section">${escape(section)}</th></tr>${items.map(row => `<tr><td>${++index}</td><td>${escape(row.name)}</td><td>${escape(row.sku)}</td><td>${escape(row.serial)}</td><td class="qty">${row.quantity}</td></tr>`).join('')}`).join('');
  const copies = ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(paper.number)}</title><style>
    @page { size: A4; margin: 14mm; } * { box-sizing: border-box; } body { margin: 0; color: #111; background: white; font: 12px Arial, sans-serif; }
    article { padding: 20px; } article + article { break-before: page; } h1 { font-size: 20px; margin: 12px 0; } h2 { font-size: 14px; }
    .copy { text-align: right; font-size: 10px; } .meta, .parties { display: flex; justify-content: space-between; gap: 20px; margin: 12px 0; }
    .parties > div { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #888; padding: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; table-layout: fixed; } th, td { border: 1px solid #888; padding: 7px; text-align: left; overflow-wrap: anywhere; }
    thead { display: table-header-group; } tr { break-inside: avoid; } th:first-child { width: 7%; } th:last-child { width: 10%; } .section { background: #eee; } .qty { text-align: right; }
    .signatures { display: flex; justify-content: space-between; margin-top: 50px; } .void { border: 3px solid #a00; padding: 10px; color: #a00; }
    @media print { article { padding: 0; } }
  </style></head><body>${copies.map(copy => `<article><div class="copy">${copy}</div>${delivery.voided_at ? `<div class="void">VOID — ${escape(delivery.void_reason)}</div>` : ''}
    <h1>DELIVERY CHALLAN</h1><div class="meta"><strong>${escape(paper.number)}</strong><span>Date: ${escape(paper.delivery_date)}</span></div>
    <div>Delivery: ${escape(paper.reference)}</div><div>Program: ${escape(paper.program.name)}${paper.program.start_date || paper.program.end_date ? ` (${escape(paper.program.start_date)} to ${escape(paper.program.end_date)})` : ''}</div>
    <div class="parties"><div><h2>From</h2>${party(paper.issuer)}</div><div><h2>To / Service receiver</h2>${party(paper.recipient)}</div></div>
    ${paper.dispatch_origins?.length ? `<div style="white-space:pre-wrap;overflow-wrap:anywhere"><h2>Dispatched from</h2>${paper.dispatch_origins.map(origin => `<div><strong>${escape(origin.name)}</strong><div>${escape(origin.address || 'Address not recorded')}</div>${origin.asset_quantities ? `<div>Equipment: ${paper.rows.filter(row=>origin.asset_ids.includes(row.asset_id!)).map(row=>`${escape(row.sku || row.name)} × ${origin.asset_quantities![String(row.asset_id)]}`).join(', ')}</div>` : ''}</div>`).join('')}</div>` : ''}
    <div>Place of supply / delivery address: ${escape(paper.destination)}</div><div class="meta"><span>Vehicle: ${escape(paper.vehicle_number)}</span><span>Driver phone: ${escape(paper.driver_phone)}</span></div>
    <table><thead><tr><th>No.</th><th>Equipment</th><th>SKU</th><th>Serial number</th><th>Qty</th></tr></thead><tbody>${rows}</tbody></table>
    <p>Total quantity: ${paper.rows.reduce((sum, row) => sum + row.quantity, 0)}</p><p>Equipment supplied on rental / returnable basis. This document is not a tax invoice.</p>
    <div class="signatures"><span>Issued by: ${escape(delivery.issued_by)}</span><span>Received by / signature</span></div>
  </article>`).join('')}</body></html>`;
}

export const ProgramDeliveries: React.FC<{
  conferenceId: string; truckId?: number | string; accountId: string; canIssue: boolean; locked?: boolean; canCorrect?: boolean;
  apiFetch: (url: string, options?: any) => Promise<Response>; apiBase: string;
}> = ({ conferenceId, truckId, accountId, canIssue, locked = false, canCorrect = false, apiFetch, apiBase }) => {
  const endpoint = `${apiBase}/api/conferences/${conferenceId}/deliveries/`;
  const [deliveries, setDeliveries] = React.useState<Delivery[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [selected, setSelected] = React.useState<Record<string, Selection>>({});
  const [reference, setReference] = React.useState('');
  const [correctionReason, setCorrectionReason] = React.useState('');
  const [deliveryDate, setDeliveryDate] = React.useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const [vehicle, setVehicle] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [supplierDetails, setSupplierDetails] = React.useState<Record<string, SupplierPaperDetails>>({});
  const [editingSupplier, setEditingSupplier] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [recoveryReady, setRecoveryReady] = React.useState(false);
  const [storageError, setStorageError] = React.useState('');
  const [opened, setOpened] = React.useState<{ delivery: Delivery; paper: Paper } | null>(null);
  const [voidId, setVoidId] = React.useState<number | null>(null);
  const [voidReason, setVoidReason] = React.useState('');
  const requestRef = React.useRef<DeliveryIssueRequest | null>(null);
  const pendingKey = React.useMemo(() => accountId ? deliveryPendingKey(window.location.origin, accountId, conferenceId, truckId) : '', [accountId, conferenceId, truckId]);
  const busyRef = React.useRef(false);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [printReadyFor, setPrintReadyFor] = React.useState('');
  const printKey = opened ? `${opened.paper.number}:${opened.delivery.voided_at || ''}` : '';

  async function json(response: Response) {
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : Array.isArray(body) && body.every(entry => typeof entry === 'string') ? body.join(' ') : JSON.stringify(body));
    return body;
  }
  const reload = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const saved = await json(await apiFetch(endpoint));
      if (!Array.isArray(saved)) throw new Error('Invalid saved delivery response.');
      setDeliveries(saved);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [endpoint, apiFetch]);
  React.useEffect(() => { void reload(); }, [reload]);
  React.useEffect(() => {
    requestRef.current = null; setPending(false); setPreview(null); setOpened(null); setStorageError(''); setRecoveryReady(false);
    try {
      if (!pendingKey) throw Error('Sign in again before issuing a delivery.');
      requestRef.current = readPendingDelivery(localStorage, pendingKey);
      setPending(Boolean(requestRef.current));
      setRecoveryReady(true);
    } catch (e) { setStorageError(`Delivery recovery is unavailable: ${(e as Error).message}`); }
  }, [pendingKey]);
  React.useEffect(() => {
    const key = `delivery-review:${pendingKey}`;
    const active = Boolean(preview || pending || busy || storageError);
    setWorkBlocker(key, active);
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    if (active) window.addEventListener('beforeunload', warn);
    return () => { setWorkBlocker(key, false); window.removeEventListener('beforeunload', warn); };
  }, [pendingKey, preview, pending, busy, storageError]);

  async function start(replaces?: number) {
    if (busyRef.current || pending || !recoveryReady || storageError) return;
    setBusy(true); setError(''); setOpened(null);
    try {
      const query = new URLSearchParams();
      if (truckId) query.set('truck_id', String(truckId));
      if (replaces) query.set('replaces_delivery_id', String(replaces));
      const data: Preview = await json(await apiFetch(`${endpoint}preview/${query.size ? `?${query}` : ''}`));
      setPreview(data); setReference(data.suggested_reference); setVehicle(data.source.vehicle_number); setPhone(data.source.driver_phone);
      setCorrectionReason('');
      setEditingSupplier(null);
      setSupplierDetails(Object.fromEntries(data.source.rows.filter(row => row.owner_id && row.owner).map(row => {
        const original = data.source.supplier_defaults?.[String(row.owner_id)];
        const issuer = original?.issuer || row.owner!;
        const recipient = original?.recipient || data.source.issuer;
        return [String(row.owner_id), {
          issuer_name: issuer.name, issuer_address: issuer.address || '', issuer_gst_number: issuer.gst_number || '',
          recipient_name: recipient.name, recipient_address: recipient.address || '', recipient_gst_number: recipient.gst_number || '',
          destination: original?.destination ?? data.source.issuer.address ?? '',
          vehicle_number: original?.vehicle_number || '', driver_phone: original?.driver_phone || '',
        }];
      })));
      setSelected(Object.fromEntries(data.source.rows.map(row => {
        const remaining = Math.max(0, row.quantity - (data.previously_delivered[row.key] || 0));
        return [row.key, { name: row.name, quantity: remaining || row.quantity, checked: remaining > 0 }];
      })));
      requestRef.current = null; setPending(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function issue() {
    if (busyRef.current || (!preview && !requestRef.current) || !recoveryReady || storageError) return;
    busyRef.current = true; setBusy(true); setError('');
    if (!requestRef.current && preview) requestRef.current = {
      request_key: crypto.randomUUID(), source_hash: preview.source_hash, truck_id: truckId ? Number(truckId) : null,
      reference, delivery_date: deliveryDate, vehicle_number: vehicle, driver_phone: phone,
      ...(preview.source.replaces_delivery_id ? { replaces_delivery_id: preview.source.replaces_delivery_id, correction_reason: correctionReason.trim() } : {}),
      supplier_details: Object.fromEntries(Object.entries(supplierDetails).filter(([owner]) => preview.source.rows.some(row => String(row.owner_id) === owner && selected[row.key]?.checked))),
      rows: (Object.entries(selected) as [string, Selection][]).filter(([, row]) => row.checked).map(([key, row]) => ({ key, name: row.name, quantity: row.quantity })),
    };
    const request = requestRef.current!;
    if (!validDeliveryRequest(request)) {
      requestRef.current = null; setPending(false); setError('Review the delivery date, quantities and details before issuing.');
      busyRef.current = false; setBusy(false); return;
    }
    try {
      try { savePendingDelivery(localStorage, pendingKey, request); }
      catch (e) { setStorageError(`No delivery was sent: ${(e as Error).message}`); throw e; }
      setPending(true);
      const response = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(request) });
      // Authentication/transport/server failures can follow an earlier committed
      // attempt. Keep the exact request until its save is positively recovered.
      if ([400, 404, 409].includes(response.status)) {
        clearPendingDelivery(localStorage, pendingKey, request.request_key);
        requestRef.current = null; setPending(false);
      }
      const saved: Delivery = await json(response);
      if (!saved || !Number.isInteger(saved.id) || saved.reference !== request.reference.trim() ||
          !saved.snapshot?.customer_document?.number || !Array.isArray(saved.snapshot.customer_document.rows) ||
          !Array.isArray(saved.snapshot.supplier_documents)) {
        throw Error('The save reply was incomplete. Retry the same delivery to recover its saved number.');
      }
      clearPendingDelivery(localStorage, pendingKey, request.request_key);
      setPreview(null); requestRef.current = null; setPending(false);
      setOpened({ delivery: saved, paper: saved.snapshot.customer_document });
      await reload();
    } catch (e) { setPending(!!requestRef.current); setError((e as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function voidSaved() {
    if (!voidId || !voidReason.trim() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await json(await apiFetch(`${endpoint}${voidId}/void/`, { method: 'POST', body: JSON.stringify({ reason: voidReason }) }));
      setVoidId(null); setVoidReason(''); setOpened(null); await reload();
    } catch (e) { setError((e as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const button = 'px-4 py-2 rounded-lg bg-slate-800 text-white text-sm disabled:opacity-50';
  return <section className="print:hidden bg-white text-slate-800 rounded-xl border border-slate-300 p-5 mb-6 space-y-4" aria-label="Saved delivery challans">
    <h2 className="font-bold text-lg">Saved delivery challans</h2>
    <p className="text-sm">Issue once for each delivery to automatically save the customer challan and each supplier → issuing company challan. Company details and supplier equipment fill automatically. Reprints reuse the saved numbers; opening or printing a paper does not create another delivery.</p>
    <div className="flex gap-3">
      {canIssue && !locked && <button className={button} disabled={busy || loading || pending || !recoveryReady || Boolean(storageError)} onClick={() => start()}>New delivery{truckId ? ' for this truck' : ''}</button>}
      <button className={button} disabled={busy || loading} onClick={reload}>Reload saved deliveries</button>
    </div>
    {loading && <p role="status">Loading saved deliveries…</p>}
    {error && <p role="alert" className="text-red-700 whitespace-pre-wrap">{error}</p>}
    {storageError && <p role="alert" className="text-red-700 whitespace-pre-wrap">{storageError}</p>}
    {pending && !preview && <div className="border border-amber-400 p-3 space-y-2">
      <p role="alert">A delivery save is awaiting confirmation: {requestRef.current?.reference}. Recover the same request before starting another delivery.</p>
      {canIssue && <button className={button} disabled={busy || Boolean(storageError)} onClick={issue}>{busy ? 'Recovering…' : 'Retry saving same delivery'}</button>}
    </div>}
    {!loading && !deliveries.length && <p>No saved deliveries yet. Existing challans remain available below.</p>}
    {deliveries.map(delivery => <div key={delivery.id} className="border border-slate-200 rounded-lg p-3 space-y-2">
      <p className="font-bold">{delivery.reference} — {delivery.snapshot.customer_document.delivery_date}{delivery.voided_at ? ' — VOID' : ''}</p>
      {delivery.voided_at && <p>Reason: {delivery.void_reason}</p>}
      {delivery.snapshot.replaces_delivery_id && <p>Replacement for delivery {delivery.snapshot.replaces_delivery_id} · {delivery.snapshot.correction_reason}</p>}
      <div className="flex flex-wrap gap-2">{[delivery.snapshot.customer_document, ...delivery.snapshot.supplier_documents].map(paper =>
        <button key={paper.number} className={button} onClick={() => { setOpened({ delivery, paper }); setPreview(null); }} disabled={pending}>
          {paper.direction === 'customer' ? 'Customer' : paper.issuer.name} — {paper.number}
        </button>)}
        {canIssue && (!locked || canCorrect) && !delivery.voided_at && <button className="text-red-700 underline px-3" disabled={busy} onClick={() => { setVoidId(delivery.id); setVoidReason(''); }}>Void delivery</button>}
        {canCorrect && delivery.voided_at && !deliveries.some(d => d.snapshot.replaces_delivery_id === delivery.id) &&
          (delivery.snapshot.customer_document.truck_id ?? null) === (truckId ? Number(truckId) : null) &&
          <button className={button} disabled={busy || pending || !recoveryReady || Boolean(storageError)} onClick={() => start(delivery.id)}>Prepare replacement</button>}
      </div>
    </div>)}
    {voidId && <div className="p-3 border border-red-300 space-y-2">
      <p>Void both directions of this delivery. Saved copies and numbers will remain visible. This does not return equipment.</p>
      <input aria-label="Void reason" className="border p-2 w-full" maxLength={500} value={voidReason} onChange={e => setVoidReason(e.target.value)} />
      <button className={button} disabled={busy || !voidReason.trim()} onClick={voidSaved}>Confirm void</button>{' '}
      <button className={button} disabled={busy} onClick={() => setVoidId(null)}>Cancel</button>
    </div>}
    {preview && <div className="border border-sky-300 p-4 space-y-4">
      <h3 className="font-bold">{preview.source.replaces_delivery_id ? 'Review the replacement challans' : 'Review this delivery before issuing'}</h3>
      <p className="text-sm">From {preview.source.issuer.name} to {preview.source.customer.name}. Supplier papers fill from the saved supplier and issuing-company details, with blank vehicle/driver fields and the issuing-company address as the delivery address. Equipment and quantities only; rental charges are separate.</p>
      <p className="text-sm">Select only equipment in this delivery. Previously delivered quantities start unselected; select them explicitly if the equipment is being delivered again. Ticket equipment is selected from the program view.</p>
      <fieldset disabled={busy || pending} className="space-y-3">
        {preview.source.replaces_delivery_id && <label>Correction reason <input className="border p-2" maxLength={500} value={correctionReason} onChange={event => setCorrectionReason(event.target.value)} /></label>}
        <div className="flex flex-wrap gap-3">
          <label>Delivery reference <input className="border p-2" value={reference} maxLength={100} onChange={e => setReference(e.target.value)} /></label>
          <label>Delivery date <input className="border p-2" type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} /></label>
          <label>Vehicle <input className="border p-2" value={vehicle} maxLength={50} onChange={e => setVehicle(e.target.value)} /></label>
          <label>Driver phone <input className="border p-2" value={phone} maxLength={50} onChange={e => setPhone(e.target.value)} /></label>
        </div>
        {(Object.entries(supplierDetails) as [string, SupplierPaperDetails][]).filter(([owner]) => preview.source.rows.some(row => String(row.owner_id) === owner && selected[row.key]?.checked)).map(([owner, details]) => <section key={owner} aria-label={`Supplier paper ${owner}`} className="rounded-lg border border-slate-300 bg-slate-50 text-slate-900 p-3 space-y-3 min-w-0">
          <h4 className="font-bold">Supplier challan — {details.issuer_name}</h4>
          <p className="text-sm">Only this supplier’s selected equipment is included. The program and dates match the customer challan. These edits apply to this delivery paper only.</p>
          <button type="button" className={button} onClick={() => setEditingSupplier(editingSupplier === owner ? null : owner)}>{editingSupplier === owner ? 'Done editing supplier details' : 'Edit supplier details'}</button>
          {editingSupplier === owner ? <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{([
            ['issuer_name', 'Supplier name', 200], ['issuer_address', 'Supplier address', 4000], ['issuer_gst_number', 'Supplier GST', 20],
            ['recipient_name', 'Service receiver name', 200], ['recipient_address', 'Service receiver address', 4000], ['recipient_gst_number', 'Service receiver GST', 20],
            ['destination', 'Place of supply / delivery address', 4000], ['vehicle_number', 'Supplier vehicle', 50], ['driver_phone', 'Supplier driver phone', 50],
          ] as [keyof SupplierPaperDetails, string, number][]).map(([key, title, limit]) => <label key={key} className="block text-sm min-w-0">{title}
            {key.endsWith('address') || key === 'destination'
              ? <textarea aria-label={`${title} ${owner}`} className="block border p-2 w-full rounded" maxLength={limit} value={details[key]} onChange={e => setSupplierDetails(prev => ({ ...prev, [owner]: { ...prev[owner], [key]: e.target.value } }))} />
              : <input aria-label={`${title} ${owner}`} className="block border p-2 w-full rounded" maxLength={limit} value={details[key]} onChange={e => setSupplierDetails(prev => ({ ...prev, [owner]: { ...prev[owner], [key]: e.target.value } }))} />}
          </label>)}</div> : <dl className="text-sm space-y-2 whitespace-pre-wrap break-words">
            <div><dt className="font-bold">From</dt><dd>{details.issuer_name}{'\n'}{details.issuer_address}{details.issuer_gst_number ? `\nGST: ${details.issuer_gst_number}` : ''}</dd></div>
            <div><dt className="font-bold">To / Service receiver</dt><dd>{details.recipient_name}{'\n'}{details.recipient_address}{details.recipient_gst_number ? `\nGST: ${details.recipient_gst_number}` : ''}</dd></div>
            <div><dt className="font-bold">Place of supply / delivery address</dt><dd>{details.destination || 'Address not entered'}</dd></div>
            <div><dt className="font-bold">Vehicle / driver phone</dt><dd>{details.vehicle_number || '—'} / {details.driver_phone || '—'}</dd></div>
          </dl>}
        </section>)}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Select</th><th>Equipment / owner</th><th>Quantity</th><th>Already delivered</th></tr></thead>
          <tbody>{preview.source.rows.map(row => <tr key={row.key} className="border-t">
            <td><input type="checkbox" aria-label={`Include ${row.sku || row.name}`} checked={selected[row.key]?.checked || false} onChange={e => setSelected(prev => ({ ...prev, [row.key]: { ...prev[row.key], checked: e.target.checked } }))} /></td>
            <td className="p-2"><input aria-label={`Description ${row.sku || row.name}`} className="border p-2 w-full" maxLength={500} value={selected[row.key]?.name || ''} onChange={e => setSelected(prev => ({ ...prev, [row.key]: { ...prev[row.key], name: e.target.value } }))} />
              <div>{row.sku} / {row.serial} — {row.owner?.name || preview.source.issuer.name}</div></td>
            <td><input aria-label={`Quantity ${row.sku || row.name}`} type="number" min={1} max={row.quantity} step={1} className="border p-2 w-24" value={selected[row.key]?.quantity ?? 1} onChange={e => setSelected(prev => ({ ...prev, [row.key]: { ...prev[row.key], quantity: Number(e.target.value) } }))} /> / {row.quantity}</td>
            <td>{preview.previously_delivered[row.key] || 0}</td>
          </tr>)}</tbody></table></div>
      </fieldset>
      {pending && <p role="alert">The save result could not be confirmed. Retry the same delivery to recover its saved number.</p>}
      <button className={button} disabled={busy || !(Object.values(selected) as Selection[]).some(row => row.checked)} onClick={issue}>{busy ? 'Saving…' : pending ? 'Retry saving same delivery' : 'Issue delivery challans'}</button>{' '}
      <button className={button} disabled={busy || pending} onClick={() => setPreview(null)}>Close preview</button>
    </div>}
    {opened && <div className="space-y-3">
      <h3 className="font-bold">{opened.paper.number} — saved copy</h3>
      <p className="text-sm">Issued details are preserved for reprints. To correct an issued delivery, void it with a reason and issue a replacement.</p>
      <button className={button} disabled={printReadyFor !== printKey} onClick={() => { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); }}>Print / save PDF (3 copies)</button>{' '}
      <button className={button} onClick={() => setOpened(null)}>Close saved copy</button>
      <iframe key={printKey} ref={frame} onLoad={() => setPrintReadyFor(printKey)} sandbox="allow-same-origin allow-modals" title={`Saved challan ${opened.paper.number}`} className="w-full border border-slate-300 bg-white" style={{ height: 650 }} srcDoc={deliveryPaperHtml(opened.paper, opened.delivery)} />
    </div>}
  </section>;
}
