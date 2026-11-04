import type { Asset, Booking } from '../types';

export function isBulkStock(asset: Asset): boolean {
  return asset.type !== 'Consumables' && (Boolean(asset.quantity_tracking) || asset.quantity !== 1);
}

export function quantityLimit(asset: Asset, form: any, action: string): number {
  const allocation = form.quantity_allocations?.[String(asset.id)];
  if (action === 'stage') return Math.max(0, Number(asset.quantity_available ?? asset.quantity));
  const field = action === 'return' ? 'dispatched' : action === 'verify_return' ? 'awaiting_verification' : 'reserved';
  return Math.max(0, Number(allocation?.[field] ?? 0));
}

export function dispatchQuantities(form: any, pool: Asset[]) {
  const items: { asset_id: number; quantity: number }[] = [], physical_asset_ids: number[] = [];
  for (const id of [...new Set<string>((form.staged_assets || []).map(String))]) {
    const asset = pool.find(a => String(a.id) === id);
    const allocation = form.quantity_allocations?.[id];
    if (allocation) {
      if (!Number.isInteger(allocation.reserved) || allocation.reserved <= 0) throw new Error('Reopen the event to review its reserved quantities.');
      items.push({ asset_id: Number(id), quantity: allocation.reserved });
    } else {
      if (!asset) throw new Error('Load the staged items before dispatching.');
      if (isBulkStock(asset) || asset.type === 'Consumables') throw new Error('An older quantity allocation needs warehouse review before dispatch.');
      physical_asset_ids.push(Number(id));
    }
  }
  return { action: 'dispatch', expected_revision: form.revision ?? 0, items, physical_asset_ids };
}

export function quantityLabel(form: Booking | any, assetId: string | number): string {
  const a = form.quantity_allocations?.[String(assetId)];
  return a ? `${a.reserved} packed · ${a.dispatched} on site · ${a.awaiting_verification} unchecked` : '';
}
