import React from 'react';
import { Booking, Asset, Client, CompanySettings } from '../types';
import { Logo } from './Logo';

const EXCLUDED_LAPTOP_KEYWORDS = [
  'connector', 'modem', 'monitor', 'mouse', 'server', 'printer', 'ups', 
  'router', 'hub', 'cable', 'splitter', 'switcher', 'switch', 'adapter', 'talkback', 
  'handycam', 'projector', 'speaker', 'mixer', 'camera', 'scanner', 'screen',
  'tv', 'display', 'led wall', 'sound card', 'capture card', 'mic', 'microphone'
];

const WINDOWS_LAPTOP_BRANDS = [
  'hp', 'dell', 'asus', 'acer', 'lenovo', 'thinkpad', 'msi', 'samsung', 'intel', 'amd', 'ryzen', 'windows'
];

/**
 * Returns 'MacBook' or 'Windows Laptop' for Laptop-type assets.
 * Also optionally appends the original sub-identifier in parentheses e.g. 'MacBook (M-17)'.
 * Returns null for non-laptop assets so they are completely unaffected.
 */
function getLaptopSubGroup(
  arg1?: Asset | string | null,
  type?: string,
  sku?: string,
  description?: string,
  includeSubId: boolean = false
): string | null {
  let an = '';
  let t = '';
  let s = '';
  let d = '';

  if (typeof arg1 === 'string') {
    an = arg1.trim();
    t = (type || '').trim();
    s = (sku || '').trim();
    d = (description || '').trim();
  } else if (arg1 && typeof arg1 === 'object') {
    an = (arg1.aliasName || (arg1 as any).alias_name || '').trim();
    t = (arg1.type || '').trim();
    s = (arg1.sku || '').trim();
    d = (arg1.description || '').trim();
  }

  const combined = `${an} ${s} ${d}`.toLowerCase();

  // 1. Exclusion Check: if it contains any non-laptop keyword, it is NOT a laptop!
  if (EXCLUDED_LAPTOP_KEYWORDS.some(k => combined.includes(k))) {
    return null;
  }

  // 2. Inclusion Check: is it a laptop?
  const itTypes = ['laptops', 'it & networking', 'computers & servers'];
  const explicitAliases = ['apple macbook', 'windows laptop', 'macbook'];
  const laptopKeywords = ['laptop', 'macbook', 'vivobook', 'thinkpad', 'ideapad', 'pavilion', 'inspiron', 'latitude', 'precision', 'zenbook', 'tuf_fx', 'omen', 'helios', 'victus'];

  const isLaptopType = itTypes.includes(t.toLowerCase());
  const isExplicit = explicitAliases.includes(an.toLowerCase());
  const isLaptopName = laptopKeywords.some(k => combined.includes(k));

  let isLaptop = isExplicit || isLaptopName;
  if (!isLaptop && isLaptopType) {
    const anUpper = an.toUpperCase();
    if (anUpper.startsWith('M-') || anUpper.startsWith('AM-') || anUpper.startsWith('M') || anUpper.startsWith('AM') || /^\d+$/.test(an)) {
      isLaptop = true;
    }
  }

  if (!isLaptop) return null;

  // 3. Classify MacBook vs Windows Laptop
  let isMac = false;
  if (WINDOWS_LAPTOP_BRANDS.some(b => combined.includes(b))) {
    isMac = false;
  } else if (combined.includes('macbook') || combined.includes('apple') || combined.includes('imac')) {
    isMac = true;
  } else {
    const checkStr = (an || s).toUpperCase();
    if (checkStr.startsWith('M-') || checkStr.startsWith('M1') || checkStr.startsWith('M2') || checkStr.startsWith('M3') || checkStr.startsWith('M4')) {
      isMac = true;
    }
  }

  const group = isMac ? 'MacBook' : 'Windows Laptop';

  if (!includeSubId) return group;

  // Determine sub-identifier (the old alias name or SKU model like 105, M-17, etc.)
  let subId = '';
  if (an && !['Apple MacBook', 'Windows Laptop', 'MacBook'].includes(an)) {
    subId = an;
  } else if (s) {
    const lastDash = s.lastIndexOf('-');
    subId = (lastDash !== -1 ? s.slice(0, lastDash) : s).replace(/_/g, ' ');
  }

  const cleanSubId = subId.trim();
  return cleanSubId ? `${group} (${cleanSubId})` : group;
}

