/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<any> };
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), {
  denylist: [/^\/api(?:\/|$)/, /^\/admin(?:\/|$)/, /^\/media(?:\/|$)/],
}));
registerRoute(({ url }) => url.origin === 'https://cdnjs.cloudflare.com', new CacheFirst({
  cacheName: 'cdn-assets-v2', plugins: [new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 30 * 86400 })],
}));
self.addEventListener('activate', event => {
  event.waitUntil(caches.delete('api-cache'));
});
let approvalFlight: Promise<void> | null = null;
async function approveUpdate() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!clients.length) { await self.skipWaiting(); return; }
  const nonce = crypto.randomUUID();
  const replies = new Map<string, boolean>();
  const ready = await new Promise<boolean>(resolve => {
    const finish = () => {
      clearTimeout(timer); self.removeEventListener('message', reply);
      resolve(replies.size === clients.length && [...replies.values()].every(Boolean));
    };
    const reply = (event: ExtendableMessageEvent) => {
      if (event.data?.type !== 'TT_UPDATE_READY' || event.data.nonce !== nonce) return;
      const source = event.source as Client | null;
      if (!source || !clients.some(client => client.id === source.id)) return;
      replies.set(source.id, event.data.ready === true);
      if (replies.size === clients.length) finish();
    };
    const timer = setTimeout(finish, 3000);
    self.addEventListener('message', reply);
    clients.forEach(client => client.postMessage({ type: 'TT_UPDATE_CHECK', nonce }));
  });
  // Old clients do not speak this protocol: leave the worker waiting until those
  // tabs close, rather than provoking their legacy automatic reload callback.
  if (ready) await self.skipWaiting();
  else clients.forEach(client => client.postMessage({ type: 'TT_UPDATE_BLOCKED' }));
}
self.addEventListener('message', event => {
  // Deliberately ignore old workbox-window SKIP_WAITING messages: old open tabs
  // must not activate an update and trigger their legacy automatic reload hook.
  if (event.data?.type === 'TT_UPDATE_APPROVED') {
    if (!approvalFlight) approvalFlight = approveUpdate().finally(() => { approvalFlight = null; });
    event.waitUntil(approvalFlight);
  }
});
