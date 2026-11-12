// Bundled separately only by the isolated browser regression runner.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useAppUpdates } from '../state/useAppUpdates';
import { setWorkBlocker } from '../state/workSafety';
sessionStorage.setItem('navigations', String(Number(sessionStorage.getItem('navigations') || 0) + 1));
function Fixture() {
  const { needRefresh: [available], updateServiceWorker, updating, updateBlocked } = useAppUpdates();
  return <><p data-testid="available">{String(available)}</p><p data-testid="updating">{String(updating)}</p><p data-testid="blocked">{String(updateBlocked)}</p>
    <button onClick={() => setWorkBlocker('synthetic-draft', true)}>Dirty</button>
    <button onClick={() => setWorkBlocker('synthetic-draft', false)}>Clean</button>
    <button onClick={() => updateServiceWorker()}>Update</button></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
