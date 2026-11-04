import type { Booking } from '../types';

const metadataFields = ['name', 'association_name', 'billing_address', 'transport_address',
  'gst_number', 'vehicle_number', 'driver_phone', 'challan_date', 'contact_person', 'contact_phone',
  'contact_email', 'start_date', 'end_date', 'conference_type', 'assigned_employees', 'is_audit',
  'consumable_data', 'approximate_value', 'challan_number', 'pdf_document'] as const;

export function eventEditorData(event: Booking): any {
  return { ...event, id: String(event.id), revision: event.revision ?? 0,
    name: event.name || event.conferenceName || '', association_name: event.association || '',
    billing_address: event.billingAddress || '', transport_address: event.transportAddress || '',
    gst_number: event.gstNumber || '', vehicle_number: event.vehicleNumber || '', driver_phone: event.driverPhone || '',
    challan_date: event.challanDate || '', contact_person: event.contactPerson || '', contact_phone: event.contactPhone || '',
    contact_email: event.contactEmail || '', start_date: event.startDate || '', end_date: event.endDate || '',
    conference_type: event.type, assets: event.assets || [], requirements: event.requirements || [],
    staged_assets: event.staged_assets || [], crosscheck_assets: event.crosscheckAssets || [],
    challan_assets: event.challanAssets || [], assigned_employees: event.assigned_employees || [],
    is_audit: Boolean(event.isAudit), consumable_data: event.consumable_data || {} };
}
export function eventMetadata(value: any): string {
  // Stable keys ensure a scan receipt cannot bless a stale metadata replacement.
  return JSON.stringify(Object.fromEntries(metadataFields.map(field => [field, value[field] ?? null])));
}
export function eventDraftKey(origin: string, account: string, event: string) {
  return ['tt', 'event-draft', '2', origin, account, event].map(encodeURIComponent).join(':');
}
export interface EventDraft { schema: 2; baseRevision: number; form: any; updatedAt: string }
export function readEventDraft(storage: Pick<Storage, 'getItem'>, key: string): EventDraft | null {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null');
    return value?.schema === 2 && Number.isInteger(value.baseRevision) && value.baseRevision >= 0 &&
      value.form && typeof value.form === 'object' && !Array.isArray(value.form) ? value : null;
  } catch { return null; }
}
