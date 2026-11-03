import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProgramDeliveries } from '../components/ProgramDeliveries';

const accounts = new URLSearchParams(location.search).has('accounts');
const truck = new URLSearchParams(location.search).get('truck');
const apiFetch = (url: string, options: any = {}) => fetch(url, {
  ...options, headers: { 'Content-Type': 'application/json', Authorization: `Token synthetic-${accounts ? 'accounts' : 'warehouse'}-only` },
});
createRoot(document.getElementById('root')!).render(<ProgramDeliveries conferenceId="1" truckId={truck || undefined} canIssue={!accounts} apiFetch={apiFetch} apiBase="http://127.0.0.1:4668" />);
