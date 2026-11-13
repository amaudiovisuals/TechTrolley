// Development-only fixture. Not an entry in the production build; no API calls.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChallanView } from '../components/ChallanView';
import { hasPendingWork } from '../state/workSafety';
import { legacyDocumentAssets } from '../state/challanDocuments';

const first: any = { id: '1', sku: 'SYNTHETIC-1', aliasName: 'Synthetic first', type: 'Other',
  quantity: 1, itemPrice: 10, depreciationPercentage: 0, serialNumber: 'TEST-SERIAL', status: 'Available' };
function Fixture() {
  const [rows, setRows] = useState<any[]>([first]);
  const [revision, setRevision] = useState(1);
  const [account, setAccount] = useState('test-account-a');
  const [event, setEvent] = useState('101');
  const [truck, setTruck] = useState('master');
  const [fail, setFail] = useState(false);
  const [toast, setToast] = useState('');
  const [number, setNumber] = useState('SYNTHETIC-CHALLAN');
  const [value, setValue] = useState(10);
  const [documents, setDocuments] = useState<Record<string, any>>({});
  const documentKey = `${account}:${event}:${truck}`;
  const saved = (window as any).__saved ||= [];
  (window as any).__fixture = { poll: (newRows: any[], nextRevision = revision) => {
    setRows(newRows); setRevision(nextRevision);
    if (documents[documentKey]) setDocuments(previous => ({ ...previous, [documentKey]: { ...previous[documentKey], revision: nextRevision,
      lines: legacyDocumentAssets(newRows, [], { id: event } as any, `${event}:master`).map(asset => asset.challanLine) } }));
  },
    account: setAccount, event: setEvent, truck: setTruck, fail: setFail, blocked: hasPendingWork, first, value: setValue,
    state: () => ({ rows, revision, account, event, truck }) };
  return <><div data-testid="toast">{toast}</div><ChallanView draftAccountId={account}
    booking={{ id: event, conferenceName: 'Synthetic event', revision, approximate_value: value, challanNumber: number } as any}
    client={{ name: 'Synthetic client' } as any} assets={rows} localStorageSuffix={truck}
    document={documents[documentKey]}
    showScanToast={message => setToast(message)}
    onSaveDocument={async (scope, payload) => {
      if (fail) throw Object.assign(Error('Synthetic rejection; changes remain unsaved'), { definitive: true });
      saved.push(payload);
      const document = { ...payload, id: 'synthetic-document', scope, revision: (documents[documentKey]?.revision || 0) + 1,
        header: payload.discount_60 ? { discount_60: true } : {}, total_override: payload.total_override === null ? null : String(payload.total_override) } as any;
      setDocuments(previous => ({ ...previous, [documentKey]: document }));
      setRevision(r => r + 1); return document;
    }} /> </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
