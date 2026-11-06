import { readDraft } from './challanDrafts';
import { readEventDraft } from './eventDrafts';
import { MovementOutbox } from './movementOutbox';
import { StaffWorkQueue } from './staffAllocations';
import { LifecycleWorkQueue } from './eventLifecycle';
import { RepairWorkQueue } from './reconciliation';
import { SupplierWorkQueue } from './supplierSaves';

export interface RecoveryIdentity { user_id: number; email: string; legacy_email_scope_allowed: boolean }
export interface SavedWork { source: string; target: string; kind: string; raw: string; hash: string; requestIds: string[]; state: 'ready' | 'conflict' | 'copied' | 'uncertain' | 'invalid'; reason?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const recoveryLedger = (key: string, hash: string) => `tt:work-recovery:1:${encodeURIComponent(key)}:${hash}`;
async function digest(raw: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), b => b.toString(16).padStart(2, '0')).join(''); }
function destination(key: string, origin: string, identity: RecoveryIdentity) {
  if (!identity.legacy_email_scope_allowed || !Number.isSafeInteger(identity.user_id) || identity.user_id <= 0 || !identity.email || identity.email === String(identity.user_id)) return null;
  for (const head of ['tt:draft:2:', 'tt:event-draft:2:', 'tt:movement:2:']) {
    const prefix = head + encodeURIComponent(origin) + ':';
    if (!key.startsWith(prefix)) continue;
    const tail = key.slice(prefix.length), colon = tail.indexOf(':'), account = colon < 0 ? tail : tail.slice(0, colon), rest = colon < 0 ? '' : tail.slice(colon);
    try {
      if (decodeURIComponent(account).toLowerCase() !== identity.email.toLowerCase()) return null;
      if (head === 'tt:movement:2:' ? rest !== '' : head === 'tt:event-draft:2:' ? !/^:\d+$/.test(rest) : !/^:\d+:[^:]+(?::save)?$/.test(rest)) return null;
      return {target: prefix + identity.user_id + rest, kind: head === 'tt:movement:2:' ? 'movements' : head === 'tt:event-draft:2:' ? 'event draft' : rest.endsWith(':save') ? 'challan save' : 'challan draft'};
    } catch { return null; }
  }
  for (const kind of ['staff', 'lifecycle', 'repair', 'supplier']) {
    const prefix = `techtrolley:${kind}:${origin}:`;
    if (key.startsWith(prefix) && key.slice(prefix.length).toLowerCase() === identity.email.toLowerCase()) return {target:prefix + identity.user_id,kind};
  }
  return null;
}
function inspect(row: Pick<SavedWork, 'kind'|'raw'|'source'>, store: Storage): string[] | null {
  try {
    if (row.raw.length > 2_000_000) return null;
    const value = JSON.parse(row.raw);
    if (row.kind === 'event draft') { const draft=readEventDraft(store,row.source); return draft && String(draft.form.id) === row.source.split(':').at(-1) ? [] : null; }
    if (row.kind === 'challan draft') return readDraft(store, row.source) ? [] : null;
    if (row.kind === 'movements') {
      const entries = new MovementOutbox(row.source, store, async () => {}, () => {}).pending();
      if (!entries.length) return [];
      if (entries.some(e => !uuid.test(e.payload.request_id) || typeof e.payload.action !== 'string' || !['qr','manual','rfid'].includes(e.payload.source || 'qr'))) return null;
      return entries.map(e => e.payload.request_id);
    }
    if (row.kind === 'challan save') return value && uuid.test(value.request_id) && Array.isArray(value.lines) && Number.isSafeInteger(value.expected_revision) ? [value.request_id] : null;
    const constructors = {staff:StaffWorkQueue,lifecycle:LifecycleWorkQueue,repair:RepairWorkQueue,supplier:SupplierWorkQueue};
    const C = constructors[row.kind as keyof typeof constructors];
    const pending = C ? new C(row.source, store).read() : null;
    return pending && uuid.test(pending.payload.request_id) ? [pending.payload.request_id] : null;
  } catch { return null; }
}
export async function findSavedWork(store: Storage, origin: string, identity: RecoveryIdentity): Promise<SavedWork[]> {
  const rows: SavedWork[] = [];
  // Snapshot key names: journal writes cannot change this iteration.
  const keys = Array.from({length:store.length}, (_, n) => store.key(n)).filter((s): s is string => s !== null);
  for (const source of keys) {
    const target = destination(source, origin, identity); if (!target) continue;
    const raw = store.getItem(source); if (!raw || target.kind === 'movements' && raw.trim() === '[]') continue;
    const requestIds = inspect({...target, source, raw}, store), hash = await digest(raw);
    const journal = store.getItem(recoveryLedger(source, hash));
    const current = store.getItem(target.target);
    const state = requestIds === null || journal && !['copying','copied'].includes(journal) ? 'invalid' : journal === 'copied' ? 'copied' : current !== null && current !== raw && !(target.kind === 'movements' && current.trim() === '[]') ? 'conflict' : journal === 'copying' ? 'uncertain' : 'ready';
    rows.push({source,...target,raw,hash,requestIds:requestIds || [],state});
  }
  return rows;
}
export async function copySavedWork(row: SavedWork, store: Storage, origin: string, identity: RecoveryIdentity,
  verify: (ids: string[]) => Promise<void>, assertSession: () => void) {
  if (!navigator.locks?.request) throw Error('An updated browser over HTTPS is required to recover saved work.');
  // Queue writers already use these exact key locks. Older tabs must be closed;
  // original email records are never deleted, even after successful copying.
  const keys = [row.source,row.target].sort();
  return navigator.locks.request(keys[0], () => navigator.locks.request(keys[1], async () => {
    assertSession();
    if (destination(row.source, origin, identity)?.target !== row.target || !['ready','uncertain'].includes(row.state)) throw Error('Review this saved record again.');
    await verify(row.requestIds); assertSession();
    if (store.getItem(row.source) !== row.raw || await digest(row.raw) !== row.hash) throw Error('Older saved work changed. Reload this review.');
    const target = store.getItem(row.target), journal = recoveryLedger(row.source,row.hash);
    const prior = store.getItem(journal);
    if (prior !== null && !(row.state === 'uncertain' && prior === 'copying')) throw Error('This copy was already attempted. Reload the review.');
    if (target !== null && target !== row.raw && !(row.kind === 'movements' && target.trim() === '[]')) throw Error('Current saved work conflicts. Keep both versions and finish/review the current work first.');
    // A write-ahead marker makes a quota error or interrupted copy visible. A
    // completed marker prevents resurrecting an old queue after it was drained.
    store.setItem(journal,'copying');
    assertSession();
    if (store.getItem(row.source) !== row.raw || store.getItem(row.target) !== target) throw Error('Saved work changed during review; both original versions were kept.');
    if (target !== row.raw) store.setItem(row.target,row.raw);
    if (store.getItem(row.target) !== row.raw) throw Error('Copy could not be verified. Review both versions.');
    store.setItem(journal,'copied');
  }));
}
