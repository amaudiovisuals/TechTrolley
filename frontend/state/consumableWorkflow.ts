import { eventEditorData, eventMetadata } from './eventDrafts';
import type { Asset, Booking } from '../types';

export const consumableMetadataFields = ['name', 'association_name', 'billing_address', 'transport_address', 'gst_number',
  'vehicle_number', 'driver_phone', 'challan_date', 'contact_person', 'contact_phone', 'contact_email',
  'start_date', 'end_date', 'conference_type', 'assigned_employees'] as const;

export async function consumableDraftHash(form: any): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(eventMetadata(form)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function consumableLimit(asset: Asset | undefined, ledger: any): number {
  if (!asset) return 0;
  return Math.max(0, Number(asset.quantity_available ?? asset.quantity) + (ledger?.status === 'requested' ? Number(ledger.requested) : 0));
}

export function editConsumableRequest(data: Record<string, any>, id: string, delta: number): Record<string, any> {
  const entry = data[id] || { requested: 0, returned: null, consumed: 0, status: 'requested' };
  if (entry.status && entry.status !== 'requested') throw Error('Dispatched or settled requests are locked.');
  const requested = Math.max(0, Number(entry.requested || 0) + delta);
  if (!Number.isInteger(requested)) throw Error('Choose a whole-unit quantity.');
  const next = { ...data };
  if (!requested) delete next[id];
  else next[id] = { ...entry, requested, returned: null, consumed: 0, return_confirmed: false, status: 'requested' };
  return next;
}

export function editConsumableReturn(data: Record<string, any>, id: string, returned: number | null): Record<string, any> {
  const entry = data[id];
  if (!entry?.ledger || entry.status !== 'dispatched') throw Error('Save and dispatch this request before reporting returns.');
  if (returned !== null && (!Number.isInteger(returned) || returned < 0 || returned > entry.requested)) throw Error('Return count must be between zero and the dispatched quantity.');
  return { ...data, [id]: { ...entry, returned, return_confirmed: false } };
}

export async function consumablePayload(action: string, form: any, canonical: Booking, role: string) {
  const base = eventEditorData(canonical);
  for (const field of ['is_audit', 'approximate_value', 'challan_number', 'pdf_document']) {
    if (JSON.stringify(form[field] ?? null) !== JSON.stringify(base[field] ?? null)) throw Error('Save audit, document-value or attachment changes separately before saving consumables.');
  }
  const metadata: Record<string, any> = {};
  for (const field of consumableMetadataFields) {
    if (role === 'technician') {
      if (JSON.stringify(form[field] ?? null) !== JSON.stringify(base[field] ?? null)) throw Error('A technician can save consumable quantities, but event details need a warehouse manager.');
    } else {
      const value = form[field];
      if (value !== undefined) metadata[field] = field === 'assigned_employees' ? (value || []).map(Number) : field.endsWith('_date') ? value || null : value;
    }
  }
  const items = Object.entries(form.consumable_data || {}).map(([id, value]: [string, any]) => ({
    asset_id: Number(id), requested: Number(value.requested), returned: value.returned == null ? null : Number(value.returned),
    confirmed: action === 'settle' && value.return_confirmed === true,
  }));
  if (action === 'settle' && items.some(item => form.consumable_data[String(item.asset_id)].status !== 'settled' && (!item.confirmed || item.returned === null))) {
    throw Error('Enter and verify each dispatched return count, including zero, before settling.');
  }
  return { action, expected_revision: form.revision ?? 0, items, metadata, client_draft_hash: await consumableDraftHash(form) };
}