interface ChallanViewProps {
  booking: Booking;
  client: Client;
  assets: Asset[];
  companySettings?: CompanySettings;
  challanTitle?: string;
  onUpdateAsset?: (assetId: string, updates: Partial<Asset>, silent?: boolean) => Promise<void>;
  onAddAdhocItem?: (item: Partial<Asset>) => Promise<string | void>;
  onUpdateConferenceValue?: (conferenceId: string, value: number) => Promise<void>;
  onRemoveAssets?: (assetIds: string[]) => Promise<void>;
  showScanToast?: (msg: string, type: 'success' | 'warning' | 'error') => void;
  onUpdateChallanNumber?: (conferenceId: string, challanNumber: string) => Promise<void>;
  onSaveFullChallan?: (conferenceId: string, assetIds: string[]) => Promise<void>;
  subrentalTickets?: any[];
  readOnly?: boolean;
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
  { key: 'Seq', label: 'SEQ', width: 'w-6', className: 'w-6' },
  { key: 'SKU', label: 'SKU', width: 'w-24', className: 'w-24' },
  { key: 'Asset', label: 'ALIAS NAME' },
  { key: 'Type', label: 'Type' },
  { key: 'Identifiers', label: 'Identifiers' },
  { key: 'MAC', label: 'MAC Address' },
  { key: 'IMEI', label: 'IMEI (1/2)' },
  { key: 'Rate', label: 'Unit Rate', width: 'w-16', className: 'w-16', printHidden: true },
  { key: 'Qty', label: 'QUANTITY', width: 'w-10', className: 'w-10 text-right' },
  { key: 'Total', label: 'TOTAL', width: 'w-20', className: 'w-20 text-right' },
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
  booking, client, assets, companySettings, challanTitle, onUpdateAsset, onAddAdhocItem, showScanToast, onUpdateConferenceValue, onRemoveAssets, onUpdateChallanNumber, onSaveFullChallan, subrentalTickets, readOnly
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
    return ['Seq', 'Asset', 'Type', 'Identifiers', 'Rate', 'Qty', 'Total'];
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
  const [isGrouped, setIsGrouped] = React.useState(true);
  const [showEventContent, setShowEventContent] = React.useState(true);
  const [showEventDate, setShowEventDate] = React.useState(true);
  // J-111: Print-only alias overrides — keyed by asset ID (or group key).
  // These are NEVER persisted to the DB. They only affect what prints on the challan.
  const [printAliasOverrides, setPrintAliasOverrides] = React.useState<Record<string, string>>({});
  const [showPrintAliasEditor, setShowPrintAliasEditor] = React.useState(false);

  const setPrintAlias = (assetId: string, value: string) => {
    setPrintAliasOverrides(prev => ({ ...prev, [assetId]: value }));
  };

  const resetPrintAliases = () => setPrintAliasOverrides({});

