import React from 'react';
import { Booking, Asset, Client, CompanySettings } from '../types';
import { Logo } from './Logo';

interface ChallanViewProps {
  booking: Booking;
  client: Client;
  assets: Asset[];
  companySettings?: CompanySettings;
  onUpdateAsset?: (assetId: string, updates: Partial<Asset>) => Promise<void>;
  onAddAdhocItem?: (item: Partial<Asset>) => Promise<void>;
  onUpdateConferenceValue?: (conferenceId: string, value: number) => Promise<void>;
  onRemoveAssets?: (assetIds: string[]) => Promise<void>;
  showScanToast?: (msg: string, type: 'success' | 'warning' | 'error') => void;
  onUpdateChallanNumber?: (conferenceId: string, challanNumber: string) => Promise<void>;
  subrentalTickets?: any[];
}

type ColumnKey = 'Seq' | 'SKU' | 'Asset' | 'Type' | 'Identifiers' | 'MAC' | 'IMEI' | 'Rate' | 'Qty' | 'Total' | 'Actions';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  width?: string;
  className?: string;
  printHidden?: boolean;
}

const ALL_COLUMNS: ColumnDef[] = [
  { key: 'Seq', label: 'Seq', width: 'w-6', className: 'w-6' },
  { key: 'SKU', label: 'SKU', width: 'w-24', className: 'w-24' },
  { key: 'Asset', label: 'Asset Specification' },
  { key: 'Type', label: 'Type' },
  { key: 'Identifiers', label: 'Identifiers' },
  { key: 'MAC', label: 'MAC Address' },
  { key: 'IMEI', label: 'IMEI (1/2)' },
  { key: 'Rate', label: 'Unit Rate', width: 'w-16', className: 'w-16', printHidden: true },
  { key: 'Qty', label: 'Qty', width: 'w-10', className: 'w-10 text-right' },
  { key: 'Total', label: 'Total', width: 'w-20', className: 'w-20 text-right', printHidden: true },
  { key: 'Actions', label: 'Actions', className: 'w-10 print:hidden' },
];

// Converts a number to Indian-style words (e.g. 45000 → "Rupees Forty Five Thousand Only")
const numberToWords = (num: number): string => {
  if (num === 0) return 'Rupees Zero Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const toWords = (n: number): string => {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '') + ' ';
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred ' + toWords(n % 100);
    if (n < 100000) return toWords(Math.floor(n / 1000)) + 'Thousand ' + toWords(n % 1000);
    if (n < 10000000) return toWords(Math.floor(n / 100000)) + 'Lakh ' + toWords(n % 100000);
    return toWords(Math.floor(n / 10000000)) + 'Crore ' + toWords(n % 10000000);
  };
  return 'Rupees ' + toWords(Math.round(num)).trim() + ' Only';
};

// Formats a date string (YYYY-MM-DD or DD/MM/YYYY) to DD/MM/YYYY
const fmtDate = (d?: string): string => {
  if (!d) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d;
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
};

