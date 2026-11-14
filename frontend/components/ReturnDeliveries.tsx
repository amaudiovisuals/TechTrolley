import { useCallback, useEffect, useRef, useState, type FormEvent, type FC } from 'react';
import { setWorkBlocker } from '../state/workSafety';

type ReturnRow = {
  key: string;
  sku: string;
  name: string;
  quantity: number;
  type: string;
  owner: { name: string };
  unit_value: string;
  packed_at: string;
};
type Transport = {
  reference: string;
  return_date: string;
  origin: string;
  destination: string;
  vehicle_number: string;
  driver_phone: string;
};
type ReturnRequest = Transport & { request_key: string; source_hash: string; rows: string[] };
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
  const [transport, setTransport] = useState<Transport | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<ReturnRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<SavedReturn | null>(null);
  const [printReady, setPrintReady] = useState(false);
  const selectedUnits = preview?.source.rows.reduce((sum, row) => sum + (selection.has(row.key) ? row.quantity : 0), 0) ?? 0;
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
        if (typeof request?.request_key !== 'string' || !Array.isArray(request.rows)) {
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
      setTransport({ reference, return_date, origin, destination, vehicle_number: '', driver_phone: '' });
      setSelection(new Set());
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function issue(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current || !canIssue || !ready) return;
    const request = pending ?? (preview && transport && selection.size > 0 ? {
      ...transport, request_key: crypto.randomUUID(), source_hash: preview.source_hash, rows: [...selection],
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
      const delivery: SavedReturn = await readJson(response);
      if (!delivery.id || !delivery.number || !delivery.snapshot?.rows?.length) {
        throw Error('Save confirmation is incomplete. Retry to recover the same return challan.');
      }
      localStorage.removeItem(key);
      setPending(null);
      setPreview(null);
      setSaved(previousRows => [delivery, ...previousRows.filter(row => row.id !== delivery.id)]);
      openPaper(delivery);
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
      <span className="ml-2 text-sm text-slate-700">{delivery.snapshot.reference} · {delivery.snapshot.return_date}</span>
    </li>)}</ul>}
    {preview && transport && !pending && <form onSubmit={issue} className="space-y-3 border-t border-slate-200 pt-3">
      <p className="text-sm">Select the Packup records for this return trip. Crosscheck verification follows the usual workflow.</p>
      {!preview.source.rows.length && <p className="text-sm">No unused Packup records for warehouse equipment. Scan the items in Packup first.</p>}
      {preview.source.rows.length > 0 && <>
        <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          {fields.map(({ key: field, label, max, required }) => <label key={field} className="grid gap-1 text-sm">
            {label}
            {field === 'origin' || field === 'destination'
              ? <textarea aria-label={label} value={transport[field]} maxLength={max} required={required} rows={2}
                  onChange={event => setTransport({ ...transport, [field]: event.target.value })} className="rounded border border-slate-300 p-2" />
              : <input type={field === 'return_date' ? 'date' : 'text'} value={transport[field]} maxLength={max} required={required}
                  onChange={event => setTransport({ ...transport, [field]: event.target.value })} className="rounded border border-slate-300 p-2" />}
          </label>)}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={button} disabled={busy || preview.source.rows.length > 2500}
            onClick={() => setSelection(new Set(preview.source.rows.map(row => row.key)))}>Select all Packup records</button>
          <button type="button" className={button} disabled={busy || !selection.size}
            onClick={() => setSelection(new Set())}>Clear selection</button>
          <span className="text-sm">{selectedUnits} units selected</span>
        </div>
        <fieldset disabled={busy} className="max-h-80 space-y-1 overflow-y-auto">
          <legend className="text-sm font-semibold">Recorded Packup items</legend>
          {preview.source.rows.map(row => <label key={row.key} className="flex items-start gap-2 rounded border border-slate-200 p-2 text-sm">
            <input type="checkbox" checked={selection.has(row.key)} onChange={event => {
              const next = new Set(selection);
              if (event.target.checked) next.add(row.key);
              else next.delete(row.key);
              setSelection(next);
            }} />
            <span>{row.name} ({row.sku}) · {row.quantity}<small className="block text-slate-600">{packTime.format(new Date(row.packed_at))}</small></span>
          </label>)}
        </fieldset>
      </>}
      <div className="flex flex-wrap gap-2">
        <button className={button} type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel return review</button>
        <button className={button} disabled={!selection.size || selection.size > 2500 || busy}>Issue return challan ({selectedUnits})</button>
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
