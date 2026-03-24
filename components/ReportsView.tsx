import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Asset, Booking, Employee, AssetCategory } from '../types';
import jsPDF from 'jspdf';

interface ReportsViewProps {
    apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

// Extracts the "product family" from a SKU by stripping the trailing unit number (-1, -12, etc.)
// e.g., "BOSE_S1_PRO_PLUS-4" -> "BOSE S1 PRO PLUS"
function getSkuFamily(sku: string): string {
    if (!sku) return 'Unknown';
    const stripped = sku.replace(/-\d+$/, '').replace(/_\d+$/, '');
    return stripped.replace(/_/g, ' ').trim();
}

export const ReportsView: React.FC<ReportsViewProps> = ({ apiFetch }) => {
    const [activeTab, setActiveTab] = useState<'Inventory' | 'Conferences'>('Inventory');

    const [assets, setAssets] = useState<Asset[]>([]);
    const [conferences, setConferences] = useState<Booking[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loading, setLoading] = useState(true);

    // Filters
    const [invCategory, setInvCategory] = useState<string>('All');
    const [invSubCategory, setInvSubCategory] = useState<string>('All');
    const [invSearch, setInvSearch] = useState('');
    const [confSearch, setConfSearch] = useState('');
    const [confStartDate, setConfStartDate] = useState('');
    const [confEndDate, setConfEndDate] = useState('');

    useEffect(() => {
        const loadReportData = async () => {
            setLoading(true);
            try {
                const [assetsRes, confRes, empRes] = await Promise.all([
                    apiFetch('/api/assets/'),
                    apiFetch('/api/conferences/'),
                    apiFetch('/api/employees/')
                ]);
                if (assetsRes.ok) setAssets(await assetsRes.json());
                if (confRes.ok) setConferences(await confRes.json());
                if (empRes.ok) setEmployees(await empRes.json());
            } catch (err) {
                console.error("Failed to load report data", err);
            }
            setLoading(false);
        };
        loadReportData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const employeeMap = useMemo(() => {
        const map: Record<string, string> = {};
        employees.forEach(emp => { map[String(emp.id)] = emp.name; });
        return map;
    }, [employees]);

    // ─── Derived per-category subcategory map (from actual DB SKUs) ────────────────────
    const dynamicSubcategoryMap = useMemo(() => {
        const map: Record<string, Set<string>> = {};
        for (const a of assets) {
            const cat = a.type;
            if (!cat || cat === 'Other') continue;
            const family = getSkuFamily(a.sku || a.name || '');
            if (!family || family.toUpperCase().startsWith('TEST') || family.toUpperCase() === 'NIHAL TEST') continue;
            if (!map[cat]) map[cat] = new Set();
            map[cat].add(family);
        }
        // Convert sets to sorted arrays
        const result: Record<string, string[]> = {};
        for (const cat of Object.keys(map)) {
            result[cat] = Array.from(map[cat]).sort();
        }
        return result;
    }, [assets]);

    // ─── Inventory table rows ──────────────────────────────────────────────────────────
    const formattedInventory = useMemo(() => {
        return assets.map(a => {
            let timesUsed = 0;
            conferences.forEach(c => {
                if (
                    (c.assets && c.assets.some(id => String(id) === String(a.id))) ||
                    (c.crosscheckAssets && c.crosscheckAssets.some(id => String(id) === String(a.id)))
                ) timesUsed++;
            });

            let ageYears = 0, expectedLifeYears = 0, lifeConsumedPercent = 0;
            if (a.purchasedDate) {
                const ageMs = new Date().getTime() - new Date(a.purchasedDate).getTime();
                ageYears = ageMs / (1000 * 60 * 60 * 24 * 365);
                if (a.depreciationPercentage && a.depreciationPercentage > 0) {
                    expectedLifeYears = 100 / a.depreciationPercentage;
                    lifeConsumedPercent = Math.min(100, Math.round((ageYears / expectedLifeYears) * 100));
                }
            }
            return { ...a, timesUsed, lifeConsumedPercent, expectedLifeYears };
        }).filter(a => {
            if (invCategory !== 'All' && a.type !== invCategory) return false;
            if (invSubCategory !== 'All') {
                const subStr = invSubCategory.toLowerCase();
                const matchSKU = (a.sku || '').replace(/_/g, ' ').toLowerCase().includes(subStr);
                const matchName = (a.aliasName || a.name || '').toLowerCase().includes(subStr);
                if (!matchSKU && !matchName) return false;
            }
            if (invSearch) {
                const q = invSearch.toLowerCase();
                return (a.aliasName || a.name || '').toLowerCase().includes(q)
                    || (a.description || '').toLowerCase().includes(q)
                    || (a.sku || '').toLowerCase().includes(q);
            }
            return true;
        });
    }, [assets, conferences, invCategory, invSubCategory, invSearch]);

    // ─── Grouped counts for PDF ────────────────────────────────────────────────────────
    const groupedPdfData = useMemo(() => {
        const groups: Record<string, Record<string, number>> = {};
        for (const a of assets) {
            const cat = a.type || 'Other';
            const family = getSkuFamily(a.sku || a.name || '');
            if (!groups[cat]) groups[cat] = {};
            groups[cat][family] = (groups[cat][family] || 0) + 1;
        }
        return groups;
    }, [assets]);

    // ─── PDF Export ────────────────────────────────────────────────────────────────────
    const downloadPDF = useCallback(() => {
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        const margin = 15;
        let y = margin;

        // Header
        doc.setFillColor(15, 23, 42);
        doc.rect(0, 0, pageWidth, 30, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(18);
        doc.text('Tech Trolley – Asset Inventory Report', margin, 12);
        doc.setFontSize(9);
        doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`, margin, 22);
        y = 38;

        const catOrder = Object.keys(groupedPdfData).sort();
        for (const cat of catOrder) {
            // Category header
            doc.setFillColor(30, 41, 59);
            doc.rect(margin - 2, y - 4, pageWidth - 2 * margin + 4, 9, 'F');
            doc.setTextColor(56, 189, 248);
            doc.setFontSize(11);
            doc.text(cat.toUpperCase(), margin, y + 1);
            y += 12;

            const items = Object.entries(groupedPdfData[cat]).sort((a, b) => b[1] - a[1]);
            for (const [name, count] of items) {
                if (y > 270) {
                    doc.addPage();
                    y = margin;
                }
                doc.setTextColor(30, 30, 30);
                doc.setFontSize(9);
                const displayName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
                doc.text(`${displayName}`, margin + 3, y);
                doc.setTextColor(100, 100, 100);
                doc.text(`${count} unit${count !== 1 ? 's' : ''}`, pageWidth - margin - 20, y, { align: 'right' });
                y += 6;
            }

            // Category total
            const totalUnits = items.reduce((s, [, c]) => s + c, 0);
            doc.setDrawColor(200, 200, 200);
            doc.line(margin, y, pageWidth - margin, y);
            doc.setTextColor(100, 116, 139);
            doc.setFontSize(8);
            doc.text(`Total: ${totalUnits} units across ${items.length} model${items.length !== 1 ? 's' : ''}`, margin + 3, y + 4);
            y += 12;
        }

        doc.save(`TechTrolley_Inventory_${new Date().toISOString().slice(0, 10)}.pdf`);
    }, [groupedPdfData]);

    // ─── Conference data ───────────────────────────────────────────────────────────────
    const formattedConferences = useMemo(() => {
        return conferences.filter(c => {
            if (confSearch) {
                const q = confSearch.toLowerCase();
                if (!(c.conferenceName || c.name || '').toLowerCase().includes(q) &&
                    !(c.associationName || '').toLowerCase().includes(q)) return false;
            }
            if (confStartDate && new Date(c.startDate) < new Date(confStartDate)) return false;
            if (confEndDate && new Date(c.endDate) > new Date(confEndDate)) return false;
            return true;
        });
    }, [conferences, confSearch, confStartDate, confEndDate]);

    const subCatsForCategory = invCategory !== 'All' ? (dynamicSubcategoryMap[invCategory] || []) : [];

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between flex-wrap gap-4">
                <h2 className="text-4xl md:text-5xl font-black text-orange-500 uppercase">System Reports</h2>

                {activeTab === 'Inventory' && (
                    <button
                        onClick={downloadPDF}
                        className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm px-5 py-3 rounded-2xl transition-all shadow-lg hover:shadow-emerald-500/30"
                    >
                        <i className="fa-solid fa-file-pdf text-white"></i>
                        Download Full Report PDF
                    </button>
                )}
            </div>

            <div className="flex border-b border-slate-800 gap-8">
                {(['Inventory', 'Conferences'] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`pb-4 text-sm font-bold uppercase tracking-widest transition-colors relative ${activeTab === tab ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        {tab === 'Inventory' ? 'Inventory Assets' : 'Conferences'}
                        {activeTab === tab && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-sky-400 rounded-t-full" />}
                    </button>
                ))}
            </div>

            {activeTab === 'Inventory' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
                        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
                            {/* Main Category */}
                            <select
                                value={invCategory}
                                onChange={e => { setInvCategory(e.target.value); setInvSubCategory('All'); }}
                                className="form-select-night py-3 text-sm min-w-[200px]"
                            >
                                <option value="All">All Categories</option>
                                {Object.values(AssetCategory).map(cat => (
                                    <option key={cat} value={cat}>{cat}</option>
                                ))}
                            </select>

                            {/* Dynamic Sub-Category from real SKU data */}
                            {invCategory !== 'All' && subCatsForCategory.length > 0 && (
                                <select
                                    value={invSubCategory}
                                    onChange={e => setInvSubCategory(e.target.value)}
                                    className="form-select-night py-3 text-sm min-w-[220px] border-sky-900/50 bg-sky-950/20 text-sky-400 focus:border-sky-500"
                                >
                                    <option value="All">All Models ({assets.filter(a => a.type === invCategory).length} items)</option>
                                    {subCatsForCategory.map(sub => {
                                        const count = assets.filter(a => a.type === invCategory && (
                                            (a.sku || '').replace(/_/g, ' ').toLowerCase().includes(sub.toLowerCase()) ||
                                            (a.aliasName || a.name || '').toLowerCase().includes(sub.toLowerCase())
                                        )).length;
                                        return (
                                            <option key={sub} value={sub}>{sub} ({count})</option>
                                        );
                                    })}
                                </select>
                            )}
                        </div>

                        {/* Search */}
                        <div className="relative w-full lg:w-80">
                            <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                            <input
                                type="text"
                                placeholder="Search by name, SKU..."
                                value={invSearch}
                                onChange={e => setInvSearch(e.target.value)}
                                className="form-input-night pl-11 py-3 text-sm w-full"
                            />
                        </div>
                    </div>

                    <p className="text-xs text-slate-500">
                        Showing <span className="text-sky-400 font-bold">{formattedInventory.length}</span> items
                    </p>

                    <div className="overflow-x-auto rounded-3xl border border-slate-800/50 bg-slate-950/50 shadow-xl backdrop-blur-xl">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-slate-800/50">
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Asset</th>
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Category</th>
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Lifecycle</th>
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Programs Used</th>
                                </tr>
                            </thead>
                            <tbody>
                                {formattedInventory.slice(0, 300).map(asset => (
                                    <tr key={asset.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors">
                                        <td className="p-4 md:p-6">
                                            <p className="font-bold text-white text-sm break-words">{asset.aliasName || asset.name}</p>
                                            <p className="text-[10px] text-slate-400 font-mono mt-1 break-all">{asset.sku}</p>
                                        </td>
                                        <td className="p-4 md:p-6 text-sm text-slate-300">{asset.type}</td>
                                        <td className="p-4 md:p-6">
                                            {asset.lifeConsumedPercent > 0 ? (
                                                <>
                                                    <div className="flex items-center gap-3">
                                                        <div className="flex-1 w-24 h-2 bg-slate-800 rounded-full overflow-hidden">
                                                            <div
                                                                className={`h-full rounded-full ${asset.lifeConsumedPercent > 80 ? 'bg-rose-500' : asset.lifeConsumedPercent > 50 ? 'bg-orange-500' : 'bg-emerald-500'}`}
                                                                style={{ width: `${asset.lifeConsumedPercent}%` }}
                                                            ></div>
                                                        </div>
                                                        <span className="text-xs font-bold text-slate-400">{asset.lifeConsumedPercent}%</span>
                                                    </div>
                                                    <p className="text-[10px] text-slate-500 mt-1">Since: {asset.purchasedDate}</p>
                                                </>
                                            ) : (
                                                <span className="text-xs text-slate-600 italic">No data</span>
                                            )}
                                        </td>
                                        <td className="p-4 md:p-6">
                                            <div className="inline-flex items-center justify-center bg-slate-900 border border-slate-700 rounded-full px-4 py-1.5 text-sm font-black text-sky-400">
                                                {asset.timesUsed}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                {formattedInventory.length === 0 && (
                                    <tr><td colSpan={4} className="p-8 text-center text-slate-500">No assets match your filters.</td></tr>
                                )}
                                {formattedInventory.length > 300 && (
                                    <tr><td colSpan={4} className="p-4 text-center text-slate-500 text-xs">Showing 300 of {formattedInventory.length} results. Use filters to narrow down.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {activeTab === 'Conferences' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col lg:flex-row gap-4 items-center justify-between">
                        <div className="flex items-center gap-4 w-full lg:w-auto">
                            <input type="date" value={confStartDate} onChange={e => setConfStartDate(e.target.value)} className="form-input-night py-3 text-sm" />
                            <span className="text-slate-500 font-bold uppercase text-xs">TO</span>
                            <input type="date" value={confEndDate} onChange={e => setConfEndDate(e.target.value)} className="form-input-night py-3 text-sm" />
                        </div>
                        <div className="relative w-full lg:w-80">
                            <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                            <input
                                type="text"
                                placeholder="Search client or event..."
                                value={confSearch}
                                onChange={e => setConfSearch(e.target.value)}
                                className="form-input-night pl-11 py-3 text-sm w-full"
                            />
                        </div>
                    </div>

                    <div className="overflow-x-auto rounded-3xl border border-slate-800/50 bg-slate-950/50 shadow-xl backdrop-blur-xl">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-slate-800/50">
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Event</th>
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Dates</th>
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Total Assets</th>
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Technicians</th>
                                </tr>
                            </thead>
                            <tbody>
                                {formattedConferences.map(c => (
                                    <tr key={c.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors">
                                        <td className="p-4 md:p-6">
                                            <p className="font-bold text-white text-sm break-words">{c.conferenceName || c.name}</p>
                                            <p className="text-[10px] text-slate-400 font-mono mt-1">{c.associationName}</p>
                                        </td>
                                        <td className="p-4 md:p-6 text-sm text-slate-300">{c.startDate} → {c.endDate}</td>
                                        <td className="p-4 md:p-6">
                                            <div className="inline-flex items-center justify-center bg-slate-900 border border-slate-700 rounded-full px-4 py-1.5 text-sm font-black text-orange-400">
                                                {(c.assets?.length || 0) + (c.crosscheckAssets?.length || 0)}
                                            </div>
                                        </td>
                                        <td className="p-4 md:p-6">
                                            <div className="flex flex-wrap gap-2">
                                                {(c.assigned_employees || []).map(empId => (
                                                    <span key={empId} className="bg-slate-800 text-sky-400 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md">
                                                        {employeeMap[String(empId)] || 'Technician'}
                                                    </span>
                                                ))}
                                                {!(c.assigned_employees || []).length && (
                                                    <span className="text-slate-500 text-xs italic">Unassigned</span>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                {formattedConferences.length === 0 && (
                                    <tr><td colSpan={4} className="p-8 text-center text-slate-500">No events found in this range.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
};
