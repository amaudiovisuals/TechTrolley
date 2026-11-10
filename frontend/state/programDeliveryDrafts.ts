// Persist an uncertain issue request before sending it. Reopening must reuse its
// exact key and payload, even if the first reply was lost after the server saved.
export type SupplierPaperDetails = {
  issuer_name: string; issuer_address: string; issuer_gst_number: string;
  recipient_name: string; recipient_address: string; recipient_gst_number: string;
  destination: string; vehicle_number: string; driver_phone: string;
};
export function validSupplierDetails(value: unknown): value is Record<string, SupplierPaperDetails> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const limits: Record<keyof SupplierPaperDetails, number> = { issuer_name: 200, issuer_address: 4000, issuer_gst_number: 20,
    recipient_name: 200, recipient_address: 4000, recipient_gst_number: 20, destination: 4000, vehicle_number: 50, driver_phone: 50 };
  return Object.entries(value).every(([owner, fields]) => /^[1-9]\d*$/.test(owner) && fields && typeof fields === 'object' && !Array.isArray(fields) &&
    Object.keys(fields).length === Object.keys(limits).length && Object.entries(limits).every(([key, limit]) =>
      typeof fields[key] === 'string' && fields[key].trim().length <= limit && (!key.endsWith('_name') || fields[key].trim().length > 0)));
}
export type DeliveryIssueRequest = {
  request_key: string; source_hash: string; truck_id: number | null;
  reference: string; delivery_date: string; vehicle_number: string; driver_phone: string;
  rows: { key: string; name: string; quantity: number }[];
  supplier_details?: Record<string, SupplierPaperDetails>;
  replaces_delivery_id?: number;
  correction_reason?: string;
};
type StorageRead = Pick<Storage, 'getItem'>;
export function deliveryPendingKey(origin: string, account: string, conference: string, truck?: number | string) {
  if (!origin || !account || !conference) throw Error('Sign in again before issuing a delivery.');
  return ['tt', 'pending-delivery', '1', origin, account, conference, truck == null ? 'master' : String(truck)].map(encodeURIComponent).join(':');
}
export function validDeliveryRequest(value: any): value is DeliveryIssueRequest {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    (value.supplier_details === undefined || validSupplierDetails(value.supplier_details)) &&
    (value.replaces_delivery_id === undefined || (Number.isSafeInteger(value.replaces_delivery_id) &&
      value.replaces_delivery_id > 0 && typeof value.correction_reason === 'string' &&
      value.correction_reason.trim().length > 0 && value.correction_reason.trim().length <= 500)) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.request_key) &&
    typeof value.source_hash === 'string' && /^[0-9a-f]{64}$/i.test(value.source_hash) &&
    (value.truck_id === null || (Number.isInteger(value.truck_id) && value.truck_id > 0)) &&
    typeof value.reference === 'string' && value.reference.trim().length > 0 && value.reference.trim().length <= 100 &&
    typeof value.delivery_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.delivery_date) &&
    typeof value.vehicle_number === 'string' && value.vehicle_number.length <= 50 &&
    typeof value.driver_phone === 'string' && value.driver_phone.length <= 50 &&
    Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 2500 &&
    value.rows.every((row: any) => row && typeof row.key === 'string' && typeof row.name === 'string' &&
      row.name.trim().length > 0 && row.name.trim().length <= 500 && Number.isInteger(row.quantity) && row.quantity >= 1 && row.quantity <= 1000000);
}
export function readPendingDelivery(storage: StorageRead, key: string): DeliveryIssueRequest | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (value?.schema !== 1 || value.scope !== key || !validDeliveryRequest(value.request)) {
    throw Error('A saved delivery request needs recovery. Keep browser data and contact your administrator before issuing another delivery.');
  }
  return value.request;
}
export function savePendingDelivery(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, request: DeliveryIssueRequest) {
  if (!validDeliveryRequest(request)) throw Error('Review the delivery date, quantities and details before issuing.');
  const previous = readPendingDelivery(storage, key);
  if (previous && JSON.stringify(previous) !== JSON.stringify(request)) {
    throw Error('Another delivery request is awaiting confirmation. Reopen this program to recover it first.');
  }
  storage.setItem(key, JSON.stringify({ schema: 1, scope: key, request }));
  // Storage failures must stop the POST, rather than leave an unrecoverable issue.
  const saved = readPendingDelivery(storage, key);
  if (JSON.stringify(saved) !== JSON.stringify(request)) throw Error('The browser could not preserve this delivery request. No new request was sent.');
}
export function clearPendingDelivery(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, requestKey: string) {
  const saved = readPendingDelivery(storage, key);
  if (saved && saved.request_key !== requestKey) throw Error('Another delivery request is awaiting confirmation.');
  storage.removeItem(key);
}
