import React, { useState, useEffect, useMemo } from 'react';
import { Asset, Booking, Employee, AssetCategory } from '../types';

interface ReportsViewProps {
    apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export const ReportsView: React.FC<ReportsViewProps> = ({ apiFetch }) => {
    const [activeTab, setActiveTab] = useState<'Inventory' | 'Conferences'>('Inventory');
    
    const [assets, setAssets] = useState<Asset[]>([]);
    const [conferences, setConferences] = useState<Booking[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loading, setLoading] = useState(true);

    // Filters for Inventory
    const [invCategory, setInvCategory] = useState<string>('All');
    const [invSubCategory, setInvSubCategory] = useState<string>('All');
    const [invSearch, setInvSearch] = useState('');

    const SUBCATEGORY_MAP: Record<string, string[]> = {
        'Sound System': ['Bose', 'JBL', 'Yamaha', 'Speaker', 'Mixer', 'Mic', 'Amp', 'Shure'],
        'IT & Networking': ['Laptop', 'i3', 'i5', 'i7', 'MacBook', 'Monitor', 'Switch', 'Router', 'Dell', 'HP', 'Lenovo'],
        'AV Equipment': ['LED', 'Projector', 'Switcher', 'Screen', 'TV', 'Novastar', 'Matrix'],
        'Lighting': ['Par Light', 'Moving Head', 'Controller', 'Laser', 'Smoke'],
        'Consumables': ['Cable', 'Tape', 'Battery', 'Connector'],
    };

    // Filters for Conferences
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
        employees.forEach(emp => {
            map[String(emp.id)] = emp.name;
        });
        return map;
    }, [employees]);

    // Derived Inventory Data
    const formattedInventory = useMemo(() => {
        return assets.map(a => {
            let timesUsed = 0;
            conferences.forEach(c => {
                if ((c.assets && c.assets.some(id => String(id) === String(a.id))) || (c.crosscheckAssets && c.crosscheckAssets.some(id => String(id) === String(a.id)))) {
                    timesUsed++;
                }
            });

            // Lifecycle Math
            let ageYears = 0;
            let expectedLifeYears = 0;
            let lifeConsumedPercent = 0;
            
            if (a.purchasedDate) {
                const purchasedDate = new Date(a.purchasedDate);
                const now = new Date();
                ageYears = (now.getTime() - purchasedDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
                
                if (a.depreciationPercentage && a.depreciationPercentage > 0) {
                    expectedLifeYears = 100 / a.depreciationPercentage;
                    lifeConsumedPercent = Math.min(100, Math.round((ageYears / expectedLifeYears) * 100));
                }
            }

            return {
                ...a,
                timesUsed,
                lifeConsumedPercent,
                expectedLifeYears
            };
        }).filter(a => {
            if (invCategory !== 'All' && a.type !== invCategory) return false;
            
            // Sub-category matching logic
            if (invSubCategory !== 'All') {
                const subStr = invSubCategory.toLowerCase();
                const matchName = (a.aliasName || a.name || '').toLowerCase().includes(subStr);
                const matchDesc = (a.description || '').toLowerCase().includes(subStr);
                const matchSKU = (a.sku || '').toLowerCase().includes(subStr);
                if (!matchName && !matchDesc && !matchSKU) return false;
            }

            if (invSearch) {
                const query = invSearch.toLowerCase();
                const matchName = (a.aliasName || a.name || '').toLowerCase().includes(query);
                const matchDesc = (a.description || '').toLowerCase().includes(query);
                const matchSKU = (a.sku || '').toLowerCase().includes(query);
                return matchName || matchDesc || matchSKU;
            }
            return true;
        });
    }, [assets, conferences, invCategory, invSubCategory, invSearch]);

    // Derived Conference Data
    const formattedConferences = useMemo(() => {
        return conferences.filter(c => {
            if (confSearch) {
                const query = confSearch.toLowerCase();
                const matchName = (c.conferenceName || c.name || '').toLowerCase().includes(query);
                const matchClient = (c.associationName || '').toLowerCase().includes(query);
                if (!matchName && !matchClient) return false;
            }
            if (confStartDate) {
                if (new Date(c.startDate) < new Date(confStartDate)) return false;
            }
            if (confEndDate) {
                if (new Date(c.endDate) > new Date(confEndDate)) return false;
            }
            return true;
        });
    }, [conferences, confSearch, confStartDate, confEndDate]);


    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h2 className="text-4xl md:text-5xl font-black text-rose-500 uppercase">System Reports</h2>

            <div className="flex border-b border-slate-800 gap-8">
                <button
                    onClick={() => setActiveTab('Inventory')}
                    className={`pb-4 text-sm font-bold uppercase tracking-widest transition-colors relative ${activeTab === 'Inventory' ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    Inventory Assets
                    {activeTab === 'Inventory' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-sky-400 rounded-t-full" />}
                </button>
                <button
                    onClick={() => setActiveTab('Conferences')}
                    className={`pb-4 text-sm font-bold uppercase tracking-widest transition-colors relative ${activeTab === 'Conferences' ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    Conferences
                    {activeTab === 'Conferences' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-sky-400 rounded-t-full" />}
                </button>
            </div>

            {activeTab === 'Inventory' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
                        <div className="flex flex-wrap items-center gap-4 w-full lg:w-auto">
                            <select 
                                value={invCategory}
                                onChange={e => {
                                    setInvCategory(e.target.value);
                                    setInvSubCategory('All'); // Reset subcategory when parent changes
                                }}
                                className="form-select-night py-3 text-sm min-w-[200px]"
                            >
                                <option value="All">All Categories</option>
                                {Object.values(AssetCategory).map(cat => (
                                    <option key={cat} value={cat}>{cat}</option>
                                ))}
                            </select>

                            {/* Dynamic Sub-Category Filter */}
                            {invCategory !== 'All' && SUBCATEGORY_MAP[invCategory] && (
                                <select 
                                    value={invSubCategory}
                                    onChange={e => setInvSubCategory(e.target.value)}
                                    className="form-select-night py-3 text-sm min-w-[200px] border-sky-900/50 bg-sky-950/20 text-sky-400 focus:border-sky-500"
                                >
                                    <option value="All">All Sub-Categories</option>
                                    {SUBCATEGORY_MAP[invCategory].map(sub => (
                                        <option key={sub} value={sub}>{sub}</option>
                                    ))}
                                </select>
                            )}
                        </div>
                        <div className="relative w-full lg:w-80">
                            <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                            <input
                                type="text"
                                placeholder="Search processors, i7, mixers..."
                                value={invSearch}
                                onChange={e => setInvSearch(e.target.value)}
                                className="form-input-night pl-11 py-3 text-sm w-full"
                            />
                        </div>
                    </div>

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
                                {formattedInventory.map(asset => (
                                    <tr key={asset.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors">
                                        <td className="p-4 md:p-6">
                                            <p className="font-bold text-white text-sm break-words">{asset.aliasName || asset.name}</p>
                                            <p className="text-[10px] text-slate-400 font-mono mt-1">{asset.sku}</p>
                                        </td>
                                        <td className="p-4 md:p-6 text-sm text-slate-300">{asset.type}</td>
                                        <td className="p-4 md:p-6">
                                            <div className="flex items-center gap-3">
                                                <div className="flex-1 w-24 h-2 bg-slate-800 rounded-full overflow-hidden">
                                                    <div 
                                                        className={`h-full rounded-full ${asset.lifeConsumedPercent > 80 ? 'bg-rose-500' : asset.lifeConsumedPercent > 50 ? 'bg-orange-500' : 'bg-emerald-500'}`}
                                                        style={{ width: `${Math.min(100, asset.lifeConsumedPercent)}%` }}
                                                    ></div>
                                                </div>
                                                <span className="text-xs font-bold text-slate-400">{asset.lifeConsumedPercent}% used</span>
                                            </div>
                                            <p className="text-[10px] text-slate-500 mt-1">Purchased: {asset.purchasedDate || 'Unknown'}</p>
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
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {activeTab === 'Conferences' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col lg:flex-row gap-4 items-center justify-between">
                        <div className="flex items-center gap-4 w-full lg:w-auto">
                            <input 
                                type="date"
                                value={confStartDate}
                                onChange={e => setConfStartDate(e.target.value)}
                                className="form-input-night py-3 text-sm"
                            />
                            <span className="text-slate-500 font-bold uppercase text-xs">TO</span>
                            <input 
                                type="date"
                                value={confEndDate}
                                onChange={e => setConfEndDate(e.target.value)}
                                className="form-input-night py-3 text-sm"
                            />
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
                                    <th className="p-4 md:p-6 text-xs uppercase tracking-widest font-black text-slate-500">Technicians Assigned</th>
                                </tr>
                            </thead>
                            <tbody>
                                {formattedConferences.map(c => (
                                    <tr key={c.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors">
                                        <td className="p-4 md:p-6">
                                            <p className="font-bold text-white text-sm break-words">{c.conferenceName || c.name}</p>
                                            <p className="text-[10px] text-slate-400 font-mono mt-1">{c.associationName}</p>
                                        </td>
                                        <td className="p-4 md:p-6 text-sm text-slate-300">
                                            {c.startDate} to {c.endDate}
                                        </td>
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