  React.useEffect(() => {
    localStorage.setItem('challan_visible_columns', JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  const lastBookingIdRef = React.useRef<string>(booking.id);
  const isSavingRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    // Only reset localAssets if switching to a different booking,
    // or if external assets changed and we are NOT currently in edit mode or saving
    const bookingChanged = lastBookingIdRef.current !== booking.id;
    if (bookingChanged) {
      lastBookingIdRef.current = booking.id;
      setLocalAssets(assets.map(a => ({
        ...a,
        aliasName: (a.aliasName !== null && a.aliasName !== undefined) ? a.aliasName : a.sku
      })));
      return;
    }

    if (!isEditMode && !isSavingRef.current) {
      setLocalAssets(assets.map(a => ({
        ...a,
        aliasName: (a.aliasName !== null && a.aliasName !== undefined) ? a.aliasName : a.sku
      })));
    }
  }, [assets, booking.id]);

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
    isSavingRef.current = true;
    const errors: string[] = [];
    try {
      // 1. Process removals in batch
      const originalIds = assets.map(a => String(a.id));
      const currentIds = localAssets.map(a => String(a.id));
      const removedIds = originalIds.filter(id => !currentIds.includes(id));

      if (removedIds.length > 0 && onRemoveAssets) {
        console.log("Removing assets from conference:", removedIds);
        try {
          await onRemoveAssets(removedIds);
        } catch (err) {
          console.error("Failed to remove assets:", err);
          errors.push("Failed to remove deleted assets from server");
        }
      }

      const newAdhocIds: string[] = [];

      for (const asset of localAssets) {
        const isNew = String(asset.id).startsWith('new-');

        if (isNew) {
          if (onAddAdhocItem) {
            console.log("Saving new ad-hoc item:", asset.sku);
            try {
              // Must map camelCase to snake_case for API
              const returnedId = await onAddAdhocItem({
                sku: asset.sku,
                alias_name: asset.aliasName,
                quantity: asset.quantity,
                item_price: asset.itemPrice,
                depreciation_percentage: asset.depreciationPercentage || 0,
                serial_number: asset.serialNumber,
                type: asset.type,
              } as any);
              if (returnedId) {
                newAdhocIds.push(returnedId as string);
                // Update local asset id from temp to real id
                asset.id = returnedId as string;
              }
            } catch (err) {
              console.error(`Failed to add ad-hoc item ${asset.sku}:`, err);
              errors.push(`Failed to add item: ${asset.aliasName || asset.sku}`);
            }
          }
        } else {
          if (onUpdateAsset) {
            const original = assets.find(a => String(a.id) === String(asset.id));
            if (original && (
              original.aliasName !== asset.aliasName ||
              original.sku !== asset.sku ||
              original.quantity !== asset.quantity ||
              original.itemPrice !== asset.itemPrice ||
              original.serialNumber !== asset.serialNumber ||
              original.depreciationPercentage !== asset.depreciationPercentage
            )) {
              console.log("Updating existing asset (silent):", asset.id);
              // Backend expects snake_case
              const updates: any = {};
              if (original.aliasName !== asset.aliasName) updates.alias_name = asset.aliasName;
              if (original.sku !== asset.sku) updates.sku = asset.sku;
              if (original.quantity !== asset.quantity) updates.quantity = asset.quantity;
              if (original.itemPrice !== asset.itemPrice) {
                updates.item_price = asset.itemPrice;
                updates.depreciation_percentage = 0; // Clear depreciation so custom challan rate is preserved
              }
              if (original.serialNumber !== asset.serialNumber) updates.serial_number = asset.serialNumber;
              try {
                await onUpdateAsset(String(asset.id), updates, true); // silent = true
              } catch (err) {
                console.error(`Failed to update asset ${asset.id}:`, err);
                errors.push(`Failed to update item: ${asset.aliasName || asset.sku}`);
              }
            }
          }
        }
      }

      // 2. Save approximate goods value override if changed
      if (totalValueOverride !== null && totalValueOverride !== booking.approximate_value) {
        localStorage.setItem(`cache_total_val_${booking.id}`, totalValueOverride.toString());
        if (onUpdateConferenceValue) {
          console.log("Saving conference value override:", totalValueOverride);
          try {
            await onUpdateConferenceValue(booking.id, totalValueOverride);
          } catch (err) {
            console.error("Failed to update goods value:", err);
            errors.push("Failed to update goods value");
          }
        }
      }

      // 3. Save challan number if changed
      if (challanNoOverride !== null && challanNoOverride !== booking.challanNumber) {
        localStorage.setItem(`cache_challan_no_${booking.id}`, challanNoOverride);
        if (onUpdateChallanNumber) {
          console.log("Saving challan number override:", challanNoOverride);
          try {
            await onUpdateChallanNumber(booking.id, challanNoOverride);
          } catch (err) {
            console.error("Failed to update challan number:", err);
            errors.push("Failed to update challan number");
          }
        }
      }

      // 4. Save the full list of assets to "freeze" the challan state
      if (onSaveFullChallan) {
        console.log("Saving full challan asset list...");
        const finalAssetIds = localAssets
          .filter(a => !String(a.id).startsWith('new-'))
          .map(a => String(a.id));
        try {
          await onSaveFullChallan(booking.id, [...finalAssetIds, ...newAdhocIds]);
        } catch (err) {
          console.error("Failed to freeze/save full challan list:", err);
          errors.push("Failed to freeze/save full challan assets list");
        }
      }

      if (showScanToast) {
        if (errors.length > 0) {
          showScanToast(`⚠️ Saved with ${errors.length} error(s). Check console.`, 'warning');
        } else {
          showScanToast("✅ All changes saved successfully", "success");
        }
      }
    } catch (err) {
      console.error("Critical error during saveAllChanges:", err);
      alert("Failed to save some changes. Check console for details.");
    } finally {
      setIsEditMode(false);
      setTimeout(() => {
        isSavingRef.current = false;
      }, 1000);
    }
  };

