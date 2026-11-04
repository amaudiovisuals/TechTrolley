import type { Asset, Booking, ChallanDocument, ChallanLine } from '../types';

// Deterministic UUID-shaped identity for unsaved legacy source rows. The database
// checks global line ownership; manual rows use crypto.randomUUID().
function sourceId(scope: string, source: string): string {
  const input = `${scope}:${source}`;
  const parts = [0, 1, 2, 3].map(seed => {
    let hash = 2166136261 ^ seed;
    for (const character of input) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');
  return `${parts.slice(0, 8)}-${parts.slice(8, 12)}-4${parts.slice(13, 16)}-8${parts.slice(17, 20)}-${parts.slice(20)}`;
}

export function documentScope(suffix?: string): string {
  return suffix?.startsWith('__truckId') ? `truck-${suffix.slice(9)}` : 'master';
}

export function lineAsset(line: ChallanLine): Asset {
  const s = line.snapshot;
  return { id: line.id, challanLine: line, sku: s.sku || '', aliasName: s.alias_name || s.description || s.sku || '',
    serialNumber: s.serial_number || '', description: s.description || '', type: s.type || 'Other',
    macAddress: s.mac_address || '', imeiNumber1: s.imei_number_1 || '', imeiNumber2: s.imei_number_2 || '',
    quantity: line.quantity, itemPrice: Number(line.unit_value), depreciationPercentage: 0,
    purchasedDate: '', createdAt: '', availableFrom: '', availableTill: '', lastMaintained: '',
    isBarcodeAdded: false, barcode: '', status: 'Available' as any, condition: '',
    subrental_company: line.supplier_id, current_value: Number(line.unit_value) } as Asset;
}

export function assetLine(asset: Asset, scope: string, position: number): ChallanLine {
  const original = asset.challanLine;
  const manual = !original && String(asset.id).startsWith('new-');
  const supplierId = original?.supplier_id ?? (asset.subrental_company ? Number(asset.subrental_company) : null);
  const manualId = String(asset.id).slice(4);
  return { id: original?.id || (manual ? /^[0-9a-f-]{36}$/i.test(manualId) ? manualId : sourceId(scope, `manual-${asset.id}`) : sourceId(scope, `asset-${asset.id}`)),
    asset_id: original ? original.asset_id : manual ? null : Number(asset.id),
    ticket_item_id: original?.ticket_item_id ?? null, supplier_id: manual ? null : supplierId,
    source_kind: original?.source_kind || (manual ? 'manual' : supplierId ? 'supplier' : 'owned'),
    snapshot: { sku: asset.sku || '', alias_name: asset.aliasName || '', serial_number: asset.serialNumber || '',
      description: asset.description || '', type: asset.type || 'Other', mac_address: asset.macAddress || '',
      imei_number_1: asset.imeiNumber1 || '', imei_number_2: asset.imeiNumber2 || '',
      supplier_name: original?.snapshot.supplier_name || asset.subrental_company_name || '' },
    quantity: Number(asset.quantity), unit_value: documentUnitValue(asset).toFixed(2), position };
}

export type DocumentSourceWarning = { assetId: string; message: string };

// Embedded event metadata is available even when the global inventory page/cache
// has not loaded. It describes a source; saved document lines remain snapshots.
export function documentSourceAssets(assets: Asset[], booking: Booking): Asset[] {
  const result = new Map(assets.map(asset => [String(asset.id), asset]));
  for (const raw of [...(booking.challan_assets_details || []), ...(booking.quantity_assets_details || []), ...(booking.consumable_assets_details || [])]) {
    result.set(String(raw.id), { ...raw, id: String(raw.id), sku: raw.sku || '', aliasName: raw.alias_name || raw.sku || '',
      serialNumber: raw.serial_number || '', itemPrice: Number(raw.item_price ?? 0),
      depreciationPercentage: Number(raw.depreciation_percentage ?? 0), purchasedDate: raw.purchased_date || '',
      macAddress: raw.mac_address || '', imeiNumber1: raw.imei_number_1 || '', imeiNumber2: raw.imei_number_2 || '' } as Asset);
  }
  return [...result.values()];
}

export function documentSourceWarnings(assets: Asset[], booking: Booking, scope: string, mode: 'dispatch' | 'return' = 'dispatch'): DocumentSourceWarning[] {
  if (scope !== 'master') {
    return assets.some(asset => asset.type === 'Consumables') || hasRecordedQuantities(booking)
      ? [{ assetId: 'truck-coordination', message: 'Truck quantities require coordinated manifest review before a new challan can be prepared.' }] : [];
  }
  const sources = documentSourceAssets(assets, booking), warnings: DocumentSourceWarning[] = [];
  if (booking.consumable_data && (typeof booking.consumable_data !== 'object' || Array.isArray(booking.consumable_data))) {
    warnings.push({ assetId: 'legacy-data', message: 'Consumable records have an invalid legacy format and need review before inclusion.' });
  }
  if (mode === 'return') for (const input of assets) {
    const asset = sources.find(source => String(source.id) === String(input.id)) || input;
    if (asset.type !== 'Consumables' && (asset.quantity_tracking || asset.quantity !== 1) && !booking.quantity_allocations?.[String(asset.id)]) {
      warnings.push({ assetId: String(asset.id), message: `Bulk source #${asset.id} has no recorded return balance; warehouse stock was not used as a return count.` });
    }
  }
  const entries = { ...booking.consumable_data, ...booking.consumable_ledger };
  for (const [id, row] of Object.entries(booking.quantity_allocations || {})) {
    const quantity = mode === 'return' ? row.dispatched : Number(row.dispatched_total || 0) + Number(row.reserved || 0);
    if (quantity > 0 && !sources.some(asset => String(asset.id) === id)) warnings.push({ assetId: id, message: `Bulk source #${id} is missing its source details. Reload the event before printing.` });
  }
  for (const [id, data] of Object.entries(entries)) {
    if (Number(data?.requested || 0) <= 0) continue;
    if (!booking.consumable_ledger?.[id]?.ledger) warnings.push({ assetId: id, message: `Consumable #${id} needs legacy quantity/settlement review before inclusion.` });
    else if (!sources.some(asset => String(asset.id) === id)) warnings.push({ assetId: id, message: `Consumable #${id} is missing its source details. Reload the event before printing.` });
    else if (mode === 'return' && data.returned == null) warnings.push({ assetId: id, message: `Consumable #${id}: return count has not been entered; no return quantity was assumed.` });
    else if (mode === 'return' && data.status !== 'settled') warnings.push({ assetId: id, message: `Consumable #${id}: reported return count awaits warehouse settlement.` });
  }
  return warnings;
}

export function legacyDocumentAssets(assets: Asset[], tickets: any[], booking: Booking, scope: string, identityScope = scope, mode: 'dispatch' | 'return' = 'dispatch'): Asset[] {
  const result: ChallanLine[] = [];
  const sources = documentSourceAssets(assets, booking);
  const inputs = new Map(assets.map(asset => [String(asset.id), asset]));
  if (scope === 'master') for (const [id, row] of Object.entries(booking.quantity_allocations || {})) {
    const quantity = mode === 'return' ? row.dispatched : Number(row.dispatched_total || 0) + Number(row.reserved || 0);
    const asset = sources.find(source => String(source.id) === id);
    if (quantity > 0 && asset) inputs.set(id, asset);
  }
  for (const input of inputs.values()) {
    const asset = scope === 'master' ? sources.find(source => String(source.id) === String(input.id)) || input : input;
    // Keep both sources visible when they overlap; reviewed import/save guards
    // refuse the ambiguity rather than replacing a warehouse scan with a ticket.
    // Consumables come only from the recorded event ledger below. Total warehouse
    // stock and old unverified JSON are not delivery or return quantities.
    if (asset.type === 'Consumables') continue;
    const allocation = booking.quantity_allocations?.[String(asset.id)];
    if (mode === 'return' && (asset.quantity_tracking || asset.quantity !== 1) && !allocation) continue;
    const line = assetLine(asset, identityScope, result.length);
    if (allocation && scope === 'master') line.quantity = mode === 'return' ? allocation.dispatched : Number(allocation.dispatched_total || 0) + Number(allocation.reserved || 0);
    if (line.quantity > 0) result.push(line);
  }
  // Ticket items are canonical rental sources and appear once, in every document
  // that explicitly imports them. New truck documents start without supplier tickets.
  for (const ticket of mode === 'return' ? [] : tickets) for (const item of ticket.items || []) {
    const a = item.asset_details || {};
    const recorded = item.supplier_balance;
    if (recorded?.state === 'inconsistent' || recorded?.state === 'recorded' && recorded.received <= 0) continue;
    result.push({ id: sourceId(identityScope, `ticket-${item.id}`), asset_id: Number(item.asset),
      ticket_item_id: Number(item.id), supplier_id: Number(ticket.company), source_kind: 'supplier',
      snapshot: { sku: a.sku || '', alias_name: a.aliasName || a.alias_name || a.sku || 'Rental item',
        serial_number: a.serialNumber || a.serial_number || '', description: a.description || '',
        type: a.type || 'Other', supplier_name: ticket.company_name || '' },
      quantity: Number(recorded?.state === 'recorded' ? recorded.received : item.quantity), unit_value: String(item.rental_price ?? 0), position: result.length });
  }
  for (const [id, data] of Object.entries(booking.consumable_ledger || {})) {
    if (!data.ledger) continue;
    const quantity = mode === 'return' ? data.returned == null ? 0 : Number(data.returned) : Number(data.requested || 0);
    if (scope !== 'master' || quantity <= 0 || result.some(line => String(line.asset_id) === id)) continue;
    const a = sources.find(asset => String(asset.id) === id);
    if (!a) continue; // Missing legacy metadata requires review, never an invented item.
    result.push({ ...assetLine(a, identityScope, result.length), quantity });
  }
  // A return preview has today's recorded balances but keeps the corresponding
  // dispatch description, owner and value. It never invents a supplier return.
  const savedDocument = mode === 'return' ? booking.challan_documents?.find(document => document.scope === scope) : undefined;
  return result.map(line => {
    const saved = savedDocument?.lines.find(source => !source.ticket_item_id && source.asset_id === line.asset_id);
    return lineAsset(saved ? { ...saved, quantity: line.quantity } : line);
  });
}

export function hasRecordedQuantities(booking: Booking): boolean {
  return Object.keys(booking.quantity_allocations || {}).length > 0 || Object.keys(booking.consumable_ledger || {}).length > 0;
}

export function masterQuantityPreview(booking: Booking, assets: Asset[], mode: 'dispatch' | 'return'): Asset[] {
  const ids = mode === 'return' ? booking.assets || [] : booking.challanAssets?.length ? booking.challanAssets : [...(booking.assets || []), ...(booking.staged_assets || [])];
  const selected = new Set(ids.map(String));
  return legacyDocumentAssets(documentSourceAssets(assets, booking).filter(asset => selected.has(String(asset.id))), [], booking, 'master', `${booking.id}:master`, mode);
}

export function snapshotBooking(booking: Booking, document?: ChallanDocument | null): Booking {
  if (!document) return booking;
  if (document.state === 'draft') return { ...booking, challanNumber: document.number,
    challanDate: document.document_date || '', approximate_value: document.total_override === null ? null : Number(document.total_override) } as Booking;
  const h = document.header;
  return { ...booking, conferenceName: h.name ?? booking.conferenceName,
    associationName: h.association_name ?? booking.associationName,
    billingAddress: h.billing_address ?? booking.billingAddress,
    transportAddress: h.transport_address ?? booking.transportAddress, venue: h.transport_address ?? booking.venue,
    gstNumber: h.gst_number ?? booking.gstNumber, vehicleNumber: h.vehicle_number ?? booking.vehicleNumber,
    driverPhone: h.driver_phone ?? booking.driverPhone, startDate: h.start_date ?? booking.startDate,
    endDate: h.end_date ?? booking.endDate, contactPerson: h.contact_person ?? booking.contactPerson,
    contactPhone: h.contact_phone ?? booking.contactPhone, contactEmail: h.contact_email ?? booking.contactEmail,
    challanNumber: document.number, challanDate: document.document_date || '',
    approximate_value: document.total_override === null ? null : Number(document.total_override) } as Booking;
}

export function documentUnitValue(a: Asset): number {
    if (a.challanLine) return Number(a.itemPrice ?? 0);
    if ((a as any).current_value !== undefined && (a as any).current_value !== null) {
      return parseFloat((a as any).current_value);
    }
    const price = a.itemPrice || 0;
    const depRate = a.depreciationPercentage || 0;
    const originDateStr = a.purchasedDate || a.createdAt;

    if (!originDateStr || depRate <= 0) {
      return price;
    }

    const originDate = new Date(originDateStr);
    if (isNaN(originDate.getTime())) {
      return price;
    }

    let wdv = price;
    const now = new Date();

    // Indian Financial Year starts April 1st (month 3)
    const getFY = (date: Date) => date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
    
    const startFY = getFY(originDate);
    const currentFY = getFY(now);

    for (let fy = startFY; fy <= currentFY; fy++) {
      let appliedRate = depRate;
      
      // 180-Day Rule for the first financial year
      if (fy === startFY) {
        // Cutoff is Oct 4th of the starting Financial Year
        const cutoffDate = new Date(startFY, 9, 4); // Month 9 is October
        if (originDate >= cutoffDate) {
          appliedRate = depRate / 2;
        }
      }
      
      wdv -= wdv * (appliedRate / 100);
    }

    return wdv;
  }
