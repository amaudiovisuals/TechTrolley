import type { Booking } from '../types';
export type LifecycleAction = 'complete' | 'archive' | 'reopen';
export interface LifecycleCommand { request_id: string; action: LifecycleAction; expected_revision: number; expected_snapshot_sha256: string; reason: string; confirmed: true; }
export interface LifecyclePending { version: 1; event_id: number; payload: LifecycleCommand; status: 'pending' | 'rejected'; error?: string; }
export const lifecycleScope = (origin: string, account: string) => `techtrolley:lifecycle:${origin}:${account}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function valid(value: LifecyclePending) {
  const p = value?.payload;
  return value?.version === 1 && Number.isSafeInteger(value.event_id) && value.event_id > 0 &&
    ['pending', 'rejected'].includes(value.status) && p &&
    Object.keys(p).sort().join(',') === 'action,confirmed,expected_revision,expected_snapshot_sha256,reason,request_id' &&
    uuid.test(p.request_id) && ['complete', 'archive', 'reopen'].includes(p.action) &&
    Number.isSafeInteger(p.expected_revision) && p.expected_revision >= 0 &&
    typeof p.expected_snapshot_sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.expected_snapshot_sha256) &&
    typeof p.reason === 'string' && p.reason.trim().length > 0 && p.reason.trim().length <= 1000 && p.confirmed === true;
}
export class LifecycleWorkQueue {
  constructor(readonly key: string, private store: Storage = localStorage) {}
  read(): LifecyclePending | null {
    const raw = this.store.getItem(this.key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!valid(value)) throw Error('Stored event operation needs review; it was not sent.');
    return value;
  }
  private announce() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('techtrolley-lifecycle-work')); }
  private async locked<T>(run: () => Promise<T>): Promise<T> {
    if (!navigator.locks?.request) throw Error('This browser cannot protect event saves across tabs. Use an updated browser.');
    return navigator.locks.request(this.key, run);
  }
  async prepare(eventId: number, payload: LifecycleCommand) {
    return this.locked(async () => {
      if (this.read()) throw Error('Resolve the saved event operation before starting another.');
      const value: LifecyclePending = { version: 1, event_id: eventId, payload: JSON.parse(JSON.stringify(payload)), status: 'pending' };
      if (!valid(value)) throw Error('Invalid event operation. Reload the review.');
      this.store.setItem(this.key, JSON.stringify(value)); this.announce(); return value;
    });
  }
  async discardRejected(id: string) {
    return this.locked(async () => {
      const value = this.read();
      if (value?.payload.request_id !== id || value.status !== 'rejected') throw Error('An uncertain or changed save must be retried before another operation.');
      this.store.removeItem(this.key); this.announce();
    });
  }
  async execute(id: string, apiFetch: (url: string, options?: RequestInit) => Promise<Response>, refresh: (eventId: number) => Promise<void>) {
    return this.locked(async () => {
      const value = this.read();
      if (!value) return;
      if (value.payload.request_id !== id) throw Error('The saved event operation changed; review it first.');
      if (value.status === 'rejected') throw Error(value.error || 'Review the rejected operation against current records.');
      const response = await apiFetch(`/api/conferences/${value.event_id}/lifecycle-commands/`, { method: 'POST', body: JSON.stringify(value.payload) });
      const result = await response.json();
      if (!response.ok) {
        const messages: Record<string, string> = {
          event_changed: 'This event changed after the review. Reload its evidence before a new attempt.',
          lifecycle_evidence_changed: 'The equipment evidence changed after review. Reload it before a new attempt.',
          lifecycle_blocked: 'Outstanding balances or missing return evidence prevent completion. Reload the review.',
          not_authorized: 'Your account cannot perform this event operation. Review the saved attempt.',
          request_id_reused: 'The saved request differs from its recorded operation. Review is required.',
          invalid_lifecycle_transition: 'This operation no longer applies to the recorded event state. Reload its review.',
          audit_lifecycle_requires_reviewed_conversion: 'Audit observations require the separate reviewed audit workflow.',
        };
        const message = messages[result.error] || `Event operation could not be saved (${response.status}). Review the attempt.`;
        if ([400, 403, 404, 409, 428].includes(response.status)) {
          this.store.setItem(this.key, JSON.stringify({ ...value, status: 'rejected', error: message })); this.announce();
        }
        throw Error(message);
      }
      if (result.operation !== 'event_lifecycle' || result.request_id !== id || result.action !== value.payload.action || Number(result.conference?.id) !== value.event_id)
        throw Error('Event acknowledgement could not be verified. Retry the saved request.');
      // A replay contains the original snapshot. Publish only a fresh current event.
      await refresh(value.event_id);
      if (this.read()?.payload.request_id !== id) throw Error('Saved event operation changed during acknowledgement.');
      this.store.removeItem(this.key); this.announce();
    });
  }
}
export function eventLifecycleLabel(event: Pick<Booking, 'lifecycle_state' | 'startDate' | 'endDate'>, today = new Date()) {
  if (event.lifecycle_state === 'archived') return 'Archived';
  if (event.lifecycle_state === 'completed') return 'Verified complete';
  const start = event.startDate ? new Date(event.startDate) : null, end = event.endDate ? new Date(event.endDate) : null;
  const day = new Date(today); day.setHours(0, 0, 0, 0);
  if (start && day < start) return 'Upcoming';
  if (end && day > end) return 'Ended · returns unverified';
  return start && end ? 'Ongoing · returns unverified' : 'Open · dates not recorded';
}
export function matchesLifecycleFilter(event: Pick<Booking, 'lifecycle_state' | 'startDate' | 'endDate'>, filter: string, today = new Date()) {
  const state = event.lifecycle_state || 'open';
  if (filter === 'ALL') return true;
  if (filter === 'COMPLETED') return state === 'completed';
  if (filter === 'ARCHIVED') return state === 'archived';
  if (filter === 'OPEN') return state === 'open';
  if (state !== 'open') return false;
  const label = eventLifecycleLabel(event, today);
  return filter === 'UPCOMING' ? label === 'Upcoming' : filter === 'ENDED' ? label.startsWith('Ended') : label.startsWith('Ongoing');
}
