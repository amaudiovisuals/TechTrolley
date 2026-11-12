export const balanceActions = ['supplier_receive','supplier_return','supplier_cancel','review_supplier_opening'] as const;
export type SupplierAction = 'create_ticket' | 'create_custom_ticket' | 'add_item' | 'edit_item' | 'edit_ticket' | typeof balanceActions[number];
export interface SupplierCommand { request_id: string; action: SupplierAction; conference_id: number | null; expected_revision: number | null; reason: string; data: Record<string, string | number | boolean | null>; }
export interface SupplierPending { version: 1; payload: SupplierCommand; status: 'pending' | 'rejected'; error?: string; }
export interface SupplierAck { operation: 'supplier_paperwork' | 'supplier_balance'; request_id: string; action: SupplierAction; change_id: number; ticket_id: number; conference_id: number; revision: number; }
export const supplierScope = (origin: string, account: string) => `techtrolley:supplier:${origin}:${account}`;
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function valid(value: SupplierPending) {
  const p = value?.payload, d = p?.data;
  if (!(value?.version === 1 && ['pending','rejected'].includes(value.status) && p && typeof p.request_id === 'string' && uuid.test(p.request_id) && Object.keys(p).sort().join(',') === 'action,conference_id,data,expected_revision,reason,request_id' && typeof p.reason === 'string' && p.reason.trim().length > 0 && p.reason.trim().length <= 1000 && d && !Array.isArray(d))) return false;
  if (p.action === 'create_custom_ticket' ? p.conference_id !== null || p.expected_revision !== null : !positive(p.conference_id) || !Number.isSafeInteger(p.expected_revision) || Number(p.expected_revision) < 0) return false;
  let keys: string[];
  if (balanceActions.includes(p.action as typeof balanceActions[number])) {
    const opening=p.action==='review_supplier_opening';
    keys=['ticket_id','item_id','expected_balance_revision','evidence_reference','confirmed',...(opening?['received','returned','cancelled']:['quantity'])];
    if(!positive(d.ticket_id)||!positive(d.item_id)||d.confirmed!==true||typeof d.evidence_reference!=='string'||!d.evidence_reference.trim()||d.evidence_reference.trim().length>1000)return false;
    if(opening?d.expected_balance_revision!==null:!Number.isSafeInteger(d.expected_balance_revision)||Number(d.expected_balance_revision)<0)return false;
    if((opening?['received','returned','cancelled']:['quantity']).some(key=>!Number.isSafeInteger(d[key])||Number(d[key])<(opening?0:1)||Number(d[key])>1000000))return false;
  } else if (p.action === 'create_ticket' || p.action === 'create_custom_ticket' || p.action === 'edit_ticket') {
    const id = p.action === 'edit_ticket' ? 'ticket_id' : 'company_id';
    keys = [id, 'available_from', 'available_till', ...(p.action === 'create_custom_ticket' ? ['name'] : [])];
    if (!positive(d[id]) || ['available_from','available_till'].some(key => d[key] !== null && (typeof d[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(d[key])))) || p.action === 'create_custom_ticket' && (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 200)) return false;
  } else if (p.action === 'add_item' || p.action === 'edit_item') {
    keys = p.action === 'edit_item' ? ['ticket_id','item_id','quantity','rental_price'] : ['ticket_id','asset_id','quantity','rental_price', ...(d.asset_id === null ? ['name','price','depreciation'] : [])];
    if (!positive(d.ticket_id) || !positive(d.quantity) || Number(d.quantity) > 1000000 || !positive(d[p.action === 'edit_item' ? 'item_id' : 'ticket_id']) || p.action === 'add_item' && d.asset_id !== null && !positive(d.asset_id)) return false;
    for (const key of ['rental_price', ...(p.action === 'add_item' && d.asset_id === null ? ['price','depreciation'] : [])]) if (!['string','number'].includes(typeof d[key]) || !Number.isFinite(Number(d[key])) || Number(d[key]) < 0) return false;
    if (p.action === 'add_item' && d.asset_id === null && (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 200 || Number(d.depreciation) > 100)) return false;
  } else return false;
  return Object.keys(d).sort().join(',') === keys.sort().join(',');
}
export class SupplierWorkQueue {
  constructor(readonly key: string, private store: Storage = localStorage) {}
  read(): SupplierPending | null { const raw = this.store.getItem(this.key); if (!raw) return null; const value = JSON.parse(raw); if (!valid(value)) throw Error('Stored supplier save needs assistance; it was not sent.'); return value; }
  private announce() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('techtrolley-supplier-work')); }
  private async locked<T>(run: () => Promise<T>) { if (!navigator.locks?.request) throw Error('An updated browser with cross-tab save protection is required.'); return navigator.locks.request(this.key, run); }
  async prepare(payload: SupplierCommand) { return this.locked(async () => { if (this.read()) throw Error('Resolve the saved supplier operation first.'); const value: SupplierPending = { version: 1, payload: JSON.parse(JSON.stringify(payload)), status: 'pending' }; if (!valid(value)) throw Error('Check supplier fields, quantities and reason before saving.'); this.store.setItem(this.key, JSON.stringify(value)); this.announce(); return value; }); }
  async discardRejected(id: string) { return this.locked(async () => { const value = this.read(); if (value?.status !== 'rejected' || value.payload.request_id !== id) throw Error('An uncertain or changed save must be recovered first.'); this.store.removeItem(this.key); this.announce(); }); }
  async execute(id: string, apiFetch: (url: string, options?: RequestInit) => Promise<Response>, refresh: (ack: SupplierAck) => Promise<void>) {
    return this.locked(async () => {
      const value = this.read(); if (!value) return;
      if (value.payload.request_id !== id || value.status === 'rejected') throw Error('Review the changed or rejected supplier save.');
      const response = await apiFetch('/api/supplier-commands/', { method: 'POST', body: JSON.stringify(value.payload) }); const result = await response.json();
      if (!response.ok) {
        const messages: Record<string,string> = { shared_stock_uses_warehouse_movements: 'This is shared-godown stock. Scan it through the ordinary event inventory flow; a rental ticket would duplicate its source.', supplier_event_changed: 'The event changed. Discard this rejected attempt and review current ticket records.', supplier_asset_owner_mismatch: 'This item belongs to a different inventory owner.', supplier_quantity_has_history: 'This quantity has movement or document history. Use its reviewed return/cancellation workflow.', supplier_item_already_on_ticket: 'This asset already has a row on this ticket. Review that row.', supplier_quantity_exceeds_inventory: 'The requested quantity exceeds this inventory row.', invalid_supplier_quantity: 'Enter a positive whole quantity.', invalid_supplier_amount: 'Enter a valid nonnegative amount with at most two decimals.', event_is_sealed: 'This event is completed or archived.', not_authorized: 'Your account cannot start this supplier save.' };
        const balanceMessages:Record<string,string>={supplier_balance_changed:'The rental balance changed. Review current counts before another attempt.',supplier_quantity_exceeds_recorded_balance:'This quantity exceeds the recorded rental balance. Received units cannot be cancelled.',supplier_opening_review_required:'An administrator must review the legacy opening counts first.',external_supplier_classification_required:'Review this company as an external supplier before recording rental movements.',supplier_asset_has_warehouse_custody:'This source also has warehouse custody. Review that overlap before recording supplier movements.',supplier_catalogue_capacity_exceeded:'Other unresolved orders already use this declared supplier capacity.'};
        const error = messages[result.error] || balanceMessages[result.error] || `Supplier save could not be confirmed (${response.status}). Review the saved attempt.`;
        if ([400,403,404,409,428].includes(response.status)) { this.store.setItem(this.key, JSON.stringify({...value,status:'rejected',error})); this.announce(); }
        throw Error(error);
      }
      const operation=balanceActions.includes(value.payload.action as typeof balanceActions[number])?'supplier_balance':'supplier_paperwork';
      if (result.operation !== operation || result.request_id !== id || result.action !== value.payload.action || !positive(result.change_id) || !positive(result.ticket_id) || !positive(result.conference_id) || !Number.isSafeInteger(result.revision) || result.revision < 0 || value.payload.conference_id !== null && result.conference_id !== value.payload.conference_id || value.payload.data.ticket_id && result.ticket_id !== value.payload.data.ticket_id) throw Error('Supplier acknowledgement could not be verified. Recover the saved request.');
      await refresh(result);
      if (this.read()?.payload.request_id !== id) throw Error('Supplier save changed during acknowledgement.');
      this.store.removeItem(this.key); this.announce();
    });
  }
}
