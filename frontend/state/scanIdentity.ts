import type { Asset } from '../types';
const normalize = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
export function resolveScan<T extends Pick<Asset, 'id' | 'sku' | 'barcode' | 'qrCode' | 'serialNumber'>>(text: string, pool: T[]) {
  const input = text.trim();
  if (!input || input.length > 2048) return { kind: 'invalid' as const };
  // Known label formats are accepted; arbitrary words/numbers are never DB IDs.
  const labelled = input.match(/^(?:SKU|BARCODE|QR|SERIAL)\s*:\s*([^\r\n]+)(?:\r?\n.*)?$/i);
  const candidate = normalize(labelled ? labelled[1] : input);
  if (!candidate || !/[A-Z0-9]/.test(candidate)) return { kind: 'invalid' as const };
  const matches = pool.filter(asset => [asset.sku, asset.barcode, asset.qrCode, asset.serialNumber]
    .some(value => value != null && normalize(value) !== '' && normalize(value) === candidate));
  const unique = [...new Map(matches.map(asset => [String(asset.id), asset])).values()];
  if (unique.length > 1) return { kind: 'ambiguous' as const, ids: unique.map(asset => asset.id) };
  return unique.length ? { kind: 'matched' as const, asset: unique[0] } : { kind: 'unknown' as const };
}
