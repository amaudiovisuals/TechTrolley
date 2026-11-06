import type { Booking, TruckChallan } from '../types';

/** Historical dispatch membership and present return custody are separate lists. */
export function challanAssetIds(booking: Booking, mode: 'dispatch' | 'return', truck?: TruckChallan | null): string[] {
  const base = mode === 'return' ? (booking.assets || []).map(String)
    : booking.challanAssets?.length ? booking.challanAssets.map(String)
    : [...(booking.assets || []), ...(booking.staged_assets || [])].map(String);
  if (!truck) return [...new Set(base)];
  const assigned = new Set((booking.truckChallans || []).flatMap(row => row.assets || []).map(String));
  const truckIds = [...(truck.assets || []).map(String), ...(truck.truck_number === 1 ? base.filter(id => !assigned.has(id)) : [])];
  return [...new Set(truckIds)].filter(id => mode !== 'return' || base.includes(id));
}
