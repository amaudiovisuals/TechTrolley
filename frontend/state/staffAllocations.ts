export type StaffEndpoint = '/api/staff-commands/' | '/api/employee-link-commands/';
export interface StaffPending {
    version: 1;
    endpoint: StaffEndpoint;
    payload: any;
    status: 'pending' | 'rejected';
    error?: string;
}
export const staffScope = (origin: string, account: string) => `techtrolley:staff:${origin}:${account}`;
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function staffItem(asset: any) {
    return { asset_id: Number(asset.id), expected_revision: Number(asset.staff_revision ?? 0), expected_employee_id: asset.assigned_to ?? null };
}
export class StaffWorkQueue {
    constructor(readonly key: string, private store: Storage = localStorage) { }
    read(): StaffPending | null {
        const raw = this.store.getItem(this.key);
        if (!raw)
            return null;
        const value = JSON.parse(raw);
        if (value.version !== 1 || !['/api/staff-commands/', '/api/employee-link-commands/'].includes(value.endpoint) || !['pending', 'rejected'].includes(value.status) || !value.payload || !validUuid.test(value.payload.request_id))
            throw Error('Stored staff operation needs review; it was not sent.');
        return value;
    }
    private announce() { if (typeof window !== 'undefined')
        window.dispatchEvent(new Event('techtrolley-staff-work')); }
    private async locked<T>(run: () => Promise<T>): Promise<T> {
        if (!navigator.locks?.request)
            throw Error('This browser cannot protect staff saves across tabs. Use an updated browser.');
        return navigator.locks.request(this.key, run);
    }
    async prepare(endpoint: StaffEndpoint, payload: any) {
        return this.locked(async () => {
            if (this.read())
                throw Error('Resolve the pending staff operation before starting another.');
            const value: StaffPending = { version: 1, endpoint, payload: JSON.parse(JSON.stringify(payload)), status: 'pending' };
            if (!validUuid.test(value.payload.request_id))
                throw Error('Invalid staff request identifier.');
            this.store.setItem(this.key, JSON.stringify(value));
            this.announce();
            return value;
        });
    }
    async discardRejected() {
        return this.locked(async () => { const value = this.read(); if (value?.status !== 'rejected')
            throw Error('An uncertain save must be retried before another operation.'); this.store.removeItem(this.key); this.announce(); });
    }
    async execute(id: string, apiFetch: (url: string, options?: RequestInit) => Promise<Response>, refresh: () => Promise<void>) {
        return this.locked(async () => {
            const value = this.read();
            if (!value) {
                await refresh();
                return;
            }
            if (value.payload.request_id !== id)
                throw Error('The pending operation changed; review it first.');
            if (value.status === 'rejected')
                throw Error(value.error || 'Review the rejected operation against current records.');
            const response = await apiFetch(value.endpoint, { method: 'POST', body: JSON.stringify(value.payload) });
            const result = await response.json();
            if (!response.ok) {
                const message = result.error || `Staff save failed (${response.status})`;
                if ([400, 403, 404, 409, 428].includes(response.status)) {
                    this.store.setItem(this.key, JSON.stringify({ ...value, status: 'rejected', error: message }));
                    this.announce();
                }
                throw Error(message);
            }
            const expected = value.endpoint === '/api/staff-commands/' ? 'staff_allocation' : 'employee_link';
            if (result.request_id !== id || result.operation !== expected)
                throw Error('Save acknowledgement could not be verified. Retry the saved request.');
            // Keep exact body until a fresh canonical projection has been accepted.
            await refresh();
            if (this.read()?.payload.request_id !== id)
                throw Error('Pending operation changed during acknowledgement.');
            this.store.removeItem(this.key);
            this.announce();
        });
    }
}
export function groupStaffAllocations(rows: any[], laptopsOnly = false) {
    const result: Record<string, any[]> = {};
    for (const row of rows) {
        const employee = row.allocation_employee_id ?? row.assigned_to;
        if (employee == null || laptopsOnly && row.type !== 'Laptops')
            continue;
        (result[String(employee)] ||= []).push(row);
    }
    return result;
}