export const ChallanView: React.FC<ChallanViewProps> = ({
  booking, client, assets, companySettings, onUpdateAsset, onAddAdhocItem, showScanToast, onUpdateConferenceValue, onRemoveAssets, onUpdateChallanNumber, subrentalTickets
}) => {
  const copies = [
    { label: 'Original for Recipient', key: 'ORIG' },
    { label: 'Duplicate for Transporter', key: 'TRANS' },
    { label: 'Triplicate for Supplier', key: 'SUPP' }
  ];

  const [visibleColumns, setVisibleColumns] = React.useState<ColumnKey[]>(() => {
    try {
      const stored = localStorage.getItem('challan_visible_columns');
      if (stored) return JSON.parse(stored);
    } catch (e) { }
    return ['Seq', 'Asset', 'Identifiers', 'Qty', 'Total'];
  });

  const [isEditMode, setIsEditMode] = React.useState(false);
  const [localAssets, setLocalAssets] = React.useState<Asset[]>(assets);
  const [totalValueOverride, setTotalValueOverride] = React.useState<number | null>(() => {
    try {
      const stored = localStorage.getItem(`cache_total_val_${booking.id}`);
      if (stored) return parseFloat(stored);
    } catch (e) { }
    return booking.approximate_value || null;
  });
  const [challanNoOverride, setChallanNoOverride] = React.useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(`cache_challan_no_${booking.id}`);
      if (stored) return stored;
    } catch (e) { }
    return booking.challanNumber || null;
  });

  React.useEffect(() => {
    localStorage.setItem('challan_visible_columns', JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  React.useEffect(() => {
    // Only update localAssets if we are NOT in edit mode
    // This prevents losing ad-hoc items or pending edits when props update
    if (!isEditMode) {
      setLocalAssets(assets.map(a => ({
        ...a,
        aliasName: (a.aliasName !== null && a.aliasName !== undefined) ? a.aliasName : a.sku
      })));
    }
  }, [assets, isEditMode]);

  const toggleColumn = (key: ColumnKey) => {
    setVisibleColumns(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleLocalUpdate = (id: string, field: keyof Asset, value: any) => {
    setLocalAssets(prev => prev.map(a => a.id === id ? { ...a, [field]: value } : a));
  };

  const removeRow = (id: string) => {
    setLocalAssets(prev => prev.filter(a => a.id !== id));
  };

  const saveAllChanges = async () => {
    try {
      // 1. Process removals in batch
      const originalIds = assets.map(a => String(a.id));
      const currentIds = localAssets.map(a => String(a.id));
      const removedIds = originalIds.filter(id => !currentIds.includes(id));

      if (removedIds.length > 0 && onRemoveAssets) {
        console.log("Removing assets from conference:", removedIds);
        await onRemoveAssets(removedIds);
      }

      for (const asset of localAssets) {
        const isNew = String(asset.id).startsWith('new-');

        if (isNew) {
          if (onAddAdhocItem) {
            console.log("Saving new ad-hoc item:", asset.sku);
            // Must map camelCase to snake_case for API
            await onAddAdhocItem({
              sku: asset.sku,
              alias_name: asset.aliasName,
              quantity: asset.quantity,
              item_price: asset.itemPrice,
              depreciation_percentage: asset.depreciationPercentage,
              serial_number: asset.serialNumber,
              type: asset.type,
            } as any);
          }
        } else {
          if (onUpdateAsset) {
            const original = assets.find(a => String(a.id) === String(asset.id));
            if (original && (
              original.aliasName !== asset.aliasName ||
              original.sku !== asset.sku ||
              original.quantity !== asset.quantity ||
              original.itemPrice !== asset.itemPrice ||
              original.serialNumber !== asset.serialNumber
            )) {
              console.log("Updating existing asset:", asset.id);
              // Backend expects snake_case
              const updates: any = {};
              if (original.aliasName !== asset.aliasName) updates.alias_name = asset.aliasName;
              if (original.sku !== asset.sku) updates.sku = asset.sku;
              if (original.quantity !== asset.quantity) updates.quantity = asset.quantity;
              if (original.itemPrice !== asset.itemPrice) updates.item_price = asset.itemPrice;
              if (original.serialNumber !== asset.serialNumber) updates.serial_number = asset.serialNumber;
              await onUpdateAsset(String(asset.id), updates);
            }
          }
        }
      }

      // 2. Save approximate goods value override if changed
      if (totalValueOverride !== null && totalValueOverride !== booking.approximate_value) {
        localStorage.setItem(`cache_total_val_${booking.id}`, totalValueOverride.toString());
        if (onUpdateConferenceValue) {
          console.log("Saving conference value override:", totalValueOverride);
          await onUpdateConferenceValue(booking.id, totalValueOverride);
        }
      }

      // 3. Save challan number if changed
      if (challanNoOverride !== null && challanNoOverride !== booking.challanNumber) {
        localStorage.setItem(`cache_challan_no_${booking.id}`, challanNoOverride);
        if (onUpdateChallanNumber) {
          console.log("Saving challan number override:", challanNoOverride);
          await onUpdateChallanNumber(booking.id, challanNoOverride);
        }
      }

      showScanToast && showScanToast("✅ All changes saved successfully", "success");
    } catch (err) {
      console.error("Critical error during saveAllChanges:", err);
      alert("Failed to save some changes. Check console for details.");
    }
    setIsEditMode(false);
  };

  const addRow = () => {
    const defaultSku = `ADHOC-${localAssets.length + 1}`;
    const newItem: Asset = {
      id: `new-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sku: defaultSku,
      aliasName: defaultSku,
      serialNumber: '',
      type: 'Other',
      quantity: 1,
      itemPrice: 0,
      status: 'In Use' as any,
      barcode: '',
      condition: 'Good',
      description: 'Manually added to challan',
      isBarcodeAdded: false,
      macAddress: '',
      imeiNumber1: '',
      imeiNumber2: '',
      purchasedDate: new Date().toISOString().split('T')[0],
      depreciationPercentage: 0,
      availableFrom: '',
      availableTill: '',
      createdAt: new Date().toISOString(),
      lastMaintained: ''
    };
    setLocalAssets(prev => [...prev, newItem]);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── Customization Toolbar (Hidden in Print) ── */}
      <div className="print:hidden bg-white p-4 rounded-xl shadow-sm border border-slate-200 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-sky-50 rounded-lg flex items-center justify-center text-sky-600">
              <i className="fa-solid fa-sliders"></i>
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-tighter">Challan Customization</h3>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Toggle columns & edit details</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setIsEditMode(!isEditMode)}
              className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isEditMode ? 'bg-orange-500 text-white shadow-lg shadow-orange-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
            >
              <i className={`fa-solid ${isEditMode ? 'fa-check' : 'fa-pen-to-square'} mr-2`}></i>
              {isEditMode ? 'Close Edit Mode' : 'Edit Mode'}
            </button>
            {isEditMode && (
              <>
                <button
                  onClick={addRow}
                  className="px-4 py-2 bg-sky-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest shadow-lg shadow-sky-200 hover:bg-sky-600"
                >
                  <i className="fa-solid fa-plus mr-2"></i>
                  Add Item
                </button>
                <button
                  onClick={saveAllChanges}
                  className="px-4 py-2 bg-emerald-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest shadow-lg shadow-emerald-200 hover:bg-emerald-600"
                >
                  <i className="fa-solid fa-floppy-disk mr-2"></i>
                  Save Changes
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
          {ALL_COLUMNS.map(col => (
            <button
              key={col.key}
              onClick={() => toggleColumn(col.key)}
              className={`px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest border transition-all ${visibleColumns.includes(col.key)
                ? 'bg-sky-50 border-sky-200 text-sky-600'
                : 'bg-white border-slate-200 text-slate-400 opacity-60'
                }`}
            >
              {col.label}
            </button>
          ))}
        </div>
      </div>

      {copies.map((copy, index) => (
        <div
          key={copy.key}
          className="print:w-full print:flex print:flex-col"
          style={{ pageBreakAfter: index < copies.length - 1 ? 'always' : 'auto' }}
        >
          <ChallanTemplate
            booking={booking}
            client={client}
            assets={localAssets}
            companySettings={companySettings}
            copyLabel={copy.label}
            bw={false}
            visibleColumns={isEditMode ? [...visibleColumns, 'Actions' as ColumnKey] : visibleColumns}
            isEditMode={isEditMode && index === 0} // ONLY the first copy is editable, others are live previews
            onLocalUpdate={handleLocalUpdate}
            onRemoveRow={removeRow}
            totalOverride={totalValueOverride}
            setTotalOverride={setTotalValueOverride}
            challanNoOverride={challanNoOverride}
            setChallanNoOverride={setChallanNoOverride}
            subrentalTickets={subrentalTickets}
          />
        </div>
      ))}
    </div>
  );
};

interface ChallanTemplateProps extends Omit<ChallanViewProps, 'assets'> {
  assets: Asset[];
  copyLabel: string;
  bw: boolean;
  visibleColumns: ColumnKey[];
  isEditMode: boolean;
  onLocalUpdate: (id: string, field: keyof Asset, value: any) => void;
  onRemoveRow: (id: string) => void;
  totalOverride: number | null;
  setTotalOverride: (val: number | null) => void;
  challanNoOverride: string | null;
  setChallanNoOverride: (val: string | null) => void;
  subrentalTickets?: any[];
}

const ChallanTemplate: React.FC<ChallanTemplateProps> = ({
  booking, client, assets, companySettings, copyLabel, bw,
  visibleColumns, isEditMode, onLocalUpdate, onRemoveRow,
  totalOverride, setTotalOverride, challanNoOverride, setChallanNoOverride,
  subrentalTickets
}) => {
  const accent = bw ? '#111111' : '#00AEEF';
  const orange = bw ? '#111111' : '#F15A24';
  const venueBg = bw ? '#f5f5f5' : '#f0f9ff';
  const venueBrd = bw ? '#999999' : '#bae6fd';
  const venueHd = bw ? '#111111' : '#0369a1';
  const venueTxt = bw ? '#111111' : '#0c4a6e';
  const hdrBg = '#ffffff'; // explicitly white for headings

  const getDepreciatedPrice = (a: Asset) => {
    const price = a.itemPrice || 0;
    const dep = a.depreciationPercentage || 0;
    return price * (1 - dep / 100);
  };

  const subrentalTotal = subrentalTickets?.reduce((sum, t) =>
    sum + (t.items?.reduce((iSum: number, item: any) => iSum + (Number(item.rental_price) * item.quantity), 0) || 0), 0) || 0;

  const totalValue = totalOverride !== null
    ? totalOverride
    : assets.reduce((sum, a) => sum + (getDepreciatedPrice(a) * (a.quantity || 1)), 0) + subrentalTotal;

  const renderCell = (asset: Asset, col: ColumnKey, index: number) => {
    if (isEditMode) {
      switch (col) {
        case 'Asset':
          return (
            <div className="flex flex-col">
              <input
                className="w-full bg-slate-50 border-none p-0 text-[8px] font-black uppercase print:hidden"
                value={asset.aliasName ?? ''}
                onChange={e => onLocalUpdate(asset.id, 'aliasName', e.target.value)}
              />
              <span className="hidden print:block font-black uppercase text-[8px] tracking-tighter">{asset.aliasName || ' '}</span>
            </div>
          );
        case 'SKU':
          return (
            <div className="flex flex-col">
              <input
                className="w-full bg-slate-50 border-none p-0 text-[8px] font-mono print:hidden"
                value={asset.sku}
                onChange={e => onLocalUpdate(asset.id, 'sku', e.target.value)}
              />
              <span className="hidden print:block font-mono">{asset.sku}</span>
            </div>
          );
        case 'Rate':
          return (
            <div className="flex items-center justify-end">
              <input
                type="number"
                className="w-full bg-slate-50 border-none p-0 text-[8px] text-right print:hidden"
                value={Math.round(getDepreciatedPrice(asset))}
                onChange={e => {
                  const val = parseFloat(e.target.value) || 0;
                  const newRate = parseFloat(val.toFixed(2));
                  onLocalUpdate(asset.id, 'itemPrice', newRate);
                  onLocalUpdate(asset.id, 'depreciationPercentage', 0);
                }}
              />
              <span className="hidden print:block">{Math.round(getDepreciatedPrice(asset)).toLocaleString()}</span>
            </div>
          );
        case 'Qty':
          return (
            <div className="flex items-center justify-end">
              <input
                type="number"
                className="w-full bg-slate-50 border-none p-0 text-[8px] text-right font-black print:hidden"
                value={asset.quantity}
                onChange={e => onLocalUpdate(asset.id, 'quantity', parseInt(e.target.value))}
              />
              <span className="hidden print:block font-black">{asset.quantity}</span>
            </div>
          );
        case 'Identifiers':
          return (
            <div className="flex flex-col">
              <input
                className="w-full bg-slate-50 border-none p-0 text-[8px] font-mono print:hidden"
                value={asset.serialNumber}
                onChange={e => onLocalUpdate(asset.id, 'serialNumber', e.target.value)}
              />
              <span className="hidden print:block">{asset.serialNumber}</span>
            </div>
          );
        case 'Total':
          return (
            <div className="flex items-center justify-end">
              <input
                type="number"
                className="w-full bg-slate-50 border-none p-0 text-[8px] text-right font-black print:hidden"
                value={Math.round(getDepreciatedPrice(asset) * (asset.quantity || 1))}
                onChange={e => {
                  const val = parseFloat(e.target.value) || 0;
                  const newRate = parseFloat((val / (asset.quantity || 1)).toFixed(2));
                  onLocalUpdate(asset.id, 'itemPrice', newRate);
                  onLocalUpdate(asset.id, 'depreciationPercentage', 0);
                }}
              />
              <span className="hidden print:block font-black">{Math.round(getDepreciatedPrice(asset) * (asset.quantity || 1)).toLocaleString()}</span>
            </div>
          );
        case 'Actions':
          return (
            <button
              onClick={() => onRemoveRow(asset.id)}
              className="text-red-500 hover:text-red-700 transition-colors p-1"
              title="Delete Row"
            >
              <i className="fa-solid fa-trash-can"></i>
            </button>
          );
      }
    }

    // Default Read-only render
    switch (col) {
      case 'Seq': return index + 1;
      case 'SKU': return asset.sku;
      case 'Asset': return (
        <>
          <span className="font-black text-gray-900 uppercase tracking-tighter mr-2">{asset.aliasName !== '' ? asset.aliasName : ' '}</span>
          {!visibleColumns.includes('Type') && (
            <span className="text-[7px] font-bold uppercase tracking-widest print:hidden" style={{ color: accent }}>{asset.type}</span>
          )}
        </>
      );
      case 'Type': return asset.type;
      case 'Identifiers': return `${asset.serialNumber} / ${asset.sku}`;
      case 'MAC': return asset.macAddress || '—';
      case 'IMEI': return `${asset.imeiNumber1 || '—'} / ${asset.imeiNumber2 || '—'}`;
      case 'Rate': return `₹${Math.round(getDepreciatedPrice(asset)).toLocaleString()}`;
      case 'Qty': return asset.quantity || 1;
      case 'Total': return `₹${Math.round(getDepreciatedPrice(asset) * (asset.quantity || 1)).toLocaleString()}`;
      default: return null;
    }
  };

  return (
    <div className="p-6 bg-white max-w-[210mm] mx-auto shadow-sm border border-gray-200 rounded-md my-4 font-sans print:shadow-none print:m-0 print:p-[10mm] print:w-[210mm] print:min-h-[297mm] print:box-border print:border-none print:rounded-none relative flex flex-col justify-between print:block">
      {/* Header, Consignee sections remain unchanged (already premium) */}
      <div className="flex justify-between items-start pb-2 mb-2" style={{ borderBottom: `2px solid ${accent}` }}>
        <div>
          <Logo size="sm" companySettings={companySettings} variant="challan" showText={false} />
          <div className="mt-1 text-[9px] text-gray-900 font-medium leading-snug">
            <p className="font-black text-gray-900 uppercase tracking-tighter text-[10px]">{companySettings?.name || 'TECH TROLLEY'}</p>
            <p className="whitespace-pre-wrap">{companySettings?.address || 'Warehouse Complex 7, Industrial Area Phase II, New Delhi - 110020.'}</p>
            <p>GST: {companySettings?.gst_number || '07AAMAU9988Z2Z1'}</p>
            <p>Tel: {companySettings?.phone || '+91 9999 888 777'} | Email: {companySettings?.email || 'support@amaudiovisuals.in'}</p>
          </div>
        </div>
        <div className="text-right">
          <div className="mb-0.5">
            <span className="text-[8px] font-black uppercase tracking-widest border border-gray-900 px-2 py-0.5 rounded text-gray-900">{copyLabel}</span>
          </div>
          <div>
            <h2 className="text-lg font-black text-gray-900 tracking-tighter uppercase leading-none">Delivery Challan</h2>
            <div className="text-[9px] font-black uppercase tracking-widest flex items-center justify-end gap-1 mt-1" style={{ color: orange }}>
              <span>Challan No:</span>
              {isEditMode ? (
                <input
                  type="text"
                  className="bg-white border text-gray-900 border-slate-200 rounded px-1 w-24 text-right print:hidden"
                  value={challanNoOverride || ''}
                  onChange={e => setChallanNoOverride(e.target.value)}
                />
              ) : ''}
              <span className={isEditMode ? 'hidden print:inline-block' : ''}>{challanNoOverride || booking.challanNumber}</span>
            </div>
            <div className="mt-0.5 text-right">
              <p className="text-[9px] font-black text-gray-900 uppercase tracking-widest">
                <span className="text-gray-900 mr-1"> CHALLAN Date:</span>
                {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              </p>
            </div>
            <div className="mt-1 pt-1 text-right space-y-0.5" style={{ borderTop: `1px dashed #999` }}>
              <p className="text-[7px] font-black text-gray-900 uppercase tracking-[0.3em]">Vehicle Details</p>
              <p className="text-[9px] font-bold text-gray-900 flex items-center justify-end gap-1.5">
                <i className="fa-solid fa-truck text-[8px]" style={{ color: orange }}></i>
                <span className="text-gray-900">Vehicle No:</span>
                <span className="font-black uppercase tracking-wider">{booking.vehicleNumber || '—'}</span>
              </p>
              <p className="text-[9px] font-bold text-gray-900 flex items-center justify-end gap-1.5">
                <i className="fa-solid fa-phone text-[8px]" style={{ color: accent }}></i>
                <span className="text-gray-900">Driver Ph:</span>
                <span className="font-black tracking-wider">{booking.driverPhone || '—'}</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <h4 className="text-[7px] font-black text-gray-900 uppercase tracking-[0.3em] mb-0.5">Service Receiver</h4>
          <div className="mt-1 space-y-1">
            <p className="text-[10px] text-gray-900 font-black uppercase leading-tight">{booking.billingAddress}</p>
            {booking.gstNumber && <p className="text-[8px] font-bold text-gray-900 uppercase">GST: {booking.gstNumber}</p>}
            <div className="pt-0.5 border-t border-gray-100 space-y-0.5">
              <p className="text-[8px] text-gray-600 font-bold flex items-center gap-2">
                <i className="fa-solid fa-user-doctor text-[7px]" style={{ color: orange }}></i>
                {booking.contactPerson}
              </p>
              <p className="text-[8px] text-gray-600 font-bold flex items-center gap-2">
                <i className="fa-solid fa-phone text-[7px]" style={{ color: accent }}></i>
                {booking.contactPhone}
              </p>
            </div>
          </div>
        </div>
        <div className="text-right flex flex-col justify-between">
          <div>
            <h4 className="text-[7px] font-black text-gray-900 uppercase tracking-[0.3em] mb-0.5">Event Venue</h4>
            <p className="font-black text-gray-900 leading-tight text-[10px] tracking-tighter uppercase">{booking.conferenceName}</p>
            <div className="mt-1 p-1.5 rounded-lg text-right" style={{ backgroundColor: venueBg, border: `1px dashed ${venueBrd}` }}>
              <h5 className="text-[7px] font-black uppercase mb-0.5 tracking-[0.2em]" style={{ color: venueHd }}>Place of Supply</h5>
              <p className="text-[9px] font-black leading-tight uppercase tracking-tighter" style={{ color: venueTxt }}>
                {booking.transportAddress || booking.venue}
              </p>
            </div>
            <p className="text-[9px] font-black mt-1 italic uppercase tracking-widest" style={{ color: orange }}>
              {fmtDate(booking.startDate)} — {fmtDate(booking.endDate)}
            </p>
          </div>
        </div>
      </div>

      {/* Dynamic Asset Table */}
      <table className="w-full mb-2 border-collapse">
        <thead>
          <tr className="challan-header-target border-y border-gray-900" style={{ backgroundColor: hdrBg, WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>
            {visibleColumns.map(colKey => {
              const col = ALL_COLUMNS.find(c => c.key === colKey);
              if (!col) return null;
              return (
                <th
                  key={colKey}
                  className={`py-1 px-2 text-left text-[7px] font-black text-gray-900 uppercase tracking-[0.2em] ${col.className || ''} ${col.printHidden ? 'print:hidden' : ''}`}
                  style={{ color: '#111111', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}
                >
                  {col.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="text-[8px]">
          {assets.map((asset, index) => (
            <tr key={asset.id} className="border-b border-gray-300 page-break-inside-avoid">
              {visibleColumns.map(colKey => {
                const col = ALL_COLUMNS.find(c => c.key === colKey);
                if (!col) return null;
                return (
                  <td
                    key={`${asset.id}-${colKey}`}
                    className={`py-0.5 px-2 text-gray-900 font-bold ${col.className || ''} ${col.printHidden ? 'print:hidden' : ''}`}
                  >
                    {renderCell(asset, colKey, index)}
                  </td>
                );
              })}
            </tr>
          ))}

          {/* Subrental Sections */}
          {Array.isArray(subrentalTickets) && subrentalTickets.length > 0 && (
            <>
              <tr className="bg-gray-200">
                <td colSpan={visibleColumns.length} className="py-2 px-2 text-[9px] font-black text-sky-700 uppercase tracking-[0.2em] border-y border-gray-400">
                  <i className="fa-solid fa-truck-ramp-box mr-2"></i> Subrental Equipment
                </td>
              </tr>
              {subrentalTickets.map(ticket => (
                <React.Fragment key={ticket.id}>
                  <tr className="bg-gray-100/50">
                    <td colSpan={visibleColumns.length} className="py-1.5 px-3 text-[8px] font-black text-gray-700 uppercase tracking-widest border-b border-gray-300 italic">
                      {ticket.company_name}
                    </td>
                  </tr>
                  {ticket.items?.map((item: any, i: number) => (
                    <tr key={item.id} className="border-b border-gray-300">
                      {visibleColumns.map(colKey => {
                        const col = ALL_COLUMNS.find(c => c.key === colKey);
                        if (!col) return null;

                        let content: any = '';
                        if (colKey === 'Seq') content = `SR-${i + 1}`;
                        else if (colKey === 'Asset') {
                          const details = item.asset_details;
                          content = item.asset_name || details?.aliasName || details?.alias_name || details?.name || details?.sku || `Subrental Item ${item.id}`;
                        }
                        else if (colKey === 'SKU') content = item.asset_details?.sku || item.asset_name || `SR-${item.id}`;
                        else if (colKey === 'Type') content = item.asset_details?.type;
                        else if (colKey === 'Qty') content = item.quantity;
                        else if (colKey === 'Rate') content = `₹${Number(item.rental_price).toLocaleString()}`;
                        else if (colKey === 'Total') content = `₹${(Number(item.rental_price) * item.quantity).toLocaleString()}`;
                        else if (colKey === 'Identifiers') {
                          const details = item.asset_details;
                          content = details?.serialNumber || details?.serial_number || item.asset_name || '-';
                        }

                        return (
                          <td
                            key={`${item.id}-${colKey}`}
                            className={`py-0.5 px-2 text-gray-900 font-bold ${col.className || ''} ${col.printHidden ? 'print:hidden' : ''}`}
                          >
                            {content}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </>
          )}

          {assets.length === 0 && (!Array.isArray(subrentalTickets) || subrentalTickets.length === 0) && (
            <tr>
              <td colSpan={visibleColumns.length} className="py-8 text-center text-[10px] font-black text-gray-900 uppercase tracking-widest">No assets selected.</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={visibleColumns.length} className="pt-1 px-2 text-right text-[8px] font-black text-gray-900 uppercase tracking-widest" style={{ borderTop: '2px solid #999' }}>
              Total Quantity: <span style={{ color: accent }}>{assets.reduce((sum, a) => sum + (a.quantity || 1), 0)}</span>
            </td>
          </tr>
          <tr className="bg-gray-50">
            <td colSpan={visibleColumns.length} className="py-0.5 px-2 text-right text-[8px] font-black text-gray-900 uppercase tracking-widest">
              Approximate Value of Goods:
              {isEditMode ? (
                <input
                  type="number"
                  className="w-24 ml-2 bg-white border border-slate-200 rounded px-1 text-[10px] text-right text-orange-500 font-black focus:outline-none focus:border-orange-500"
                  value={totalValue}
                  onChange={e => setTotalOverride(parseFloat(e.target.value) || 0)}
                />
              ) : (
                <span className="text-[10px] ml-2" style={{ color: orange }}>₹{Math.round(totalValue).toLocaleString()}</span>
              )}
            </td>
          </tr>
          <tr>
            <td colSpan={visibleColumns.length} className="pb-1 px-2 text-right text-[7px] text-gray-900 italic font-medium">
              ({numberToWords(totalValue)})
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-2 page-break-inside-avoid">
        <div className="px-3 py-2 mb-3 rounded-md bg-gray-50" style={{ border: '1px dashed #999' }}>
          <p className="text-[8px] text-gray-900 font-medium leading-relaxed">
            The above items are used goods and are taken for supply of service and the same will be returned back on or by{' '}
            <span className="font-black uppercase tracking-wide">{fmtDate(booking.endDate)}</span>.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-12">
          <div className="text-center pt-2" style={{ borderTop: '2px double #555' }}>
            <p className="text-[8px] font-black text-gray-900 uppercase tracking-[0.4em]">Receiver Acknowledgement</p>
            <div className="mt-4 h-8 mx-auto w-36" style={{ borderBottom: '1px solid #555' }}></div>
            <p className="text-[7px] text-gray-900 mt-1 font-bold uppercase tracking-widest">Receiver's Name &amp; Signature</p>
            <p className="text-[7px] text-gray-700 mt-0.5 font-bold uppercase tracking-widest">Phone: _______________</p>
          </div>
          <div className="text-center pt-2" style={{ borderTop: '2px double #555' }}>
            <p className="text-[8px] font-black text-gray-900 uppercase tracking-[0.4em]">Authorized Dispatch</p>
            <div className="mt-4 h-8 mx-auto w-36" style={{ borderBottom: '1px solid #555' }}></div>
            <p className="text-[7px] text-gray-900 mt-1 font-bold uppercase tracking-widest italic">{companySettings?.name || 'TECH TROLLEY'}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-2 text-[6px] text-gray-900 text-center leading-relaxed font-black uppercase tracking-[0.3em]" style={{ borderTop: '1px solid #999' }}>
        Technical Desk: {companySettings?.phone || '+91 9999 888 777'} | {companySettings?.email || 'support@amaudiovisuals.in'}
        <br />
        <span className="text-[9px] font-black text-gray-900 uppercase tracking-widest mt-0.5 inline-block border border-gray-400 px-1 rounded-sm">{copyLabel}</span>
      </div>
    </div>
  );
};
