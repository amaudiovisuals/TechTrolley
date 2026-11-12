import React from 'react';
import { setWorkBlocker } from '../state/workSafety';

type Contact = { id: number; revision: number; name: string; billing_address?: string; address?: string;
  gst_number?: string; contact_person?: string; contact_phone?: string; contact_email?: string };
type Kind = 'customers' | 'venues';
export function SavedContacts({ form, onChange, apiFetch, canSave }: {
  key?: string; form: any; onChange: (patch: Record<string, string>) => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>; canSave: boolean;
}) {
  return <section aria-label="Saved customers and venues" className="rounded-xl border border-slate-200 bg-white text-slate-900 p-4 space-y-4 min-w-0">
    <h3 className="font-bold">Saved customers and delivery addresses</h3>
    <p className="text-sm">Select saved details to fill this program. Later changes to the address book leave earlier programs and issued challans unchanged.</p>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ContactPicker kind="customers" {...{ form, onChange, apiFetch, canSave }} />
      <ContactPicker kind="venues" {...{ form, onChange, apiFetch, canSave }} />
    </div>
  </section>;
}

function ContactPicker({ kind, form, onChange, apiFetch, canSave }: {
  kind: Kind; form: any; onChange: (patch: Record<string, string>) => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>; canSave: boolean;
}) {
  const customer = kind === 'customers';
  const [query, setQuery] = React.useState(''), [rows, setRows] = React.useState<Contact[]>([]);
  const [selected, setSelected] = React.useState<Contact | null>(null), [venueName, setVenueName] = React.useState('');
  const [error, setError] = React.useState(''), [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false), [loading, setLoading] = React.useState(false), [reload, setReload] = React.useState(0);
  const flight = React.useRef(false);
  React.useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      apiFetch(`/api/saved-${kind}/?search=${encodeURIComponent(query)}`).then(async response => {
        const data = await response.json();
        if (!response.ok) throw Error(data.detail || 'Saved details could not load.');
        if (!Array.isArray(data)) throw Error('Saved details could not be read.');
        if (current) setRows(data);
      }).catch(e => { if (current) { setRows([]); setError(e.message); } }).finally(() => { if (current) setLoading(false); });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [apiFetch, kind, query, reload]);
  React.useEffect(() => {
    const key = `saved-contact:${kind}`; setWorkBlocker(key, busy);
    return () => setWorkBlocker(key, false);
  }, [busy, kind]);
  function use(row: Contact) {
    setSelected(row); setNotice('');
    if (customer) onChange({ association_name: row.name, billing_address: row.billing_address || '', gst_number: row.gst_number || '',
      contact_person: row.contact_person || '', contact_phone: row.contact_phone || '', contact_email: row.contact_email || '' });
    else { setVenueName(row.name); onChange({ transport_address: row.address || '' }); }
  }
  async function save(update: boolean) {
    if (flight.current || !canSave || (update && !selected)) return;
    flight.current = true; setBusy(true); setError(''); setNotice('');
    const body = customer ? { name: form.association_name || '', billing_address: form.billing_address || '', gst_number: form.gst_number || '',
      contact_person: form.contact_person || '', contact_phone: form.contact_phone || '', contact_email: form.contact_email || '' }
      : { name: venueName, address: form.transport_address || '' };
    try {
      const response = await apiFetch(`/api/saved-${kind}/${update ? `${selected!.id}/` : ''}`, {
        method: update ? 'PATCH' : 'POST', body: JSON.stringify({ ...body, ...(update ? { expected_revision: selected!.revision } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : Object.entries(data).map(([key, value]) => `${key}: ${value}`).join('\n'));
      setSelected(data); setReload(n => n + 1);
      setNotice(`${customer ? 'Customer' : 'Named delivery address'} saved. Save the program separately to keep its filled details.`);
    } catch (e) { setError((e as Error).message); }
    finally { flight.current = false; setBusy(false); }
  }
  const noun = customer ? 'customer' : 'delivery address';
  const plural = customer ? 'customers' : 'delivery addresses';
  return <div className="rounded-lg border border-slate-200 p-3 space-y-3 min-w-0">
    <label className="block text-sm font-bold">Find saved {noun}
      <input aria-label={`Find saved ${noun}`} type="search" disabled={busy} value={query} onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} placeholder={customer ? 'Search name, GST or billing address' : 'Search venue name or address'} className="block w-full rounded border p-2 mt-1" />
    </label>
    {loading && <p role="status" className="text-sm">Loading saved {plural}…</p>}
    <div className="max-h-40 overflow-auto space-y-1">
      {rows.map(row => <button key={row.id} type="button" disabled={busy} onClick={() => use(row)} aria-label={`Use ${noun} ${row.name}`}
        className="block w-full text-left rounded border border-slate-200 p-2 text-sm hover:bg-sky-50 break-words">
        <strong>{row.name}</strong><span className="block">{customer ? [row.gst_number, row.billing_address].filter(Boolean).join(' · ') : row.address}</span>
      </button>)}
    </div>
    {!loading && !error && !rows.length && <p className="text-sm">No saved {plural} found. Enter the details below to save one.</p>}
    {!customer && <label className="block text-sm">Name for this delivery address
      <input aria-label="Name for this delivery address" value={venueName} disabled={busy} onChange={e => setVenueName(e.target.value)} maxLength={200} placeholder="For example: Hotel — main hall" className="block w-full rounded border p-2 mt-1" />
    </label>}
    {canSave && <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => save(false)} className="rounded bg-slate-200 text-slate-900 px-3 py-2 text-sm font-bold">Save {customer ? 'current customer' : 'named delivery address'}</button>
      {selected && <button type="button" disabled={busy} onClick={() => save(true)} className="rounded border border-slate-300 px-3 py-2 text-sm">Update saved {noun}</button>}
    </div>}
    <button type="button" disabled={busy} onClick={() => setReload(n => n + 1)} className="text-sm underline">Reload saved {plural}</button>
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-800 whitespace-pre-wrap">{error}</p>}
  </div>;
}
