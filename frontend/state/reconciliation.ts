export type RepairAction = 'repair_status' | 'legacy_return' | 'audit_mode' | 'inverse';
export interface RepairTarget { action: RepairAction; asset_ids: number[]; conference_ids: number[]; target_is_audit?: boolean; original_id?: string; }
export interface RepairCommand { request_id: string; target: RepairTarget; database: Record<string, string>; expected_snapshot_sha256: string; reason: string; evidence_reference: string; confirmed: true; custody_confirmations: Record<string, string>; }
export interface RepairPending { version: 1; event_id: number; payload: RepairCommand; status: 'pending' | 'rejected'; error?: string; }
export const repairScope = (origin: string, account: string) => `techtrolley:repair:${origin}:${account}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, sha = /^[a-f0-9]{64}$/;
const ids = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 100 && new Set(v).size === v.length && v.every(n => Number.isSafeInteger(n) && n > 0);
function valid(value: RepairPending) {
  const p = value?.payload, t = p?.target;
  if (!(value?.version === 1 && Number.isSafeInteger(value.event_id) && value.event_id > 0 && ['pending', 'rejected'].includes(value.status) && p && t &&
      Object.keys(p).sort().join(',') === 'confirmed,custody_confirmations,database,evidence_reference,expected_snapshot_sha256,reason,request_id,target' && uuid.test(p.request_id) && sha.test(p.expected_snapshot_sha256) &&
      typeof p.reason === 'string' && p.reason.trim().length > 0 && p.reason.trim().length <= 1000 && typeof p.evidence_reference === 'string' && p.evidence_reference.trim().length > 0 && p.evidence_reference.trim().length <= 1000 && p.confirmed === true &&
      ids(t.asset_ids) && ids(t.conference_ids) && ['repair_status', 'legacy_return', 'audit_mode', 'inverse'].includes(t.action) &&
      p.database && Object.keys(p.database).sort().join(',') === 'instance_id,name,protocol,runtime_source_sha256,schema_sha256,vendor' && Object.values(p.database).every(v => typeof v === 'string') &&
      sha.test(p.database.schema_sha256) && sha.test(p.database.runtime_source_sha256) && p.custody_confirmations && !Array.isArray(p.custody_confirmations) &&
      Object.entries(p.custody_confirmations).every(([key, v]) => /^\d+$/.test(key) && ['warehouse', 'event', 'crosscheck', 'staff'].includes(v)))) return false;
  const keys = Object.keys(t).sort().join(',');
  return t.action === 'repair_status' ? keys === 'action,asset_ids,conference_ids' && t.asset_ids.length > 0 && !t.conference_ids.length :
    t.action === 'legacy_return' ? keys === 'action,asset_ids,conference_ids' && t.asset_ids.length > 0 && t.conference_ids.length === 1 :
    t.action === 'audit_mode' ? keys === 'action,asset_ids,conference_ids,target_is_audit' && !t.asset_ids.length && t.conference_ids.length === 1 && typeof t.target_is_audit === 'boolean' :
    keys === 'action,asset_ids,conference_ids,original_id' && !t.asset_ids.length && !t.conference_ids.length && uuid.test(t.original_id || '');
}
export class RepairWorkQueue {
  constructor(readonly key: string, private store: Storage = localStorage) {}
  read(): RepairPending | null { const raw = this.store.getItem(this.key); if (!raw) return null; const value = JSON.parse(raw); if (!valid(value)) throw Error('Stored review needs assistance; it was not sent.'); return value; }
  private announce() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('techtrolley-repair-work')); }
  private async locked<T>(run: () => Promise<T>) { if (!navigator.locks?.request) throw Error('An updated browser with cross-tab save protection is required.'); return navigator.locks.request(this.key, run); }
  async prepare(eventId: number, payload: RepairCommand) { return this.locked(async () => { if (this.read()) throw Error('Resolve the saved review before a new operation.'); const value: RepairPending = { version: 1, event_id: eventId, payload: JSON.parse(JSON.stringify(payload)), status: 'pending' }; if (!valid(value)) throw Error('Invalid reviewed operation. Reload its preview.'); this.store.setItem(this.key, JSON.stringify(value)); this.announce(); return value; }); }
  async discardRejected(id: string) { return this.locked(async () => { const value = this.read(); if (value?.status !== 'rejected' || value.payload.request_id !== id) throw Error('An uncertain or changed save must be recovered first.'); this.store.removeItem(this.key); this.announce(); }); }
  async execute(id: string, apiFetch: (url: string, options?: RequestInit) => Promise<Response>, refresh: (eventId: number, assetIds?: number[]) => Promise<void>) {
    return this.locked(async () => {
      const value = this.read(); if (!value) return;
      if (value.payload.request_id !== id || value.status === 'rejected') throw Error('Review the changed or rejected saved attempt.');
      const response = await apiFetch('/api/reconciliation/commands/', { method: 'POST', body: JSON.stringify(value.payload) }); const result = await response.json();
      if (!response.ok) {
        const messages: Record<string, string> = { reconciliation_evidence_changed: 'Records changed after review. Reload the preview before a new attempt.', reconciliation_dependencies_changed: 'Related equipment changed after review. Reload the preview.', reconciliation_blocked: 'This review still has unresolved evidence or later activity.', database_or_runtime_identity_changed: 'The server identity changed. Obtain a new review.', reviewed_writes_disabled: 'Reviewed data writes are not enabled for this release.', administrator_review_required: 'An administrator must approve this operation.', physical_custody_confirmation_required: 'Confirm the current physical custody shown in the preview.' };
        const message = messages[result.error] || `Reviewed operation could not be saved (${response.status}). Its records require review.`;
        if ([400, 403, 404, 409, 428].includes(response.status)) { this.store.setItem(this.key, JSON.stringify({ ...value, status: 'rejected', error: message })); this.announce(); }
        throw Error(message);
      }
      if (result.operation !== 'reviewed_reconciliation' || result.request_id !== id || result.history?.action !== value.payload.target.action || !uuid.test(result.history?.id || '') || result.history.before_sha256 !== value.payload.expected_snapshot_sha256) throw Error('Review acknowledgement could not be verified. Recover the saved request.');
      const affected = result.asset_states;
      if (!Array.isArray(affected) || affected.length > 500 || affected.some((row: any) => !Number.isSafeInteger(row.id) || row.id <= 0)) throw Error('The reviewed item identifiers could not be verified. Recover the saved request.');
      await refresh(value.event_id, affected.map((row: any) => row.id));
      if (this.read()?.payload.request_id !== id) throw Error('The saved review changed during acknowledgement.');
      this.store.removeItem(this.key); this.announce();
    });
  }
}
