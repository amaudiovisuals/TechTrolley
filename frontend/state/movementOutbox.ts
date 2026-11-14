export interface MovementOperation {
  eventId: string;
  endpoint?: string;
  payload: { request_id: string; action: string; asset_ids: number[]; source: string; target_conference_id?: number };
}
export class RejectedMovement extends Error {}
/** Durable UUIDs allow an uncertain request to be retried without moving stock twice. */
export class MovementOutbox {
  private flight: Promise<void> | null = null;
  private results = new Map<string, any>();
  constructor(readonly key: string, private storage: Pick<Storage, 'getItem' | 'setItem'>,
    private send: (operation: MovementOperation) => Promise<any>, private acknowledge: (result: any) => void | Promise<void>) {}
  pending(): MovementOperation[] {
    const value = JSON.parse(this.storage.getItem(this.key) || '[]');
    if (!Array.isArray(value) || value.length > 500 || value.some(item => !item || typeof item.eventId !== 'string' ||
      !/^\d+$/.test(item.eventId) || !item.payload || typeof item.payload.request_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.payload.request_id))) {
      throw new Error('The saved movement queue needs review');
    }
    return value;
  }
  async enqueue(eventId: string, action: string, ids: number[], source = 'qr', target?: number) {
    const records = this.pending();
    const operation: MovementOperation = { eventId, payload: { request_id: crypto.randomUUID(), action,
      asset_ids: [...new Set(ids)].sort((a, b) => a - b), source, ...(target ? { target_conference_id: target } : {}) } };
    return this.enqueueOperation(operation, records, true);
  }
  async queueOfflineStage(eventId: string, assetId: number) {
    if (!/^\d+$/.test(eventId) || !Number.isSafeInteger(assetId) || assetId <= 0) throw Error('Invalid offline scan.');
    if (!navigator.locks?.request) throw Error('This browser cannot protect offline scans across tabs.');
    let operation: MovementOperation = { eventId, payload: { request_id: crypto.randomUUID(), action: 'stage', asset_ids: [assetId], source: 'qr' } };
    await this.lock(async () => {
      const current = this.pending(); operation = this.pendingAssetScan(operation, current) || operation;
      if (!current.some(r => r.payload.request_id === operation.payload.request_id)) {
        if (current.length >= 500) throw Error('Too many pending movements. Retry or review first.');
        current.push(operation);
      }
      this.storage.setItem(this.key, JSON.stringify(current));
    });
    return operation; // Deliberately no flush, network request or acknowledgement.
  }
  async enqueueTruck(eventId: string, truckId: string, payload: Record<string, any>) {
    if (!/^\d+$/.test(truckId)) throw new Error('Invalid truck');
    const records = this.pending();
    const operation: MovementOperation = { eventId, endpoint: `/api/truck-challans/${truckId}/transfer/`,
      payload: { ...payload, request_id: crypto.randomUUID() } as any };
    return this.enqueueOperation(operation, records);
  }
  async enqueueQuantity(eventId: string, payload: Record<string, any>) {
    const records = this.pending();
    return this.enqueueOperation({ eventId, endpoint: `/api/conferences/${eventId}/quantity-commands/`,
      payload: { ...payload, request_id: crypto.randomUUID() } as any }, records);
  }
  async enqueueSkipPackup(eventId: string, payload: { expected_revision: number; review_hash: string; reason: string }) {
    return this.enqueueOperation({ eventId, endpoint: `/api/conferences/${eventId}/skip-packup/`,
      payload: { ...payload, request_id: crypto.randomUUID() } as any }, this.pending());
  }
  async enqueueQuantityTransfer(eventId: string, payload: Record<string, any>) {
    return this.enqueueOperation({eventId, endpoint:`/api/conferences/${eventId}/quantity-transfers/`,
      payload:{...payload,request_id:crypto.randomUUID()} as any},this.pending());
  }
  async enqueueConsumable(eventId: string, payload: Record<string, any>) {
    return this.enqueueOperation({ eventId, endpoint: `/api/conferences/${eventId}/consumable-commands/`,
      payload: { ...payload, request_id: crypto.randomUUID() } as any }, this.pending());
  }
  async enqueueManifest(eventId: string, payload: Record<string, any>) {
    const records = this.pending();
    const requestId = payload.request_id || crypto.randomUUID();
    const previous = records.find(record => record.payload.request_id === requestId);
    const operation: MovementOperation = previous || { eventId, endpoint: `/api/conferences/${eventId}/manifest-commands/`,
      payload: { ...payload, request_id: requestId } as any };
    if (operation.eventId !== eventId || operation.endpoint !== `/api/conferences/${eventId}/manifest-commands/`) throw Error('Pending request belongs to another operation');
    return this.enqueueOperation(operation, records);
  }
  private pendingAssetScan(operation: MovementOperation, records: MovementOperation[]) {
    for (let index = records.length - 1; index >= 0; index--) {
      const previous = records[index];
      // Other workflows may change quantities or custody. Do not merge across
      // them, or across an intervening action affecting any of these assets.
      if (previous.endpoint || !Array.isArray(previous.payload.asset_ids)) break;
      if (!previous.payload.asset_ids.some(id => operation.payload.asset_ids.includes(id))) continue;
      const a = previous.payload, b = operation.payload;
      if (previous.eventId === operation.eventId && a.action === b.action && a.source === b.source &&
          a.target_conference_id === b.target_conference_id && a.asset_ids.length === b.asset_ids.length &&
          a.asset_ids.every((id, position) => id === b.asset_ids[position])) return previous;
      break;
    }
    return undefined;
  }
  private async enqueueOperation(operation: MovementOperation, records: MovementOperation[], reuseAssetScan = false) {
    if (!reuseAssetScan && records.length >= 500) throw new Error('Too many pending movements. Retry or review them first.');
    // Fail before sending if durable retry storage is unavailable.
    // The browser lock prevents two tabs from replacing each other's stored queue.
    await this.lock(async () => {
      const current = this.pending();
      // Repeated reads while offline/in flight reuse the exact saved envelope,
      // including its UUID. Make this choice under the shared browser lock.
      if (reuseAssetScan) operation = this.pendingAssetScan(operation, current) || operation;
      if (!current.some(record => record.payload.request_id === operation.payload.request_id)) {
        if (current.length >= 500) throw new Error('Too many pending movements. Retry or review them first.');
        current.push(operation);
      }
      this.storage.setItem(this.key, JSON.stringify(current));
    });
    await this.flush();
    let result = this.results.get(operation.payload.request_id);
    if (!result && !this.pending().some(item => item.payload.request_id === operation.payload.request_id)) {
      // Another tab may have drained our operation while holding the browser
      // lock. Ask for the same receipt, never create a second request ID.
      try { result = await this.send(operation); await this.acknowledge(result); }
      catch (error) {
        if (!(error instanceof RejectedMovement)) await this.lock(async () => {
          const current = this.pending();
          if (!current.some(item => item.payload.request_id === operation.payload.request_id)) {
            current.push(operation); this.storage.setItem(this.key, JSON.stringify(current));
          }
        });
        throw error;
      }
    }
    if (!result) throw new Error('Movement pending. Retry the saved queue when the connection is available.');
    this.results.delete(operation.payload.request_id);
    return result;
  }
  flush(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.lock(() => this.drain()).finally(() => { this.flight = null; });
    return this.flight;
  }
  private lock<T>(run: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(this.key, run);
    // Older browsers have no cross-tab lock: do not silently claim multi-tab safety.
    // Production scanner browsers must support Web Locks (HTTPS).
    if (typeof navigator !== 'undefined') return Promise.reject(new Error('This browser cannot safely store scan retries. Use a current browser over HTTPS.'));
    return run(); // Non-browser regression transport.
  }
  private async drain() {
    while (true) {
      const operation = this.pending()[0];
      if (!operation) return;
      let result;
      try { result = await this.send(operation); }
      catch (error) {
        if (error instanceof RejectedMovement) {
          // An explicit atomic rejection did not commit this request. Do not retry
          // it silently forever; the operator must correct the cause and rescan.
          this.storage.setItem(this.key, JSON.stringify(this.pending().filter(item => item.payload.request_id !== operation.payload.request_id)));
        }
        throw error;
      }
      // Errors/timeouts leave the exact UUID and payload in storage for retry.
      await this.acknowledge(result);
      this.storage.setItem(this.key, JSON.stringify(this.pending().filter(item => item.payload.request_id !== operation.payload.request_id)));
      this.results.set(operation.payload.request_id, result);
    }
  }
}
