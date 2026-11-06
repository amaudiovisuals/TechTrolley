import type { Asset, Booking, DispatchOrigin } from '../types';

export function paperOrigins(booking: Booking, assets: Asset[]): DispatchOrigin[] {
  const ids = new Set(assets.map(asset => Number(asset.challanLine?.asset_id ?? asset.id)));
  return (booking.dispatchOrigins || booking.dispatch_origins || []).filter(origin => origin.asset_ids.some(id => ids.has(id)));
}
