import { useEffect, useRef, useState } from 'react';
import { hasPendingWork } from './workSafety';

export function useAppUpdates() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateBlocked, setUpdateBlocked] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const approvedRef = useRef(false);
  const approvalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let disposed = false;
    const disposers: Array<() => void> = [];
    const controllerChanged = () => {
      // First installation/external activation never causes navigation.
      if (approvedRef.current) {
        if (approvalTimeoutRef.current) clearTimeout(approvalTimeoutRef.current);
        window.location.reload();
      } else { setUpdating(false); }
    };
    const workerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'TT_UPDATE_CHECK') {
        const ready = !hasPendingWork();
        if (ready) {
          setUpdating(true);
          if (approvalTimeoutRef.current) clearTimeout(approvalTimeoutRef.current);
          approvalTimeoutRef.current = setTimeout(() => { approvedRef.current = false; setUpdating(false); }, 15000);
        }
        (event.source as ServiceWorker | null)?.postMessage({ type: 'TT_UPDATE_READY', nonce: event.data.nonce, ready });
      } else if (event.data?.type === 'TT_UPDATE_BLOCKED') {
        approvedRef.current = false; setUpdating(false); setUpdateBlocked(true);
        if (approvalTimeoutRef.current) clearTimeout(approvalTimeoutRef.current);
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    navigator.serviceWorker.addEventListener('message', workerMessage);
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(registration => {
      if (disposed) return;
      registrationRef.current = registration;
      if (registration.waiting) setNeedRefresh(true);
      const check = () => {
        const worker = registration.installing;
        if (!worker) return;
        const changed = () => {
          if (worker.state === 'installed' && !disposed && registration.waiting) setNeedRefresh(true);
        };
        worker.addEventListener('statechange', changed);
        disposers.push(() => worker.removeEventListener('statechange', changed));
      };
      registration.addEventListener('updatefound', check); check();
      disposers.push(() => registration.removeEventListener('updatefound', check));
    }).catch(error => console.error('App update registration failed', error));
    return () => {
      disposed = true; disposers.forEach(dispose => dispose());
      if (approvalTimeoutRef.current) clearTimeout(approvalTimeoutRef.current);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      navigator.serviceWorker.removeEventListener('message', workerMessage);
    };
  }, []);
  const updateServiceWorker = async (_reload?: boolean) => {
    if (hasPendingWork() || !registrationRef.current?.waiting) return false;
    approvedRef.current = true;
    setUpdateBlocked(false);
    setUpdating(true);
    approvalTimeoutRef.current = setTimeout(() => {
      approvedRef.current = false; setUpdating(false);
    }, 15000);
    registrationRef.current.waiting.postMessage({ type: 'TT_UPDATE_APPROVED' });
    return true;
  };
  return { needRefresh: [needRefresh, setNeedRefresh] as const,
    offlineReady: [offlineReady, setOfflineReady] as const, updateServiceWorker, updating, updateBlocked };
}
