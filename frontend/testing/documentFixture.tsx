// Test-only entry: the browser runner proxies API requests to disposable SQLite.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChallanView } from '../components/ChallanView';
import { mapConference } from '../state/conferences';
import type { Asset } from '../types';

async function api(path: string, method = 'GET', body?: any) {
  const response = await fetch(path, { method, headers: { Authorization: 'Token synthetic-document-token', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error), { definitive: response.status < 500 });
  return result;
}

function Fixture() {
  const [event, setEvent] = useState<any>(null);
  const [tickets, setTickets] = useState<any[]>([]);
  const [toast, setToast] = useState('');
  const refresh = async () => { setEvent(mapConference((await api('/api/conferences/'))[0])); setTickets(await api('/api/subrental-tickets/')); };
  useEffect(() => { refresh(); }, []);
  (window as any).__fixture = { refresh };
  if (!event) return <p>Loading synthetic fixture</p>;
  const assets = event.challan_assets_details.map((a: any) => ({ ...a, id: String(a.id), aliasName: a.alias_name,
    serialNumber: a.serial_number, itemPrice: Number(a.item_price), depreciationPercentage: 0 } as Asset));
  return <><div data-testid="toast">{toast}</div><ChallanView draftAccountId="synthetic-browser-admin" booking={event}
    client={{ name: 'Synthetic client' } as any} assets={assets} subrentalTickets={tickets}
    showScanToast={message => setToast(message)} onSaveDocument={async (scope, payload) => {
      const result = await api(`/api/conferences/${event.id}/challan-documents/${scope}/`, 'PUT', payload);
      setEvent(mapConference(result.conference)); return result.document;
    }} /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
