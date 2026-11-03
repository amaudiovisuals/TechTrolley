import type { Asset } from './types';

/** Refuse ambiguous identities instead of choosing whichever owner loaded first. */
export function resolveInventoryScan(pool: Asset[], input: string, normalize: (value: any) => string) {
  const scanned = input.trim();
  const fields = (asset: Asset) => [String(asset.id), asset.sku, asset.barcode, asset.qrCode, asset.serialNumber].filter(Boolean) as string[];
  const unique = (matches: Asset[]) => [...new Map(matches.map(asset => [String(asset.id), asset])).values()];
  const result = (matches: Asset[]) => ({ asset: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 });
  if (!scanned) return result([]);
  const exact = unique(pool.filter(asset => fields(asset).includes(scanned)));
  if (exact.length) return result(exact);
  const normalized = normalize(scanned);
  const matched = normalized ? unique(pool.filter(asset => fields(asset).some(value => normalize(value) === normalized))) : [];
  if (matched.length) return result(matched);
  const parts = scanned.split(/[ ,;]+/).map(normalize).filter(Boolean);
  return result(unique(pool.filter(asset => fields(asset).some(value => parts.includes(normalize(value))))));
}

/** Validate the complete, company-scoped response before replacing the current list. */
export function supplierInventoryRows(data: any, companyId: string | number): any[] {
  if (!Array.isArray(data)) throw new Error('Supplier inventory could not be loaded completely. Please retry.');
  if (data.some(row => !row?.id || String(row.subrental_company) !== String(companyId))) {
    throw new Error('Supplier inventory response did not match the selected company. Please retry.');
  }
  return data.filter(row => !row.is_temporary);
}

export function importOutcome(data: any, ok: boolean) {
  const errors: string[] = Array.isArray(data?.errors) ? data.errors.map(String) : [];
  if (!ok && errors.length === 0) errors.push(String(data?.error || data?.detail || 'Upload failed.'));
  const count = (value: any) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const created = count(data?.created), updated = count(data?.updated), skipped = count(data?.skipped);
  return { created, updated, skipped, errors, success: ok && errors.length === 0,
    text: errors.length ? `Import failed: ${errors.length} error(s). No inventory changes saved.`
      : `${created} created, ${updated} updated, ${skipped} skipped.` };
}

export function assetOwnerLabel(asset: Asset) {
  if (asset.subrental_company) return `Subrental: ${asset.subrental_company_name || `Company ${asset.subrental_company}`}`;
  return inventoryOwnerKey(asset) === 'manual' ? 'Manual additions' : 'Owned inventory';
}

export function inventoryOwnerKey(asset: Asset) {
  if (asset.subrental_company) return String(asset.subrental_company);
  return asset.isTemporary || (asset as any).is_temporary || String(asset.id).startsWith('new-') ? 'manual' : 'owned';
}

export function inventoryOwnerSections(assets: Asset[]) {
  const sections = new Map<string, { key: string; label: string; assets: Asset[] }>();
  for (const asset of assets) {
    const key = inventoryOwnerKey(asset);
    if (!sections.has(key)) sections.set(key, { key, label: assetOwnerLabel(asset), assets: [] });
    sections.get(key)!.assets.push(asset);
  }
  return [...sections.values()].sort((a, b) => a.key === b.key ? 0 : a.key === 'owned' ? -1 : b.key === 'owned' ? 1 : a.key === 'manual' ? 1 : b.key === 'manual' ? -1 : a.label.localeCompare(b.label));
}

export function overlappingSupplierSources(assets: Asset[], tickets: any[] = []) {
  const inventoryIds = new Set(assets.flatMap(asset => (asset as any).ids || [asset.id]).map(String));
  return tickets.some(ticket => ticket.items?.some((item: any) => inventoryIds.has(String(item.asset ?? item.asset_details?.id))));
}
