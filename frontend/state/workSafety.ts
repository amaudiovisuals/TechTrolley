// Dirty editors and pending network operations block a service-worker restart.
const blockers = new Set<string>();
export function setWorkBlocker(key: string, active: boolean) {
  if (active) blockers.add(key); else blockers.delete(key);
}
export function hasPendingWork() { return blockers.size > 0; }
export async function retireLegacyApiCache() {
  if ('caches' in globalThis) await caches.delete('api-cache');
}
