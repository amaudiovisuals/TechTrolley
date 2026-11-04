import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Asset, Booking, Employee, AssetCategory, AssetFlag, AssetStatus } from '../types';
import * as XLSX from 'xlsx';
import InventoryOwnershipSummary from './InventoryOwnershipSummary';
import { challanExportRows, conferenceDocumentRows } from '../state/ownerSections';
import { documentSourceWarnings } from '../state/challanDocuments';
import EmployeeAssetsPanel from './EmployeeAssetsPanel';

interface ReportsViewProps {
    apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
    user?: any;
    onEditAsset?: (asset: Asset) => void;
    allocationRefreshKey?: number;
    onAllocationsChanged?: () => void;
}

const normalizeSearch = (s: string) => (s || '').replace(/[-_\s]/g, '').toLowerCase();

export const ReportsView: React.FC<ReportsViewProps> = ({ apiFetch, user, onEditAsset, allocationRefreshKey = 0, onAllocationsChanged = () => {} }) => {
    const [activeTab, setActiveTab] = useState<'Conferences' | 'Personal' | 'Flagged' | 'Transfers'>('Conferences');

    // Data State
    const [assets, setAssets] = useState<Asset[]>([]);
    const [conferences, setConferences] = useState<Booking[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loading, setLoading] = useState(true);

    // Filters & Pagination
    const [confSearch, setConfSearch] = useState('');
    const [confStartDate, setConfStartDate] = useState('');
    const [confEndDate, setConfEndDate] = useState('');
    
    const [transferSearch, setTransferSearch] = useState('');
    const [flagFilter, setFlagFilter] = useState<AssetFlag | 'All'>('All');
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 20;

    // Modals
    const [detailAsset, setDetailAsset] = useState<Asset | null>(null);
    const [selectedConference, setSelectedConference] = useState<Booking | null>(null);

    // ─── Data Loading ──────────────────────────────────────────
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [assetsRes, confRes, empRes] = await Promise.all([
                apiFetch('/api/assets/?all=true'),
                apiFetch('/api/conferences/'),
                apiFetch('/api/employees/')
            ]);
            
            let rawAssets: any[] = [];
            if (assetsRes.ok) {
                const assetsData = await assetsRes.json();
                // Handle both paginated { results: [] } and flat [] responses
                rawAssets = Array.isArray(assetsData) ? assetsData : (assetsData?.results ?? []);
            }

            let rawConferences: any[] = [];
            if (confRes.ok) {
                const confData = await confRes.json();
                rawConferences = Array.isArray(confData) ? confData : (confData?.results ?? []);
            }

            let loadedEmployees: Employee[] = [];
            if (empRes.ok) {
                const empData = await empRes.json();
                loadedEmployees = Array.isArray(empData) ? empData : (empData?.results ?? []);
            }
            
            const mapAsset = (a: any) => ({
                ...a,
                aliasName: a.alias_name || a.aliasName,
                serialNumber: a.serial_number || a.serialNumber,
                purchasedDate: a.purchased_date || a.purchasedDate,
                availableFrom: a.available_from || a.availableFrom,
                availableTill: a.available_till || a.availableTill,
                isBarcodeAdded: a.is_barcode_added || a.isBarcodeAdded,
                itemPrice: a.item_price || a.itemPrice,
                depreciationPercentage: a.depreciation_percentage || a.depreciationPercentage,
                currentVenue: a.current_venue || a.currentVenue,
                returnDate: a.return_date || a.returnDate
            });

            setAssets(rawAssets.map(mapAsset));
            setConferences(rawConferences);
            setEmployees(loadedEmployees);
            
        } catch (err) {
            console.error("Reports Load Error:", err);
        } finally {
            setLoading(false);
        }
    }, [apiFetch]);

    useEffect(() => { loadData(); }, [loadData]);

    // ─── Memoized Computations (Performance) ───────────────────
    
    const assetDetailData = useMemo(() => {
        if (!detailAsset) return null;
        const history: { name: string, date: string }[] = [];
        conferences.forEach(c => {
            const allAssigned = [...(c.assets || []), ...(c.crosscheckAssets || [])];
            if (allAssigned.some(id => String(id) === String(detailAsset.id))) {
                history.push({ name: c.conferenceName || (c as any).name, date: c.startDate });
            }
        });
        return { history, timesUsed: history.length };
    }, [detailAsset, conferences]);

    // ─── Filtering & Pagination ───────────────────────────────
    
    const filteredConferences = useMemo(() => {
        return conferences.filter(c => {
             if (confSearch) {
                 const q = confSearch.toLowerCase();
                 if (!(c.conferenceName || (c as any).name || '').toLowerCase().includes(q) && 
                     !(c.associationName || '').toLowerCase().includes(q)) return false;
             }
             if (confStartDate && new Date(c.startDate) < new Date(confStartDate)) return false;
             if (confEndDate && new Date(c.endDate) > new Date(confEndDate)) return false;
             return true;
        });
    }, [conferences, confSearch, confStartDate, confEndDate]);

    const filteredFlaggedAssets = useMemo(() => {
        return assets.filter(a => {
            // Include if explicitly flagged OR if status is Damaged
            const isFlagged = a.flag && a.flag !== AssetFlag.NONE;
            const isDamaged = a.status === AssetStatus.DAMAGED || a.status === 'Damaged';
            
            if (!isFlagged && !isDamaged) return false;
            
            if (flagFilter !== 'All') {
                if (flagFilter === AssetFlag.MISSING) return a.flag === AssetFlag.MISSING;
                if (flagFilter === AssetFlag.REQUIRED_SERVICE) return a.flag === AssetFlag.REQUIRED_SERVICE || isDamaged;
                return a.flag === flagFilter;
            }
            return true;
        });
    }, [assets, flagFilter]);

    // ─── Actions ─────────────────────────────────────────────
    
    const handleUpdateAsset = async (assetId: number, fieldName: 'status' | 'flag', newValue: string) => {
        try {
            const response = await apiFetch(`/api/assets/${assetId}/`, {
                method: 'PATCH',
                body: JSON.stringify({ [fieldName]: newValue })
            });
            if (response.ok) {
                loadData();
            }
        } catch (err) {
            console.error(`Asset Update Error (${fieldName}):`, err);
        }
    };

    const renderAssetModal = () => {
        if (!detailAsset || !assetDetailData) return null;
        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10 animate-in fade-in zoom-in-95 duration-200">
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md" onClick={() => setDetailAsset(null)}></div>
                <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-[2.5rem] shadow-2xl overflow-hidden pointer-events-auto">
                    <div className="p-8 border-b border-slate-800 flex justify-between items-start">
                        <div className="min-w-0 flex-1">
                            <h3 className="text-2xl font-black text-white uppercase truncate">{detailAsset.aliasName || (detailAsset as any).name}</h3>
                            <p className="text-sky-400 font-mono text-xs mt-1">{detailAsset.sku}</p>
                        </div>
                        <button onClick={() => setDetailAsset(null)} className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition">
                            <i aria-hidden="true" className="fa-solid fa-xmark text-lg"></i>
                        </button>
                    </div>
                    <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-slate-950/40 p-4 rounded-2xl border border-slate-800">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1">Purchased On</p>
                                <p className="text-sm font-bold text-white">{detailAsset.purchasedDate || 'N/A'}</p>
                            </div>
                            <div className="bg-slate-950/40 p-4 rounded-2xl border border-slate-800">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1">Total Implementations</p>
                                <p className="text-xl font-black text-orange-400">{assetDetailData.timesUsed}</p>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <h4 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Deployment History</h4>
                            {assetDetailData.history.length > 0 ? (
                                <div className="space-y-2">
                                    {assetDetailData.history.map((h, i) => (
                                        <div key={i} className="flex justify-between items-center bg-slate-950/20 p-4 rounded-xl border border-slate-800/50">
                                            <p className="text-sm font-bold text-slate-200 uppercase">{h.name}</p>
                                            <p className="text-xs font-mono text-slate-500">{h.date}</p>
                                        </div>
                                    ))}
                                </div>
                            ) : (<p className="text-xs text-slate-600 italic">No usage history found.</p>)}
                        </div>
                    </div>
                    {(user?.role === 'admin' || user?.is_staff) && onEditAsset && (
                        <div className="p-6 bg-slate-950/40 border-t border-slate-800">
                            <button onClick={() => { onEditAsset(detailAsset); setDetailAsset(null); }} className="w-full py-4 bg-sky-500 text-white rounded-xl font-black uppercase text-xs hover:bg-sky-400 transition">Edit Assignment</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderConferenceDetailModal = () => {
        if (!selectedConference) return null;
        
        // Use challan_assets if available, otherwise fallback to current assets
        const historicalAssetIds = (selectedConference as any).challan_assets && (selectedConference as any).challan_assets.length > 0 
            ? (selectedConference as any).challan_assets 
            : (selectedConference.assets || []);
        
        const conferenceAssets = assets.filter(a => historicalAssetIds.map(String).includes(String(a.id)));
        const flagLog = (selectedConference as any).flag_log || [];

        const exportConferenceToExcel = (mode: 'dispatch' | 'return' = 'dispatch') => {
            const normalized = { ...selectedConference, challanAssets: selectedConference.challanAssets || (selectedConference as any).challan_assets || [] };
            const master = selectedConference.challan_documents?.find(document => document.scope === 'master');
            if (mode === 'dispatch' && !master) { alert('Save the master challan before exporting dispatch paperwork so supplier and manual rows are included.'); return; }
            const returnIds = new Set((normalized.assets || []).map(String));
            const warningSources = mode === 'return' ? assets.filter(asset => returnIds.has(String(asset.id))) : assets;
            if ((mode === 'return' || !master) && documentSourceWarnings(warningSources, normalized, 'master', mode).length) { alert('Source quantities need review before this export. Saved papers were kept.'); return; }
            const rows = conferenceDocumentRows(normalized, assets, mode);
            if (!rows.length) { alert('No recorded document or current quantity rows for this export.'); return; }
            const issuer = master?.header.company?.name || 'Main company';
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(challanExportRows(rows, issuer)), mode === 'return' ? 'Current return preview' : master ? 'Saved challan lines' : 'Current dispatch preview');
            const references = conferenceAssets.map(a => ({ 'Source Asset ID': a.id, SKU: a.sku, 'Current inventory owner': a.subrental_company_name || 'Main company', 'Stock master quantity': a.quantity, 'Current stored status': a.status }));
            if (references.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(references), 'Inventory references');
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Note: mode === 'return' ? 'Current transport preview from recorded balances; not proof of return or original paperwork.' : master ? 'Saved document snapshots; warehouse quantities/current custody are separate inventory references.' : 'Current dispatch preview; unsupported legacy quantities require review.' }]), 'Notes');
            XLSX.writeFile(workbook, `Conference_${selectedConference.id}_${mode}.xlsx`);
        };

        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10 animate-in fade-in zoom-in-95 duration-300">
                <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl" onClick={() => setSelectedConference(null)}></div>
                <div className="relative w-full max-w-5xl bg-slate-900 border border-slate-800 rounded-[3rem] shadow-2xl overflow-hidden pointer-events-auto flex flex-col max-h-[90vh]">
                    <div className="p-10 border-b border-slate-800 flex justify-between items-center bg-slate-950/30">
                        <div>
                            <h3 className="text-3xl font-black text-white uppercase tracking-tight">{selectedConference.conferenceName || (selectedConference as any).name}</h3>
                            <p className="text-slate-500 font-bold uppercase text-xs mt-1 tracking-widest">{selectedConference.associationName} • {selectedConference.startDate} to {selectedConference.endDate}</p>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => exportConferenceToExcel('dispatch')}
                                title="Export saved master challan lines, including supplier and manual rows"
                                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-black text-[10px] uppercase tracking-widest px-5 py-3 rounded-2xl transition-all shadow-lg shadow-emerald-500/20"
                            >
                                <i aria-hidden="true" className="fa-solid fa-file-excel"></i>
                                Export saved challan
                            </button>
                            <button onClick={() => exportConferenceToExcel('return')} className="px-4 py-2 rounded bg-slate-800 text-white">Export current return preview</button>
                            <button onClick={() => setSelectedConference(null)} className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition shadow-xl">
                                <i aria-hidden="true" className="fa-solid fa-xmark text-xl"></i>
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-10 space-y-12 custom-scrollbar">
                        {/* Stats Row */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                            <div className="bg-slate-950/40 p-6 rounded-3xl border border-slate-800">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Total Assets Used</p>
                                <p className="text-3xl font-black text-sky-400">{historicalAssetIds.length}</p>
                            </div>
                            <div className="bg-slate-950/40 p-6 rounded-3xl border border-slate-800">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Flagged Events</p>
                                <p className="text-3xl font-black text-red-500">{flagLog.length}</p>
                            </div>
                            <div className="bg-slate-950/40 p-6 rounded-3xl border border-slate-800">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Conference Value</p>
                                <p className="text-xl font-black text-emerald-400">₹{Number(selectedConference.approximate_value || 0).toLocaleString()}</p>
                            </div>
                            <div className="bg-slate-950/40 p-6 rounded-3xl border border-slate-800">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Challan No</p>
                                <p className="text-xl font-black text-white">{selectedConference.challanNumber || 'N/A'}</p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                            {/* Asset List */}
                            <div className="space-y-6">
                                <div className="flex justify-between items-center">
                                    <h4 className="text-sm font-black text-white uppercase tracking-widest">Inventory Manifest</h4>
                                    <span className="px-3 py-1 bg-sky-500/10 text-sky-400 text-[10px] font-black uppercase rounded-lg">Historical View</span>
                                </div>
                                <div className="space-y-3">
                                    {conferenceAssets.length > 0 ? (() => {
                                        const groups = conferenceAssets.reduce((acc: Record<string, Asset[]>, a) => {
                                            const key = a.aliasName || a.sku || 'Unknown';
                                            if (!acc[key]) acc[key] = [];
                                            acc[key].push(a);
                                            return acc;
                                        }, {} as Record<string, Asset[]>);
                                        return Object.entries(groups).map(([name, items]: [string, Asset[]]) => {
                                            const gKey = `report-${name}`;
                                            const isOpen = !!((selectedConference as any)?._expandedGroups?.[gKey]);
                                            return (
                                                <div key={gKey} className="bg-slate-950/20 rounded-2xl border border-slate-800/50 overflow-hidden group hover:bg-slate-800/30 transition-all">
                                                    <button
                                                        onClick={() => setSelectedConference(prev => prev ? { ...prev, _expandedGroups: { ...((prev as any)._expandedGroups || {}), [gKey]: !(prev as any)._expandedGroups?.[gKey] } } as any : prev)}
                                                        className="w-full flex items-center gap-3 p-4 text-left"
                                                    >
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-sm font-bold text-slate-200 uppercase truncate">{name}</p>
                                                        </div>
                                                        <span className="shrink-0 px-2 py-0.5 bg-sky-500/20 text-sky-400 text-[9px] font-black rounded-full border border-sky-500/30">x {items.length}</span>
                                                        <i aria-hidden="true" className="fa-solid fa-chevron-down text-slate-600 text-[10px] shrink-0 group-hover:text-slate-400 transition-colors"></i>
                                                    </button>
                                                    <div className="border-t border-slate-800/50 divide-y divide-slate-800/30">
                                                        {items.map(asset => (
                                                            <div key={asset.id} className="flex items-center justify-between px-4 py-2.5">
                                                                <p className="text-[10px] font-mono text-slate-500 truncate">{asset.sku}</p>
                                                                <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase rounded-lg ${asset.status === 'Available' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-800 text-slate-500'}`}>{asset.status}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        });
                                    })() : (
                                        <p className="text-xs text-slate-600 italic">No asset data found for this conference.</p>
                                    )}

                                </div>
                            </div>

                            {/* Flag Log */}
                            <div className="space-y-6">
                                <div className="flex justify-between items-center">
                                    <h4 className="text-sm font-black text-red-500 uppercase tracking-widest">Incident Log</h4>
                                    <span className="px-3 py-1 bg-red-500/10 text-red-500 text-[10px] font-black uppercase rounded-lg">Workflow Issues</span>
                                </div>
                                <div className="space-y-4">
                                    {flagLog.length > 0 ? flagLog.map((log: any, i: number) => (
                                        <div key={i} className="bg-red-500/5 p-5 rounded-2xl border border-red-500/10 space-y-2">
                                            <div className="flex justify-between items-start">
                                                <div>
                                                    <p className="text-sm font-black text-white uppercase">{log.alias_name || log.sku}</p>
                                                    <p className="text-[9px] font-mono text-red-400/60 uppercase">{log.sku}</p>
                                                </div>
                                                <span className="px-2 py-1 bg-red-500 text-white text-[8px] font-black uppercase rounded-md">{log.flag}</span>
                                            </div>
                                            <div className="flex justify-between items-center pt-2 border-t border-red-500/10">
                                                <p className="text-[9px] font-black text-slate-500 uppercase">Stage: <span className="text-red-400">{log.stage}</span></p>
                                                <p className="text-[9px] font-mono text-slate-600">{new Date(log.timestamp).toLocaleString()}</p>
                                            </div>
                                        </div>
                                    )) : (
                                        <div className="bg-emerald-500/5 p-10 rounded-3xl border border-emerald-500/10 text-center space-y-3">
                                            <i aria-hidden="true" className="fa-solid fa-shield-check text-emerald-500/30 text-3xl"></i>
                                            <p className="text-xs font-black text-emerald-500/40 uppercase tracking-widest">No issues reported during workflow</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    if (loading && activeTab !== 'Personal') return <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div></div>;


    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <InventoryOwnershipSummary key={`report-owners:${user?.user_id || user?.email || ''}`} account={String(user?.user_id || user?.email || '')} apiFetch={apiFetch} />
            {renderAssetModal()}

            {renderConferenceDetailModal()}

            <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-4">
                    <h2 className="text-4xl md:text-5xl font-black text-orange-500 uppercase">System Reports</h2>
                    {activeTab !== 'Personal' && <button onClick={loadData} className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:text-sky-400 transition" title="Manual Refresh">
                        <i aria-hidden="true" className={`fa-solid fa-rotate ${loading ? 'animate-spin' : ''}`}></i>
                    </button>}
                </div>

            </div>

            <div className="flex border-b border-slate-800 gap-8 overflow-x-auto no-scrollbar">
                {(['Conferences', 'Personal', 'Flagged', 'Transfers'] as const).map(tab => (
                    <button key={tab} onClick={() => { setActiveTab(tab); setCurrentPage(1); }} className={`pb-4 text-xs font-black uppercase tracking-widest transition-colors relative whitespace-nowrap ${activeTab === tab ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}>
                        {tab === 'Conferences' ? 'Conferences' : tab === 'Personal' ? 'Employee Assets' : tab === 'Flagged' ? 'Flagged Items' : 'Transfers'}
                        {activeTab === tab && <div className="absolute bottom-0 left-0 w-full h-1 bg-sky-400 rounded-t-full" />}
                    </button>
                ))}
            </div>

            {activeTab === 'Personal' && <EmployeeAssetsPanel apiFetch={apiFetch} user={user} refreshKey={allocationRefreshKey} onChanged={onAllocationsChanged} />}

            {activeTab === 'Flagged' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                        <h3 className="text-xl font-black text-white uppercase tracking-tight">Flagged Items Report</h3>
                        <div className="flex gap-2 w-full md:w-auto">
                            {[AssetFlag.EXPIRED, AssetFlag.REQUIRED_SERVICE, AssetFlag.ON_SERVICE, AssetFlag.MISSING].map(f => (
                                <button
                                    key={f}
                                    onClick={() => setFlagFilter(flagFilter === f ? 'All' : f)}
                                    className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border ${
                                        flagFilter === f 
                                            ? 'bg-red-500 border-red-400 text-white shadow-lg shadow-red-500/20' 
                                            : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'
                                    }`}
                                >
                                    {f}
                                </button>
                            ))}
                            {flagFilter !== 'All' && (
                                <button onClick={() => setFlagFilter('All')} className="text-[10px] font-black text-sky-400 uppercase tracking-widest px-4">Clear</button>
                            )}
                        </div>
                    </div>
                    <div className="overflow-x-auto rounded-[1.5rem] border border-slate-800/50 bg-slate-950/40">
                        <table className="w-full text-left">
                            <thead className="bg-slate-900/50 border-b border-slate-800">
                                <tr className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                    <th className="p-6">Asset SKU / Name</th>
                                    <th className="p-6">Flag Type</th>
                                    <th className="p-6">Current Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/20">
                                {filteredFlaggedAssets.length > 0 ? filteredFlaggedAssets.map(asset => (
                                    <tr key={asset.id} className="hover:bg-red-500/5 transition-all text-sm font-bold">
                                        <td className="p-6">
                                            <p className="text-white uppercase font-black">{asset.aliasName || asset.sku}</p>
                                            <p className="text-[9px] text-slate-500 font-mono mt-1">{asset.sku}</p>
                                        </td>
                                        <td className="p-6">
                                            {(user?.role === 'admin' || user?.role === 'godown_incharge' || user?.is_staff) ? (
                                                <div className="flex flex-col gap-1">
                                                    <select
                                                        value={asset.flag || ''}
                                                        onChange={(e) => handleUpdateAsset(asset.id as any, 'flag', e.target.value)}
                                                        className="bg-slate-900 border border-slate-800 rounded-lg text-[10px] font-black p-2 uppercase outline-none focus:border-red-500 transition cursor-pointer text-red-500"
                                                    >
                                                        <option value="">Clear Flag</option>
                                                        {Object.values(AssetFlag).filter(f => f !== '').map(f => (
                                                            <option key={f} value={f}>{f}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            ) : (
                                                <span className="px-3 py-1 bg-red-500/10 text-[10px] font-black text-red-500 uppercase rounded-lg border border-red-500/20">
                                                    <i aria-hidden="true" className="fa-solid fa-flag mr-2" />
                                                    {asset.flag || 'None'}
                                                </span>
                                            )}
                                        </td>
                                        <td className="p-6">
                                            <span className={`px-3 py-1 text-[10px] font-black uppercase rounded-lg ${
                                                asset.status === 'Available' ? 'bg-emerald-500/10 text-emerald-500' :
                                                asset.status === 'In Use' ? 'bg-orange-500/10 text-orange-500' : 
                                                (asset.status === 'Damaged' || asset.status === 'Missing' || asset.status === 'Expired' || asset.status === 'On Service') ? 'bg-red-500/10 text-red-500' :
                                                'bg-slate-800 text-slate-400'
                                            }`}>
                                                {asset.status}
                                            </span>
                                        </td>
                                    </tr>
                                )) : (
                                    <tr>
                                        <td colSpan={4} className="p-20 text-center">
                                            <div className="flex flex-col items-center gap-4 opacity-20">
                                                <i aria-hidden="true" className="fa-solid fa-flag-checkered text-5xl text-slate-500" />
                                                <p className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">No flagged assets found</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {activeTab === 'Conferences' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col lg:flex-row gap-4 items-center justify-between">
                        <div className="flex items-center gap-3">
                            <input type="date" value={confStartDate} onChange={e => setConfStartDate(e.target.value)} className="form-input-night py-3 text-xs font-bold" />
                            <i aria-hidden="true" className="fa-solid fa-arrow-right text-slate-700 text-xs"></i>
                            <input type="date" value={confEndDate} onChange={e => setConfEndDate(e.target.value)} className="form-input-night py-3 text-xs font-bold" />
                        </div>
                        <input type="text" placeholder="SEARCH CLIENT OR EVENT..." value={confSearch} onChange={e => setConfSearch(e.target.value)} className="form-input-night px-6 py-4 text-[10px] font-black uppercase tracking-widest w-full lg:w-96" />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {filteredConferences.map(c => {
                            const historicalIds = (c as any).challan_assets && (c as any).challan_assets.length > 0 
                                ? (c as any).challan_assets 
                                : (c.assets || []);
                            
                            return (
                                <div 
                                    key={c.id} 
                                    onClick={() => setSelectedConference(c)}
                                    className="bg-slate-950/40 p-6 rounded-3xl border border-slate-800/50 space-y-4 hover:border-sky-500/50 hover:bg-slate-900/50 transition-all cursor-pointer group"
                                >
                                    <div>
                                        <h4 className="text-sm font-black text-white uppercase truncate group-hover:text-sky-400 transition-colors">{c.conferenceName || (c as any).name}</h4>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase mt-1 tracking-wider truncate">{c.associationName}</p>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <div className="text-[10px] font-mono text-sky-400/70">{c.startDate}</div>
                                        <div className="px-3 py-1 bg-sky-500/10 text-sky-400 rounded-lg text-[10px] font-black uppercase">{historicalIds.length} Assets</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ─── TRANSFERS TAB ─────────────────────────────────────── */}
            {activeTab === 'Transfers' && (() => {
                // Flatten all transfer_log entries from all conferences
                const allEntries: { conf: any; entry: any }[] = [];
                conferences.forEach(c => {
                    const log: any[] = (c as any).transfer_log || [];
                    log.forEach(entry => allEntries.push({ conf: c, entry }));
                });

                // Sort newest first
                allEntries.sort((a, b) => new Date(b.entry.timestamp).getTime() - new Date(a.entry.timestamp).getTime());

                const filtered = allEntries.filter(({ conf, entry }) => {
                    if (!transferSearch) return true;
                    const q = transferSearch.toLowerCase();
                    return (
                        (conf.conferenceName || conf.name || '').toLowerCase().includes(q) ||
                        (entry.to_conference_name || '').toLowerCase().includes(q) ||
                        (entry.from_conference_name || '').toLowerCase().includes(q) ||
                        (entry.from_address || '').toLowerCase().includes(q) ||
                        (entry.transferred_by || '').toLowerCase().includes(q) ||
                        (entry.asset_names || []).join(' ').toLowerCase().includes(q)
                    );
                });

                return (
                    <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                            <div>
                                <h3 className="text-xl font-black text-white uppercase tracking-tight">Transfer Log</h3>
                                <p className="text-[10px] text-slate-500 font-bold uppercase mt-1 tracking-wider">{allEntries.length} transfer event{allEntries.length !== 1 ? 's' : ''} across all conferences</p>
                            </div>
                            <input
                                type="text"
                                placeholder="SEARCH BY CONFERENCE, VENUE, PERSON..."
                                value={transferSearch}
                                onChange={e => setTransferSearch(e.target.value)}
                                className="form-input-night px-6 py-4 text-[10px] font-black uppercase tracking-widest w-full md:w-96"
                            />
                        </div>

                        {filtered.length === 0 ? (
                            <div className="py-20 text-center space-y-3">
                                <i aria-hidden="true" className="fa-solid fa-arrow-right-arrow-left text-5xl text-slate-700"></i>
                                <p className="text-slate-500 font-black uppercase text-xs tracking-widest">{allEntries.length === 0 ? 'No transfers have been made yet' : 'No results match your search'}</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {filtered.map(({ conf, entry }, idx) => (
                                    <div
                                        key={idx}
                                        className={`flex items-start gap-4 p-5 rounded-3xl border transition-all ${
                                            entry.direction === 'outgoing'
                                                ? 'bg-orange-950/30 border-orange-800/30 hover:border-orange-600/40'
                                                : 'bg-emerald-950/30 border-emerald-800/30 hover:border-emerald-600/40'
                                        }`}
                                    >
                                        {/* Direction icon */}
                                        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                                            entry.direction === 'outgoing' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'
                                        }`}>
                                            <i aria-hidden="true" className={`fa-solid ${
                                                entry.direction === 'outgoing' ? 'fa-arrow-up-right-from-square' : 'fa-arrow-down-to-line'
                                            }`}></i>
                                        </div>

                                        <div className="flex-1 min-w-0 space-y-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${
                                                    entry.direction === 'outgoing' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'
                                                }`}>
                                                    {entry.direction === 'outgoing' ? '↑ Outgoing' : '↓ Incoming'}
                                                </span>
                                                <span className="text-[10px] font-black text-white">
                                                    {conf.conferenceName || (conf as any).name}
                                                </span>
                                                <i aria-hidden="true" className="fa-solid fa-arrow-right text-slate-600 text-[9px]"></i>
                                                <span className="text-[10px] font-bold text-slate-300">
                                                    {entry.direction === 'outgoing' ? entry.to_conference_name : entry.from_conference_name}
                                                </span>
                                            </div>

                                            {/* Asset names */}
                                            {(entry.asset_names || []).length > 0 && (
                                                <div className="flex flex-wrap gap-1.5 mt-1">
                                                    {(entry.asset_names as string[]).map((name: string, i: number) => (
                                                        <span key={i} className="text-[9px] font-bold text-slate-400 bg-slate-800 px-2 py-0.5 rounded-lg">{name}</span>
                                                    ))}
                                                </div>
                                            )}

                                            <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-500 font-bold mt-1">
                                                {entry.from_address && (
                                                    <span><i aria-hidden="true" className="fa-solid fa-location-dot mr-1 text-slate-600"></i>{entry.from_address}</span>
                                                )}
                                                <span><i aria-hidden="true" className="fa-solid fa-user mr-1 text-slate-600"></i>{entry.transferred_by}</span>
                                                <span><i aria-hidden="true" className="fa-regular fa-clock mr-1 text-slate-600"></i>
                                                    {new Date(entry.timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Item count badge */}
                                        <div className="shrink-0 text-right">
                                            <span className={`text-lg font-black ${
                                                entry.direction === 'outgoing' ? 'text-orange-400' : 'text-emerald-400'
                                            }`}>{(entry.transferred_asset_ids || []).length}</span>
                                            <p className="text-[9px] text-slate-600 font-bold uppercase">items</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })()}

        </div>
    );
};
