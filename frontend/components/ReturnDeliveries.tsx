import { useCallback, useEffect, useRef, useState, type FormEvent, type FC } from 'react';
import { Scanner } from './Scanner';
import { resolveScan } from '../state/scanIdentity';
import { setWorkBlocker } from '../state/workSafety';

type ReturnRow = {
  key: string;
  sku: string;
  asset_id: number;
  barcode?: string | null;
  qr_code?: string | null;
  serial_number?: string | null;
  name: string;
  quantity: number;
  type: string;
  owner: { name: string };
  unit_value: string;
  packed_at: string;
};
type Trip = { return_date: string; origin: string; destination: string };
type Truck = { reference: string; vehicle_number: string; driver_phone: string };
type Transport = Trip & Truck;
type TruckDraft = Truck & { id: number; rows: Record<string, number> };
type IssueBase = Trip & { source_hash: string; request_key: string };
type ReturnRequest = (IssueBase & Truck & { rows: string[] }) |
  (IssueBase & { loads: (Truck & { rows: { key: string; quantity: number }[] })[] });
type ReturnPreview = {
  source_hash: string;
  source: { rows: ReturnRow[]; reference: string; return_date: string; origin: string; destination: string };
};
type SavedReturn = {
  id: number;
  number: string;
  snapshot: Transport & {
    rows: ReturnRow[];
    issuer: { name: string; address: string; gst_number: string };
    program: { name: string };
    total: string;
    issued_by: string;
  };
};

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const packTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function printHtml(delivery: SavedReturn) {
  const paper = delivery.snapshot;
  const rows = paper.rows.map(row => `<tr><td>${escape(row.name)}${row.owner.name ? `<small>Owner: ${escape(row.owner.name)}</small>` : ''}</td>
    <td>${escape(row.type)}</td><td>${row.quantity}</td><td>${escape(money.format(Number(row.unit_value) * row.quantity))}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${escape(delivery.number)}</title><style>
      @page { size:A4; margin:14mm } body { font:14px system-ui,sans-serif;color:#111;margin:20px }
      h1 { font-size:22px } p { margin:6px 0 } small { display:block;margin-top:4px }
      .address { white-space:pre-wrap;overflow-wrap:anywhere }
      table { border-collapse:collapse;width:100%;margin:18px 0 } th,td { border:1px solid #777;text-align:left;padding:6px;overflow-wrap:anywhere }
      thead { display:table-header-group } tr { break-inside:avoid } .total { text-align:right }
      .signatures { display:flex;justify-content:space-between;gap:16px;margin-top:48px }
      @media print { body { margin:0 } }
    </style></head><body>
    <h1>Return Challan</h1>
    <p><strong>${escape(paper.issuer.name)}</strong></p>
    <p class="address">${escape(paper.issuer.address)}</p>
    ${paper.issuer.gst_number ? `<p>GSTIN: ${escape(paper.issuer.gst_number)}</p>` : ''}
    <p><strong>${escape(delivery.number)}</strong> · ${escape(paper.reference)} · ${escape(paper.return_date)}</p>
    <p>Program: ${escape(paper.program.name)}</p>
    <p class="address"><strong>Returning from:</strong> ${escape(paper.origin)}</p>
    <p class="address"><strong>Receiving godown:</strong> ${escape(paper.destination)}</p>
    ${paper.vehicle_number ? `<p>Vehicle: ${escape(paper.vehicle_number)}</p>` : ''}
    ${paper.driver_phone ? `<p>Driver phone: ${escape(paper.driver_phone)}</p>` : ''}
    <table><thead><tr><th>Alias Name</th><th>Type</th><th>Quantity</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="total"><strong>Grand total: ${escape(money.format(Number(paper.total)))}</strong></p>
    <div class="signatures"><span>Issued by ${escape(paper.issued_by)}</span><span>Received by / signature</span></div>
    </body></html>`;
}

const fields: { key: keyof Transport; label: string; max: number; required?: boolean }[] = [
  { key: 'reference', label: 'Reference', max: 100, required: true },
  { key: 'return_date', label: 'Return date', max: 10, required: true },
  { key: 'origin', label: 'Returning from', max: 4000, required: true },
  { key: 'destination', label: 'Receiving godown', max: 4000, required: true },
  { key: 'vehicle_number', label: 'Return vehicle number', max: 50 },
  { key: 'driver_phone', label: 'Return driver phone', max: 50 },
];

async function readJson(response: Response) {
  const data = await response.json();
  if (!response.ok) throw Error(data?.detail || (Array.isArray(data) ? data.join(' ') : 'Return challan request failed.'));
  return data;
}

const button = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50';

export const ReturnDeliveries: FC<{
  conferenceId: string;
  accountId: string;
  canIssue: boolean;
  apiBase: string;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}> = ({ conferenceId, accountId, canIssue, apiBase, apiFetch }) => {
  const endpoint = `${apiBase}/api/conferences/${conferenceId}/return-deliveries/`;
  const key = ['tt', 'pending-return', window.location.origin, accountId, conferenceId].map(encodeURIComponent).join(':');
  const [saved, setSaved] = useState<SavedReturn[]>([]);
  const [preview, setPreview] = useState<ReturnPreview | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [trucks, setTrucks]: [TruckDraft[], (next: TruckDraft[] | ((previous: TruckDraft[]) => TruckDraft[])) => void] = useState<TruckDraft[]>([]);
  const nextTruckId = useRef(1);
  const [activeTruckId, setActiveTruckId] = useState(1);
  const [query, setQuery] = useState('');
  const [scannedAsset, setScannedAsset] = useState<number | null>(null);
  const [scanError, setScanError] = useState('');
  const [camera, setCamera] = useState(false);
  const [pending, setPending] = useState<ReturnRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<SavedReturn | null>(null);
  const [printReady, setPrintReady] = useState(false);
  const activeTruck = trucks.find(truck => truck.id === activeTruckId);
  const allocated = new Map<string, number>();
  let rowCount = 0;
  for (const truck of trucks) {
    for (const [key, quantity] of Object.entries(truck.rows)) {
      allocated.set(key, (allocated.get(key) ?? 0) + quantity);
      rowCount++;
    }
  }
  const selectedUnits = [...allocated.values()].reduce((sum, count) => sum + count, 0);
  const allRows = preview?.source.rows ?? [];
  const filteredRows = allRows.filter(row => scannedAsset == null
    ? [row.name, row.sku, row.owner.name].some(text => text.toLowerCase().includes(query.trim().toLowerCase()))
    : row.asset_id === scannedAsset);
  const total = (truck: TruckDraft) => Object.values(truck.rows).reduce((sum, count) => sum + count, 0);
  const frame = useRef<HTMLIFrameElement>(null);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    try {
      const rows = await readJson(await apiFetch(endpoint));
      if (!Array.isArray(rows)) throw Error('Invalid saved return challan response.');
      setSaved(rows);
    } catch (e) { setError((e as Error).message); }
  }, [apiFetch, endpoint]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!canIssue) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const request = JSON.parse(raw);
        if (typeof request?.request_key !== 'string' || (!Array.isArray(request.rows) && !Array.isArray(request.loads))) {
          throw Error('A pending return record needs administrator review.');
        }
        setPending(request);
      }
      setReady(true);
    } catch (e) { setError((e as Error).message); }
  }, [key, canIssue]);
  useEffect(() => {
    setWorkBlocker(key, Boolean(preview || pending || busy));
    return () => setWorkBlocker(key, false);
  }, [key, preview, pending, busy]);
  useEffect(() => {
    if (pending || (!preview && !busy)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [preview, pending, busy]);

  function openPaper(delivery: SavedReturn) {
    if (opened?.id !== delivery.id) setPrintReady(false);
    setOpened(delivery);
  }

  async function start() {
    if (inFlight.current || pending || !canIssue || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const data: ReturnPreview = await readJson(await apiFetch(`${endpoint}preview/`));
      const { reference, return_date, origin, destination } = data.source;
      setPreview(data);
      setTrip({ return_date, origin, destination });
      nextTruckId.current = 2;
      setTrucks([{ id: 1, reference, vehicle_number: '', driver_phone: '', rows: {} }]);
      setActiveTruckId(1);
      resetSearch();
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  function resetSearch() {
    setQuery('');
    setScannedAsset(null);
    setScanError('');
  }

  function updateTruck(changes: Partial<TruckDraft>) {
    setTrucks(previous => previous.map(truck => truck.id === activeTruckId ? { ...truck, ...changes } : truck));
  }

  function scan(code: string) {
    setCamera(false);
    const match = resolveScan(code, allRows.map(row => ({
      id: String(row.asset_id), sku: row.sku, barcode: row.barcode ?? undefined,
      qrCode: row.qr_code ?? undefined, serialNumber: row.serial_number ?? undefined,
    })));
    setScannedAsset(match.kind === 'matched' ? Number(match.asset.id) : null);
    setQuery(match.kind === 'matched' ? match.asset.sku : '');
    setScanError(match.kind === 'ambiguous' ? 'This code matches more than one item. Search by SKU to choose the correct item.'
      : match.kind === 'matched' ? '' : 'This code was not found in the available Packup records.');
  }

  function maxForTruck(row: ReturnRow, truck: TruckDraft) {
    return row.quantity - (allocated.get(row.key) ?? 0) + (truck.rows[row.key] ?? 0);
  }

  function assign(row: ReturnRow, quantity: number, truck: TruckDraft) {
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > maxForTruck(row, truck)) return;
    const rows = { ...truck.rows };
    if (quantity === 0) delete rows[row.key];
    else rows[row.key] = quantity;
    updateTruck({ rows });
  }

  async function issue(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current || !canIssue || !ready) return;
    const request = pending ?? (preview && trip && selectedUnits > 0 && trucks.every(truck => total(truck) > 0) ? {
      ...trip, request_key: crypto.randomUUID(), source_hash: preview.source_hash,
      loads: trucks.map(({ reference, vehicle_number, driver_phone, rows }) => ({
        reference, vehicle_number, driver_phone,
        rows: Object.entries(rows).map(([key, quantity]) => ({ key, quantity })),
      })),
    } : null);
    if (!request) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const stored = JSON.stringify(request);
      const previous = localStorage.getItem(key);
      if (previous && previous !== stored) throw Error('Reload this program to recover the return already awaiting confirmation.');
      localStorage.setItem(key, stored);
      if (localStorage.getItem(key) !== stored) throw Error('The browser could not save the return request.');
      setPending(request);
      const response = await apiFetch(endpoint, { method: 'POST', body: stored });
      if ([400, 404, 409].includes(response.status)) {
        localStorage.removeItem(key);
        setPending(null);
        if (response.status === 409) setPreview(null);
      }
      const result = await readJson(response);
      const deliveries: SavedReturn[] = 'loads' in request ? result?.deliveries : [result];
      const count = 'loads' in request ? request.loads.length : 1;
      if (!Array.isArray(deliveries) || deliveries.length !== count ||
          deliveries.some(delivery => !delivery?.id || !delivery?.number || !delivery?.snapshot?.rows?.length)) {
        throw Error('Save confirmation is incomplete. Retry to recover the same return challan.');
      }
      localStorage.removeItem(key);
      setPending(null);
      setPreview(null);
      const ids = new Set(deliveries.map(delivery => delivery.id));
      setSaved(previousRows => [...deliveries, ...previousRows.filter(row => !ids.has(row.id))]);
      openPaper(deliveries[0]);
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section aria-label="Saved return challans" className="no-print mb-5 space-y-4 rounded-xl border border-slate-200 bg-white p-4 text-slate-900">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Saved return challans</h3>
      {canIssue && !preview && !pending && <button className={button} disabled={!ready || busy} onClick={() => void start()}>New return challan</button>}
    </div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {pending && <button className={button} disabled={busy} onClick={() => void issue()}>Retry saving same return challan</button>}
    {!saved.length && <p className="text-sm text-slate-600">No saved return challans yet.</p>}
    {saved.length > 0 && <ul className="space-y-2">{saved.map(delivery => <li key={delivery.id}>
      <button className={button} onClick={() => openPaper(delivery)}>Open {delivery.number}</button>
      <span className="ml-2 text-sm text-slate-700">{delivery.snapshot.reference} · {delivery.snapshot.return_date}{delivery.snapshot.vehicle_number && ` · ${delivery.snapshot.vehicle_number}`} · {delivery.snapshot.rows.reduce((sum, row) => sum + row.quantity, 0)} units</span>
    </li>)}</ul>}
    {preview && trip && activeTruck && !pending && <form onSubmit={issue} className="space-y-3 border-t border-slate-200 pt-3">
      {!allRows.length && <p className="text-sm">Scan equipment in Packup to make it available for a return challan.</p>}
      {allRows.length > 0 && <>
        <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          {fields.filter(field => field.key in trip).map(({ key: field, label, max }) => <label key={field} className="grid gap-1 text-sm">
            {label}
            {field === 'origin' || field === 'destination'
              ? <textarea aria-label={label} value={trip[field]} maxLength={max} required rows={2}
                  onChange={event => setTrip({ ...trip, [field]: event.target.value })} className="rounded border border-slate-300 p-2" />
              : <input type="date" value={trip.return_date} required
                  onChange={event => setTrip({ ...trip, return_date: event.target.value })} className="rounded border border-slate-300 p-2" />}
          </label>)}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2" aria-label="Return trucks">
          {trucks.map((truck, index) => <button key={truck.id} type="button"
            className={`${button} ${truck.id === activeTruckId ? 'border-sky-600 bg-sky-50' : ''}`}
            aria-pressed={truck.id === activeTruckId} onClick={() => setActiveTruckId(truck.id)} disabled={busy}>
            Truck {index + 1} · {total(truck)} units
          </button>)}
          <button type="button" className={button} disabled={busy || trucks.length >= 20} onClick={() => {
            const id = nextTruckId.current++;
            setTrucks([...trucks, { id, reference: `${preview.source.reference} / Truck ${id}`, vehicle_number: '', driver_phone: '', rows: {} }]);
            setActiveTruckId(id);
            resetSearch();
          }}>Add return truck</button>
        </div>
        <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          {fields.filter(field => field.key in activeTruck).map(({ key: field, label, max, required }) => <label key={field} className="grid gap-1 text-sm">
            {label}
            <input value={activeTruck[field as keyof Truck]} maxLength={max}
              required={required || (field === 'vehicle_number' && trucks.length > 1)}
              onChange={event => updateTruck({ [field]: event.target.value })} className="rounded border border-slate-300 p-2" />
          </label>)}
          {trucks.length > 1 && <div><button type="button" className={button} onClick={() => {
            const remaining = trucks.filter(truck => truck.id !== activeTruckId);
            setTrucks(remaining);
            setActiveTruckId(remaining[0].id);
          }}>Remove this truck</button></div>}
        </fieldset>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid flex-1 gap-1 text-sm">Search or scan Packup equipment
            <input value={query} maxLength={2048} className="rounded border border-slate-300 p-2"
              onChange={event => { setQuery(event.target.value); setScannedAsset(null); setScanError(''); }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); scan(query); }
              }} />
          </label>
          <button type="button" className={button} onClick={() => setCamera(true)}>Scan equipment</button>
          {(query || scannedAsset != null) && <button type="button" className={button} onClick={resetSearch}>Clear search</button>}
        </div>
        {camera && <Scanner onScan={scan} onClose={() => setCamera(false)} />}
        {scanError && <p role="status" className="text-sm text-red-700">{scanError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={button} disabled={busy || !filteredRows.length} onClick={() => {
            const rows = { ...activeTruck.rows };
            for (const row of filteredRows) {
              const amount = maxForTruck(row, activeTruck);
              if (amount > 0) rows[row.key] = amount;
            }
            updateTruck({ rows });
          }}>{query ? 'Select matching Packup records' : 'Select all Packup records'}</button>
          <button type="button" className={button} disabled={busy || !total(activeTruck)}
            onClick={() => updateTruck({ rows: {} })}>Clear this truck</button>
          <span className="text-sm">{selectedUnits} units assigned · {allRows.reduce((sum, row) => sum + row.quantity, 0) - selectedUnits} unassigned</span>
        </div>
        <fieldset disabled={busy} className="max-h-80 space-y-1 overflow-y-auto">
          <legend className="text-sm font-semibold">Equipment for Truck {trucks.indexOf(activeTruck) + 1}</legend>
          {!filteredRows.length && <p className="text-sm">No matching Packup equipment.</p>}
          {filteredRows.map(row => {
            const max = maxForTruck(row, activeTruck);
            const quantity = activeTruck.rows[row.key] ?? 0;
            const label = `${row.name} (${row.sku})`;
            return <label key={row.key} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 text-sm">
              <span>{label}<small className="block text-slate-600">{max} available for this truck · {packTime.format(new Date(row.packed_at))}</small></span>
              {row.quantity === 1 ? <input type="checkbox" checked={quantity === 1} disabled={max === 0}
                aria-label={`Assign ${label}`} onChange={event => assign(row, Number(event.target.checked), activeTruck)} />
                : <input type="number" min={0} max={max} step={1} value={quantity} disabled={max === 0}
                  aria-label={`Quantity for ${label}`} className="w-24 rounded border border-slate-300 p-1"
                  onChange={event => assign(row, Number(event.target.value), activeTruck)} />}
            </label>;
          })}
        </fieldset>
      </>}
      <div className="flex flex-wrap gap-2">
        <button className={button} type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel return review</button>
        <button className={button} disabled={!selectedUnits || rowCount > 2500 || busy ||
          trucks.some(truck => !total(truck) || !truck.reference.trim() || (trucks.length > 1 && !truck.vehicle_number.trim()))}>
          {trucks.length === 1 ? `Issue return challan (${selectedUnits})` : `Issue ${trucks.length} return challans (${selectedUnits} units)`}
        </button>
      </div>
    </form>}
    {opened && <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => setOpened(null)}>Close saved return</button>
        <button className={button} disabled={!printReady} onClick={() => {
          frame.current?.contentWindow?.focus();
          frame.current?.contentWindow?.print();
        }}>Print saved return</button>
      </div>
      <iframe key={opened.id} ref={frame} onLoad={() => setPrintReady(true)} title={`Saved return ${opened.number}`}
        sandbox="allow-same-origin allow-modals" className="h-[36rem] w-full border border-slate-200" srcDoc={printHtml(opened)} />
    </div>}
  </section>;
};
