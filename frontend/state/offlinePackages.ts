// Snapshot storage only. This module never sends commands or edits drafts/outbox.
export interface OfflineScope { origin: string; accountId: number; role: string; eventId: number; }
export interface OfflinePackage {
  schema: 1; package_id: string; account_id: number; role: string;
  generated_at: string; expires_at: string; scope: 'unit_requirements_stage';
  event: { id: number; name: string; revision: number; lifecycle_state: 'open'; staged_ids: number[] };
  assets: Array<{ id: number; sku: string; barcode: string; qr_code: string; serial_number: string;
    label: string; type: string; last_known_status: string; owner_label: string }>;
}
const roles = ['admin', 'boss', 'godown_incharge'];
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const exact = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === keys.sort().join();
function key(scope: OfflineScope) {
  if (new URL(scope.origin).origin !== scope.origin || !/^https?:/.test(scope.origin) ||
      !integer(scope.accountId) || !integer(scope.eventId) || !roles.includes(scope.role)) throw Error('Invalid offline account/event scope.');
  return JSON.stringify([scope.origin, scope.accountId, scope.eventId]);
}
export function validateOfflinePackage(value: unknown, scope: OfflineScope, now = Date.now()): OfflinePackage {
  key(scope); const p = value as OfflinePackage;
  if (!exact(p, ['schema','package_id','account_id','role','generated_at','expires_at','scope','event','assets']) ||
      p.schema !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(p.package_id) ||
      p.account_id !== scope.accountId || p.role !== scope.role || p.scope !== 'unit_requirements_stage' ||
      !exact(p.event, ['id','name','revision','lifecycle_state','staged_ids']) || p.event.id !== scope.eventId ||
      typeof p.event.name !== 'string' || p.event.name.length > 200 || !Number.isSafeInteger(p.event.revision) || p.event.revision < 0 ||
      p.event.lifecycle_state !== 'open' || !Array.isArray(p.event.staged_ids) || p.event.staged_ids.length > 5000 ||
      p.event.staged_ids.some(n => !integer(n)) || new Set(p.event.staged_ids).size !== p.event.staged_ids.length ||
      !Array.isArray(p.assets) || p.assets.length > 5000) throw Error('Offline package is invalid or belongs to another account/event.');
  const time = (s: unknown) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|\+00:00)$/.test(s) ? Date.parse(s) : NaN;
  const generated = time(p.generated_at), expires = time(p.expires_at);
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || generated > now + 60000 || expires <= generated || expires - generated > 86400000)
    throw Error('Offline package dates are invalid; prepare it online again.');
  const ids = new Set<number>();
  for (const a of p.assets) {
    if (!exact(a, ['id','sku','barcode','qr_code','serial_number','label','type','last_known_status','owner_label']) || !integer(a.id) || ids.has(a.id))
      throw Error('Offline scan index is invalid.');
    ids.add(a.id);
    for (const field of ['sku','barcode','qr_code','serial_number','label','type','last_known_status','owner_label'] as const)
      if (typeof a[field] !== 'string' || a[field].length > 2048) throw Error('Offline scan label is invalid.');
  }
  if (JSON.stringify(p).length > 8 * 1024 * 1024) throw Error('Offline package is too large.');
  return p;
}
export class OfflinePackageStore {
  constructor(private factory: IDBFactory = indexedDB) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = () => { if (!done) { done = true; clearTimeout(timer); reject(Error('Offline storage is unavailable. Existing saved work is retained.')); } };
      const timer = setTimeout(fail, 5000);
      let request: IDBOpenDBRequest;
      try { request = this.factory.open('tt-offline-packages-1', 1); } catch { fail(); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('packages')) request.result.createObjectStore('packages'); };
      request.onerror = fail; request.onblocked = fail;
      request.onsuccess = () => { if (done) { request.result.close(); return; } done = true; clearTimeout(timer); resolve(request.result); };
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (v: T) => void) => void): Promise<T> {
    const db = await this.open();
    try { return await new Promise<T>((resolve, reject) => {
      let value: T, failure: unknown;
      const tx = db.transaction('packages', mode), timer = setTimeout(() => { failure = Error('Offline storage timed out.'); tx.abort(); }, 5000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(failure || Error('Offline package could not be stored/read. Existing saved work is retained.')); };
      try { run(tx.objectStore('packages'), v => { value = v; }); } catch (e) { failure = e; tx.abort(); }
    }); } finally { db.close(); }
  }
  async read(scope: OfflineScope, now = Date.now()): Promise<{ state: 'missing' | 'invalid' | 'expired' | 'ready'; package?: OfflinePackage }> {
    scope = { ...scope };
    const id = key(scope), raw = await this.transaction<any>('readonly', (store, result) => { const r = store.get(id); r.onsuccess = () => result(r.result); });
    if (!raw) return { state: 'missing' };
    try {
      if (!exact(raw, ['scope','package']) || !exact(raw.scope, ['origin','accountId','eventId','role']) || key(raw.scope) !== id || raw.scope.role !== scope.role) return { state: 'invalid' };
      const p = validateOfflinePackage(raw.package, scope, now);
      return { state: now >= Date.parse(p.expires_at) ? 'expired' : 'ready', package: p };
    } catch { return { state: 'invalid' }; }
  }
  async save(value: unknown, scope: OfflineScope, now = Date.now()) {
    scope = { ...scope };
    // Clone first so a caller cannot change the object while the DB opens.
    const p = validateOfflinePackage(JSON.parse(JSON.stringify(value)), scope, now);
    if (now >= Date.parse(p.expires_at)) throw Error('Offline package expired; prepare it online again.');
    const id = key(scope);
    await this.transaction<void>('readwrite', (store) => {
      const request = store.get(id);
      request.onsuccess = () => {
        try {
        const old = request.result;
        if (old?.package?.package_id === p.package_id && JSON.stringify(old.package) !== JSON.stringify(p)) { request.transaction.abort(); return; }
        // Serialised read/put within one transaction prevents a delayed older
        // download overwriting a newer preparation in another tab.
        if (old?.package && Date.parse(old.package.generated_at) >= Date.parse(p.generated_at) && old.package.package_id !== p.package_id) {
          request.transaction.abort(); return;
        }
        store.put({ scope: { ...scope }, package: p }, id);
        } catch { request.transaction.abort(); }
      };
    });
    const check = await this.read(scope, now);
    if (check.state !== 'ready' || check.package?.package_id !== p.package_id) throw Error('Offline preparation changed; review the latest package.');
    return check.package;
  }
  async list(account: Omit<OfflineScope, 'eventId'>) {
    const scope = { ...account, eventId: 1 }; key(scope);
    const prefix = JSON.stringify([scope.origin, scope.accountId]).slice(0, -1) + ',';
    const keys = await this.transaction<IDBValidKey[]>('readonly', (store, result) => {
      const r = store.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'), 101);
      r.onsuccess = () => result(r.result);
    });
    if (keys.length > 100) throw Error('Too many offline events; storage needs review.');
    return Promise.all(keys.map(async id => {
      const parts = JSON.parse(String(id));
      return { eventId: parts[2] as number, ...await this.read({ ...scope, eventId: parts[2] }) };
    }));
  }
}
