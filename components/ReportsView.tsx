import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Asset, Booking, Employee, AssetCategory } from '../types';
import jsPDFLib from 'jspdf';
import * as XLSX from 'xlsx';

interface ReportsViewProps {
    apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
    user?: any;
    onEditAsset?: (asset: Asset) => void;
}

const normalizeSearch = (s: string) => (s || '').replace(/[-_\s]/g, '').toLowerCase();

export const ReportsView: React.FC<ReportsViewProps> = ({ apiFetch, user, onEditAsset }) => {
    const [activeTab, setActiveTab] = useState<'Conferences' | 'Personal'>('Conferences');

    // Data State
    const [assets, setAssets] = useState<Asset[]>([]);
    const [conferences, setConferences] = useState<Booking[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loading, setLoading] = useState(true);

    // Filters & Pagination
    const [confSearch, setConfSearch] = useState('');
    const [confStartDate, setConfStartDate] = useState('');
    const [confEndDate, setConfEndDate] = useState('');
    
    const [empSearch, setEmpSearch] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 20;

    // Modals
    const [detailAsset, setDetailAsset] = useState<Asset | null>(null);
    const [isAssigningTo, setIsAssigningTo] = useState<Employee | null>(null);
    const [assignmentSearch, setAssignmentSearch] = useState('');

    // ─── Data Loading ──────────────────────────────────────────
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [assetsRes, confRes, empRes, usersRes] = await Promise.all([
                apiFetch('/api/assets/'),
                apiFetch('/api/conferences/'),
                apiFetch('/api/employees/'),
                apiFetch('/api/system-users/')
            ]);
            
            let loadedAssets: Asset[] = assetsRes.ok ? await assetsRes.json() : [];
            let loadedConferences: Booking[] = confRes.ok ? await confRes.json() : [];
            let loadedEmployees: Employee[] = empRes.ok ? await empRes.json() : [];
            
            // Bridge System Users to Employees for Assignment
            if (usersRes.ok) {
                const systemUsers = await usersRes.json();
                const existingEmails = new Set(loadedEmployees.map(e => (e.email || '').toLowerCase()));
                systemUsers.forEach((u: any) => {
                    if (u.email && !existingEmails.has(u.email.toLowerCase())) {
                        loadedEmployees.push({
                            id: `u-${u.id}`,
                            name: u.email.split('@')[0].toUpperCase(),
                            employee_id: `SYS-${u.id}`,
                            department: 'Management',
                            email: u.email,
                            role: u.role || 'admin',
                            phone: '-',
                            joined_at: u.date_joined
                        } as any);
                    }
                });
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

            setAssets(loadedAssets.map(mapAsset));
            setConferences(loadedConferences);
            setEmployees(loadedEmployees);
            
        } catch (err) {
            console.error("Reports Load Error:", err);
        } finally {
            setLoading(false);
        }
    }, [apiFetch]);

    useEffect(() => { loadData(); }, [loadData]);

    // ─── Memoized Computations (Performance) ───────────────────
    
    // Group all assets by their assigned_to ID once
    const assignmentsMap = useMemo(() => {
        const map: Record<string, Asset[]> = {};
        assets.forEach(a => {
            if (a.assigned_to) {
                const eid = String(a.assigned_to);
                const isLaptop = a.type === 'Laptops' || a.type === AssetCategory.LAPTOPS || 
                                (a.sku || '').toUpperCase().includes('LAPTOP') || 
                                (a.sku || '').toUpperCase().includes('MACBOOK');
                if (isLaptop) {
                    if (!map[eid]) map[eid] = [];
                    map[eid].push(a);
                }
            }
        });
        return map;
    }, [assets]);

    // Calculate usage history ONLY for the asset in the detail modal (On-demand)
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
    
    const filteredEmployees = useMemo(() => {
        return employees.filter(e => {
            if (!empSearch) return true;
            const q = normalizeSearch(empSearch);
            return normalizeSearch(e.name).includes(q) || normalizeSearch(e.employee_id).includes(q);
        });
    }, [employees, empSearch]);

    const paginatedEmployees = useMemo(() => {
        const start = (currentPage - 1) * itemsPerPage;
        return filteredEmployees.slice(start, start + itemsPerPage);
    }, [filteredEmployees, currentPage]);

    const totalEmpPages = Math.ceil(filteredEmployees.length / itemsPerPage);

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

    // ─── Actions ─────────────────────────────────────────────
    
    const handleAssignLaptop = async (assetId: number, employeeId: string | number) => {
        try {
            const response = await apiFetch(`/api/assets/${assetId}/`, {
                method: 'PATCH',
                body: JSON.stringify({ assigned_to: employeeId })
            });
            if (response.ok) {
                setIsAssigningTo(null);
                setAssignmentSearch('');
                loadData();
            }
        } catch (err) {
            console.error("Assign Error:", err);
        }
    };

    const downloadPDF = () => {
        const doc = new jsPDFLib({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        doc.setFontSize(16);
        doc.text('Employee Laptop Assignments', 15, 20);
        doc.setFontSize(10);
        let y = 30;
        employees.forEach((emp) => {
            const assigned = assignmentsMap[String(emp.id)] || [];
            if (assigned.length > 0) {
                if (y > 270) { doc.addPage(); y = 20; }
                doc.setFont('helvetica', 'bold');
                doc.text(`${emp.name} (${emp.employee_id}) - ${(emp as any).role || emp.department}`, 15, y);
                y += 5;
                doc.setFont('helvetica', 'normal');
                assigned.forEach(l => {
                    doc.text(`• ${l.aliasName || l.sku} [${l.sku}]`, 20, y);
                    y += 5;
                });
                y += 5;
            }
        });
        doc.save(`Employee_Laptops_${new Date().toISOString().slice(0, 10)}.pdf`);
    };

    const exportToExcel = () => {
        const data = employees.map(emp => {
            const assigned = assignmentsMap[String(emp.id)] || [];
            return {
                'Employee ID': emp.employee_id,
                'Employee Name': emp.name,
                'Role': (emp as any).role || emp.department || '-',
                'Assigned Laptops': assigned.map(l => l.aliasName || l.sku).join(', ')
            };
        });
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Employee Laptops");
        XLSX.writeFile(wb, `Employee_Laptops_${new Date().toISOString().slice(0, 10)}.xlsx`);
    };

    // ─── Render Components ────────────────────────────────────

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
                            <i className="fa-solid fa-xmark text-lg"></i>
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

    const renderAssignmentModal = () => {
        if (!isAssigningTo) return null;
        let pool = assets.filter(a => {
            if (a.assigned_to) return false;
            if (assignmentSearch) return true; // Broad search if typing
            const searchPool = (a.type + ' ' + a.sku + ' ' + (a.aliasName || '') + ' ' + (a.name || '')).toUpperCase();
            return a.type === 'Laptops' || a.type === AssetCategory.LAPTOPS || a.type === AssetCategory.COMPUTERS || a.type === AssetCategory.IT ||
                   searchPool.includes('LAPTOP') || searchPool.includes('MACBOOK') || searchPool.includes('MAC') || searchPool.includes('THINKPAD');
        });

        if (assignmentSearch) {
            const q = normalizeSearch(assignmentSearch);
            pool = pool.filter(l => 
                normalizeSearch(l.aliasName || (l as any).alias_name || (l as any).name || '').includes(q) || 
                normalizeSearch(l.sku).includes(q) || 
                normalizeSearch(l.serialNumber || (l as any).serial_number || '').includes(q)
            );
        }

        return (
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-sm" onClick={() => { setIsAssigningTo(null); setAssignmentSearch(''); }}></div>
                <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-[2.5rem] shadow-2xl overflow-hidden p-8 space-y-6">
                    <div className="flex justify-between items-center">
                        <h3 className="text-xl font-black text-white uppercase">Assign to {isAssigningTo.name}</h3>
                        <button onClick={() => { setIsAssigningTo(null); setAssignmentSearch(''); }} className="w-10 h-10 flex items-center justify-center text-slate-500 hover:text-white transition"><i className="fa-solid fa-xmark"></i></button>
                    </div>
                    <div className="relative">
                        <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                        <input type="text" placeholder="SKU, NAME OR SERIAL..." value={assignmentSearch} onChange={e => setAssignmentSearch(e.target.value)} className="form-input-night pl-10 h-12 text-[10px] font-black uppercase tracking-widest w-full" />
                    </div>
                    <div className="max-h-[40vh] overflow-y-auto space-y-2 custom-scrollbar pr-2">
                        {pool.slice(0, 50).map(l => (
                            <button key={l.id} onClick={() => handleAssignLaptop(l.id as any, isAssigningTo.id)} className="w-full p-4 bg-slate-950/40 border border-slate-800 rounded-2xl flex justify-between items-center hover:bg-sky-500/10 hover:border-sky-500/50 transition-all text-left group">
                                <div>
                                    <p className="font-bold text-white text-sm uppercase group-hover:text-sky-400 transition-colors">{l.aliasName || (l as any).name}</p>
                                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">{l.sku}</p>
                                </div>
                                <i className="fa-solid fa-plus text-sky-400"></i>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    if (loading) return <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div></div>;

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {renderAssetModal()}
            {renderAssignmentModal()}

            <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-4">
                    <h2 className="text-4xl md:text-5xl font-black text-orange-500 uppercase">System Reports</h2>
                    <button onClick={loadData} className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:text-sky-400 transition" title="Manual Refresh">
                        <i className={`fa-solid fa-rotate ${loading ? 'animate-spin' : ''}`}></i>
                    </button>
                </div>
                <div className="flex gap-2">
                    <button onClick={exportToExcel} className="flex items-center gap-2 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-white font-bold text-xs px-5 py-3 rounded-2xl transition-all"><i className="fa-solid fa-file-excel text-emerald-500"></i> Excel</button>
                    <button onClick={downloadPDF} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-5 py-3 rounded-2xl transition-all shadow-lg hover:shadow-emerald-500/30"><i className="fa-solid fa-file-pdf"></i> PDF</button>
                </div>
            </div>

            <div className="flex border-b border-slate-800 gap-8 overflow-x-auto no-scrollbar">
                {(['Conferences', 'Personal'] as const).map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`pb-4 text-xs font-black uppercase tracking-widest transition-colors relative whitespace-nowrap ${activeTab === tab ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}>
                        {tab === 'Conferences' ? 'Conferences' : 'Employee Assets'}
                        {activeTab === tab && <div className="absolute bottom-0 left-0 w-full h-1 bg-sky-400 rounded-t-full" />}
                    </button>
                ))}
            </div>

            {activeTab === 'Personal' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                        <h3 className="text-xl font-black text-white uppercase tracking-tight">Employee Assets</h3>
                        <input type="text" placeholder="SEARCH EMPLOYEE NAME OR ID..." value={empSearch} onChange={e => { setEmpSearch(e.target.value); setCurrentPage(1); }} className="form-input-night px-6 py-4 text-[10px] font-black uppercase tracking-widest w-full md:w-96" />
                    </div>
                    <div className="overflow-x-auto rounded-[1.5rem] border border-slate-800/50 bg-slate-950/40">
                        <table className="w-full text-left">
                            <thead className="bg-slate-900/50 border-b border-slate-800">
                                <tr className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                    <th className="p-6">Employee</th>
                                    <th className="p-6">Role</th>
                                    <th className="p-6">Assigned Hardware</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/20">
                                {paginatedEmployees.map(emp => {
                                    const assigned = assignmentsMap[String(emp.id)] || [];
                                    return (
                                        <tr key={emp.id} className="hover:bg-sky-500/5 transition-all text-sm font-bold">
                                            <td className="p-6">
                                                <p className="text-white uppercase">{emp.name}</p>
                                                <p className="text-[9px] text-slate-500 font-mono mt-1">ID: {emp.employee_id}</p>
                                            </td>
                                            <td className="p-6">
                                                <span className="px-3 py-1 bg-slate-800 text-[10px] font-black text-slate-400 uppercase rounded-lg">{(emp as any).role || emp.department || '-'}</span>
                                            </td>
                                            <td className="p-6">
                                                <div className="flex flex-wrap gap-4 items-center">
                                                    {assigned.length > 0 ? (
                                                        <div className="flex-1 space-y-1">
                                                            {assigned.map(l => (
                                                                <div key={l.id} className="flex items-center gap-2">
                                                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                                                    <p className="text-xs text-slate-200 uppercase">{l.aliasName || l.sku}</p>
                                                                    <button onClick={() => setDetailAsset(l)} className="text-[9px] text-sky-400 font-black uppercase hover:text-white transition-colors">Details</button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ) : (<span className="text-[10px] text-slate-700 italic font-black uppercase">No Laptops</span>)}
                                                    {(user?.role === 'admin' || user?.is_staff) && (
                                                        <button onClick={() => setIsAssigningTo(emp)} className="px-4 py-2 bg-slate-800 border border-slate-700 text-slate-400 hover:text-sky-400 rounded-xl text-[9px] font-black uppercase transition-all">Assign New</button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {totalEmpPages > 1 && (
                        <div className="flex justify-center gap-2 mt-8">
                            {[...Array(totalEmpPages)].map((_, i) => (
                                <button key={i} onClick={() => setCurrentPage(i + 1)} className={`w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-black transition-all ${currentPage === i + 1 ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/30' : 'bg-slate-800 text-slate-500 hover:text-white'}`}>{i + 1}</button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'Conferences' && (
                <div className="bg-slate-900/30 p-5 md:p-8 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                    <div className="flex flex-col lg:flex-row gap-4 items-center justify-between">
                        <div className="flex items-center gap-3">
                            <input type="date" value={confStartDate} onChange={e => setConfStartDate(e.target.value)} className="form-input-night py-3 text-xs font-bold" />
                            <i className="fa-solid fa-arrow-right text-slate-700 text-xs"></i>
                            <input type="date" value={confEndDate} onChange={e => setConfEndDate(e.target.value)} className="form-input-night py-3 text-xs font-bold" />
                        </div>
                        <input type="text" placeholder="SEARCH CLIENT OR EVENT..." value={confSearch} onChange={e => setConfSearch(e.target.value)} className="form-input-night px-6 py-4 text-[10px] font-black uppercase tracking-widest w-full lg:w-96" />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {filteredConferences.map(c => (
                            <div key={c.id} className="bg-slate-950/40 p-6 rounded-3xl border border-slate-800/50 space-y-4 hover:border-sky-500/50 transition-all">
                                <div>
                                    <h4 className="text-sm font-black text-white uppercase truncate">{c.conferenceName || (c as any).name}</h4>
                                    <p className="text-[10px] text-slate-500 font-bold uppercase mt-1 tracking-wider truncate">{c.associationName}</p>
                                </div>
                                <div className="flex justify-between items-end">
                                    <div className="text-[10px] font-mono text-sky-400/70">{c.startDate}</div>
                                    <div className="px-3 py-1 bg-sky-500/10 text-sky-400 rounded-lg text-[10px] font-black uppercase">{(c.assets?.length || 0) + (c.crosscheckAssets?.length || 0)} Assets</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
