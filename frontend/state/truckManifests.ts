import type { Booking, ChallanLine } from '../types';
export function manifestCommand(booking: Booking, action: string, fields: Record<string, any> = {}) {
  return { action, expected_event_revision: booking.revision ?? 0,
    expected_document_revisions: Object.fromEntries((booking.challan_documents || []).map(doc => [doc.scope, doc.revision])), ...fields };
}
export function manifestQuantity(booking: Booking, line: ChallanLine, truckId: string): number {
  const entries = booking.truck_manifest?.entries || [];
  if (!truckId) return Math.max(0, line.quantity - entries.filter(entry => entry.master_line_id === line.id).reduce((sum, entry) => sum + entry.quantity, 0));
  return entries.find(entry => entry.master_line_id === line.id && String(entry.truck_id) === truckId)?.quantity || 0;
}
