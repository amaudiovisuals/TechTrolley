import type { Asset, Booking, DispatchOrigin } from '../types';

export function paperOrigins(booking: Booking, assets: Asset[]): DispatchOrigin[] {
  const ids = new Set(assets.map(asset => Number(asset.challanLine?.asset_id ?? asset.id)));
  const remaining=new Map(assets.map(asset=>[Number(asset.challanLine?.asset_id??asset.id),Number(asset.quantity)]));
  return (booking.dispatchOrigins || booking.dispatch_origins || []).flatMap(origin => {
    if (!origin.asset_ids.some(id=>ids.has(id))) return [];
    if (!origin.asset_quantities) return [origin];
    const chosen:Record<string,number>={};
    for (const [id,amount] of Object.entries(origin.asset_quantities)) {
      const count=Math.min(remaining.get(Number(id))||0,amount);
      if(count>0){chosen[id]=count;remaining.set(Number(id),(remaining.get(Number(id))||0)-count);}
    }
    return Object.keys(chosen).length?[{...origin,asset_ids:Object.keys(chosen).map(Number),asset_quantities:chosen}]:[];
  });
}