  const addRow = () => {
    // Generate globally unique SKU so it never clashes with historical ad-hoc items
    const uniqueSuffix = `${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 90 + 10)}`;
    const defaultSku = `ADHOC-${uniqueSuffix}`;
    const defaultName = `ADHOC-${localAssets.length + 1}`;
    const newItem: Asset = {
      id: `new-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sku: defaultSku,
      aliasName: defaultName,
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

  const processedAssets = React.useMemo(() => {
    const consumableAssets: Asset[] = [];
    const cData = (booking as any).consumable_data || {};
    Object.entries(cData).forEach(([assetId, data]: [string, any]) => {
      const requestedQty = Number(data?.requested || data?.quantity || 0);
      if (requestedQty > 0) {
        const found = assets.find(a => String(a.id) === String(assetId));
        consumableAssets.push({
          id: `consumable-${assetId}`,
          sku: found?.sku || `CONSUMABLE-${assetId}`,
          aliasName: found?.aliasName || found?.sku || 'Consumable Item',
          serialNumber: 'Consumable',
          type: 'Consumables',
          quantity: requestedQty,
          itemPrice: found?.itemPrice || 0,
          status: 'In Use' as any,
          barcode: '',
          condition: 'Good',
          description: 'Assigned Consumable Item',
          isBarcodeAdded: false,
          macAddress: '',
          imeiNumber1: '',
          imeiNumber2: '',
          purchasedDate: '',
          depreciationPercentage: 0,
          availableFrom: '',
          availableTill: '',
          createdAt: '',
          lastMaintained: ''
        });
      }
    });

    const combinedLocal = [...localAssets, ...consumableAssets];
    let list: Asset[] = [];
    if (!isGrouped || isEditMode) {
      list = [...combinedLocal];
    } else {
      const groups: Record<string, Asset & { serials: string[], ids: (string | number)[] }> = {};

      combinedLocal.forEach(asset => {
        // For laptops, merge into MacBook / Windows Laptop sub-groups.
        // For all other assets, group by their exact alias name as before.
        const subGroup = getLaptopSubGroup(asset);
        const key = subGroup ?? asset.aliasName ?? asset.sku ?? 'Unknown';
        if (!groups[key]) {
          groups[key] = {
            ...asset,
            quantity: 0,
            serials: [],
            ids: []
          };
          // Override aliasName on the group header so the display name is correct
          if (subGroup) (groups[key] as any).aliasName = subGroup;
        }
        groups[key].quantity += (Number(asset.quantity) || 1);
        if (asset.serialNumber && asset.serialNumber.trim()) {
          groups[key].serials.push(asset.serialNumber.trim());
        }
        groups[key].ids.push(asset.id);
      });

      list = Object.values(groups).map(g => ({
        ...g,
        serialNumber: g.serials.length > 0 ? g.serials.join(', ') : '',
        // We keep the first ID for the row key, but note it's a group
        id: `group-${g.sku}-${g.aliasName}`
      }));
    }

    // Alphabetical sort by name (aliasName or sku)
    const sorted = list.sort((a, b) => {
      const nameA = (a.aliasName || a.sku || '').toLowerCase();
      const nameB = (b.aliasName || b.sku || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return sorted.map(a => ({
      ...a,
      // J-111: Inject the print-only alias override as a non-persisted field `printName`.
      // For laptops, default to the OS sub-group label (MacBook / Windows Laptop).
      // This is read by renderCell and never flows into onLocalUpdate or saveAllChanges.
      printName: printAliasOverrides[String(a.id)]
        ?? (isGrouped ? (getLaptopSubGroup(a) ?? a.aliasName ?? a.sku ?? '') : (a.aliasName || a.sku || ''))
    }));
  }, [localAssets, isGrouped, isEditMode, printAliasOverrides]);

  return (
    <div className="flex flex-col gap-4">
      {/* ── Customization Toolbar (Hidden in Print) ── */}
      <div className="print:hidden bg-white p-4 rounded-xl shadow-sm border border-slate-200 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-sky-50 rounded-lg flex items-center justify-center text-sky-600 shrink-0">
              <i className="fa-solid fa-sliders"></i>
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-tighter">Challan Customization</h3>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Toggle columns & edit details</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!readOnly && (
              <button
                onClick={() => setIsEditMode(!isEditMode)}
                className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isEditMode ? 'bg-orange-500 text-white shadow-lg shadow-orange-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
              >
                <i className={`fa-solid ${isEditMode ? 'fa-check' : 'fa-pen-to-square'} mr-2`}></i>
                {isEditMode ? 'Close Edit Mode' : 'Edit Mode'}
              </button>
            )}
            <button
              onClick={() => setIsGrouped(!isGrouped)}
              className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isGrouped ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              title="Aggregate similar items by name"
            >
              <i className={`fa-solid ${isGrouped ? 'fa-layer-group' : 'fa-list'} mr-2`}></i>
              {isGrouped ? 'Ungroup Items' : 'Group by Model'}
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
            {/* J-111: Print Alias Override toggle — always available, never saves to DB */}
            <button
              onClick={() => {
                setShowPrintAliasEditor(prev => !prev);
                if (showPrintAliasEditor) resetPrintAliases();
              }}
              className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                showPrintAliasEditor
                  ? 'bg-violet-500 text-white shadow-lg shadow-violet-200'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              title={showPrintAliasEditor ? 'Click to clear all print overrides and hide editor' : 'Override item names for this print only — does NOT save to database'}
            >
              <i className={`fa-solid fa-print mr-2`}></i>
              {showPrintAliasEditor ? 'Clear Print Names' : 'Print Name Override'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
          {ALL_COLUMNS.map(col => (
            <button
              key={col.key}
              onClick={() => toggleColumn(col.key)}
              className={`px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest border transition-all ${
                visibleColumns.includes(col.key)
                  ? 'bg-sky-50 border-sky-200 text-sky-600'
                  : 'bg-white border-slate-200 text-slate-400 opacity-60'
              }`}
            >
              {col.label}
            </button>
          ))}

          {/* Section Visibility Toggles */}
          <div className="h-5 w-[1px] bg-slate-200 mx-1 self-center" />
          <button
            onClick={() => setShowEventContent(prev => !prev)}
            className={`px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest border transition-all ${
              showEventContent
                ? 'bg-purple-50 border-purple-200 text-purple-600'
                : 'bg-white border-slate-200 text-slate-400 opacity-60'
            }`}
            title="Show or hide Event Context & Place of Supply on Challan"
          >
            <i className={`fa-solid ${showEventContent ? 'fa-eye' : 'fa-eye-slash'} mr-1.5`} />
            Event Content
          </button>
          <button
            onClick={() => setShowEventDate(prev => !prev)}
            className={`px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest border transition-all ${
              showEventDate
                ? 'bg-purple-50 border-purple-200 text-purple-600'
                : 'bg-white border-slate-200 text-slate-400 opacity-60'
            }`}
            title="Show or hide Event Date Range on Challan"
          >
            <i className={`fa-solid ${showEventDate ? 'fa-eye' : 'fa-eye-slash'} mr-1.5`} />
            Event Date
          </button>
        </div>
      </div>

      {/* J-111: Print Name Override panel — shown only when showPrintAliasEditor is true */}
      {showPrintAliasEditor && (
        <div className="print:hidden bg-violet-50 border border-violet-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 bg-violet-100 rounded-lg flex items-center justify-center text-violet-600">
              <i className="fa-solid fa-print text-sm"></i>
            </div>
            <div>
              <h3 className="text-sm font-black text-violet-800 uppercase tracking-tighter">Print Name Override</h3>
              <p className="text-[10px] text-violet-500 font-bold uppercase tracking-widest">
                Changes below affect the printed challan ONLY — the database is never updated.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {processedAssets.map(asset => (
              <div key={asset.id} className="flex items-center gap-2 bg-white border border-violet-100 rounded-lg px-3 py-2">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest truncate max-w-[120px]" title={asset.aliasName || asset.sku}>
                  {asset.aliasName || asset.sku}
                </span>
                <i className="fa-solid fa-arrow-right text-violet-300 text-[9px] shrink-0"></i>
                <input
                  type="text"
                  className="flex-1 bg-violet-50 border border-violet-200 rounded-md px-2 py-1 text-[10px] font-black text-violet-900 uppercase focus:outline-none focus:ring-2 focus:ring-violet-400 min-w-0"
                  value={(printAliasOverrides[String(asset.id)] !== undefined)
                    ? printAliasOverrides[String(asset.id)]
                    : (asset.aliasName || asset.sku || '')}
                  onChange={e => setPrintAlias(String(asset.id), e.target.value)}
                  placeholder={asset.aliasName || asset.sku || 'Print name...'}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {copies.map((copy, index) => (
        <div
          key={copy.key}
          className="print:w-full print:flex print:flex-col"
          style={{ pageBreakAfter: index < copies.length - 1 ? 'always' : 'auto' }}
        >
          <ChallanTemplate
            booking={booking}
            client={client}
            assets={processedAssets}
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
            challanTitle={challanTitle}
            showEventContent={showEventContent}
            showEventDate={showEventDate}
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
  challanTitle?: string;
  showEventContent?: boolean;
  showEventDate?: boolean;
}

const ChallanTemplate: React.FC<ChallanTemplateProps> = ({
  booking, client, assets, companySettings, copyLabel, bw,
  visibleColumns, isEditMode, onLocalUpdate, onRemoveRow,
  totalOverride, setTotalOverride, challanNoOverride, setChallanNoOverride,
  subrentalTickets, challanTitle, showEventContent = true, showEventDate = true
}) => {
  const accent = bw ? '#111111' : '#00AEEF';
  const orange = bw ? '#111111' : '#F15A24';
  const venueBg = bw ? '#f5f5f5' : '#f0f9ff';
  const venueBrd = bw ? '#999999' : '#bae6fd';
  const venueHd = bw ? '#111111' : '#0369a1';
  const venueTxt = bw ? '#111111' : '#0c4a6e';
  const hdrBg = '#ffffff'; // explicitly white for headings

  const getDepreciatedPrice = (a: Asset) => {
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
              <span className="hidden print:block font-black uppercase text-[8px] tracking-tighter">{asset.aliasName || asset.sku}</span>

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
      case 'Asset': {
        // J-111: Use printName (which carries the print-only override) for all on-screen and print rendering.
        // printName is injected by processedAssets and defaults to aliasName || sku when no override is set.
        const displayName = (asset as any).printName || asset.aliasName || asset.sku;
        const isOverridden = (asset as any).printName && (asset as any).printName !== (asset.aliasName || asset.sku);
        return (
          <>
            <span className="font-black text-gray-900 uppercase tracking-tighter mr-2">{displayName}</span>
            {isOverridden && (
              <span className="text-[7px] font-black text-violet-500 uppercase tracking-widest print:hidden" title={`Print override active. Original: ${asset.aliasName || asset.sku}`}>
                ✎ override
              </span>
            )}
            {!visibleColumns.includes('Type') && (
              <span className="text-[7px] font-bold uppercase tracking-widest print:hidden" style={{ color: accent }}>{asset.type}</span>
            )}
          </>
        );
      }
      case 'Type': return asset.type;
      case 'Identifiers': return (
        <div className="flex flex-col gap-0.5 max-w-[120px]">
          <span className="leading-tight break-words">{asset.serialNumber || '—'}</span>
          <span className="text-[6px] text-gray-400 font-mono uppercase tracking-tighter">{asset.sku}</span>
        </div>
      );
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
            <h2 className="text-lg font-black text-gray-900 tracking-tighter uppercase leading-none">{challanTitle || 'Delivery Challan'}</h2>
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
                {booking.challanDate
                  ? fmtDate(booking.challanDate)
                  : new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
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
            {showEventContent && (
              <>
                <h4 className="text-[7px] font-black text-gray-900 uppercase tracking-[0.3em] mb-0.5">Event Context</h4>
                <p className="font-black text-gray-900 leading-tight text-[10px] tracking-tighter uppercase">{booking.conferenceName}</p>
                <div className="mt-1 p-1.5 rounded-lg text-right" style={{ backgroundColor: venueBg, border: `1px dashed ${venueBrd}` }}>
                  <h5 className="text-[7px] font-black uppercase mb-0.5 tracking-[0.2em]" style={{ color: venueHd }}>Place of Supply</h5>
                  <p className="text-[9px] font-black leading-tight uppercase tracking-tighter" style={{ color: venueTxt }}>
                    {booking.transportAddress || booking.venue}
                  </p>
                </div>
              </>
            )}
            {showEventDate && (
              <p className="text-[9px] font-black mt-1 italic uppercase tracking-widest" style={{ color: orange }}>
                {fmtDate(booking.startDate)} — {fmtDate(booking.endDate)}
              </p>
            )}
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
                  {ticket.items?.sort((a: any, b: any) => {
                    const nameA = (a.asset_name || a.asset_details?.aliasName || a.asset_details?.alias_name || a.asset_details?.name || a.asset_details?.sku || '').toLowerCase();
                    const nameB = (b.asset_name || b.asset_details?.aliasName || b.asset_details?.alias_name || b.asset_details?.name || b.asset_details?.sku || '').toLowerCase();
                    return nameA.localeCompare(nameB);
                  }).map((item: any, i: number) => (
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
            <td colSpan={visibleColumns.length} className="py-1 px-2 text-right text-[10px] font-black text-gray-900 uppercase tracking-widest">
              GRAND TOTAL:
              {isEditMode ? (
                <input
                  type="number"
                  className="w-24 ml-2 bg-white border border-slate-200 rounded px-1 text-[12px] text-right text-orange-500 font-black focus:outline-none focus:border-orange-500"
                  value={totalValue}
                  onChange={e => setTotalOverride(parseFloat(e.target.value) || 0)}
                />
              ) : (
                <span className="text-[12px] ml-2" style={{ color: orange }}>₹{Math.round(totalValue).toLocaleString()}</span>
              )}
            </td>
          </tr>
          <tr>
            <td colSpan={visibleColumns.length} className="pb-1 px-2 text-right text-[8px] text-gray-900 italic font-bold">
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
