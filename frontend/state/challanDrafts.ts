import type { Asset } from '../types';

export interface ChallanDraft {
  schema: 2;
  baseRevision: number;
  documentId?: string | null;
  documentDate?: string | null;
  assets: Asset[];
  total: number | null;
  number: string | null;
  updatedAt: string;
}
export function challanDraftKey(origin: string, account: string, event: string, document: string) {
  return ['tt', 'draft', '2', origin, account, event, document].map(encodeURIComponent).join(':');
}
export function readDraft(storage: Pick<Storage, 'getItem'>, key: string): ChallanDraft | null {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null');
    if (value?.schema !== 2 || !Array.isArray(value.assets) || !Number.isInteger(value.baseRevision) || value.baseRevision < 0 ||
      !value.assets.every((asset: any) => asset && typeof asset === 'object' && asset.id != null) ||
      !(value.total === null || (typeof value.total === 'number' && Number.isFinite(value.total))) ||
      !(value.number === null || typeof value.number === 'string')) return null;
    if (value.documentId !== undefined && value.documentId !== null && typeof value.documentId !== 'string') return null;
    return value;
  } catch { return null; }
}
export function readLegacyChallan(storage: Pick<Storage, 'getItem'>, suffix: string) {
  try {
    const assets = JSON.parse(storage.getItem(`cache_challan_items_${suffix}`) || 'null');
    if (!Array.isArray(assets) || !assets.every(asset => asset && typeof asset === 'object' && asset.id != null)) return null;
    const value = storage.getItem(`cache_total_val_${suffix}`);
    return { assets, total: value !== null && Number.isFinite(Number(value)) ? Number(value) : null,
      number: storage.getItem(`cache_challan_no_${suffix}`) };
  } catch { return null; }
}
export function writeDraft(storage: Pick<Storage, 'setItem'>, key: string, value: ChallanDraft) {
  try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function removeDraft(storage: Pick<Storage, 'removeItem'>, key: string) {
  try { storage.removeItem(key); } catch { /* Keep the editor usable if browser storage is unavailable. */ }
}
export function acceptRevision(current: number | undefined, incoming: number | undefined) {
  return Number(incoming ?? 0) >= Number(current ?? 0);
}
