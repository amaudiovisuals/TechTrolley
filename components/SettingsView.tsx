import React, { useState, useEffect } from 'react';

interface SettingsViewProps {
    apiFetch: (url: string, options?: any) => Promise<Response>;
    user: any;
}

interface SystemUser {
    id: number;
    email: string;
    date_joined: string;
}

import { CompanySettings, Employee } from '../types';

export const SettingsView: React.FC<SettingsViewProps> = ({ apiFetch, user }) => {
    const API_BASE = '';
    const [activeTab, setActiveTab] = useState<'general' | 'profile' | 'users'>(user?.is_staff ? 'general' : 'profile');
    const [users, setUsers] = useState<SystemUser[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [userSearchQuery, setUserSearchQuery] = useState('');
    const [roleFilter, setRoleFilter] = useState<'All' | 'admin' | 'godown_incharge' | 'technician'>('All');

    // Company Settings State
    const [companySettings, setCompanySettings] = useState<CompanySettings>({
        name: '', address: '', phone: '', email: '', gst_number: '', website: '',
        logo: null, powered_by_name: 'am audiovisuals',
        dashboard_config: {}, theme_template: 'blue',
        print_label_width: 50, print_label_height: 25
    });
    const [logoFile, setLogoFile] = useState<File | null>(null);
    const [logoPreview, setLogoPreview] = useState<string | null>(null);

    const [settingsMsg, setSettingsMsg] = useState({ type: '', text: '' });
    const [isEditing, setIsEditing] = useState(false);

    // Password Change State
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [passwordMsg, setPasswordMsg] = useState({ type: '', text: '' });

    // Add System Admin State
    const [newUserEmail, setNewUserEmail] = useState('');
    const [newUserPassword, setNewUserPassword] = useState('');
    const [addUserMsg, setAddUserMsg] = useState({ type: '', text: '' });

    // Add Employee State
    const [newEmployeeName, setNewEmployeeName] = useState('');
    const [newEmployeeEmail, setNewEmployeeEmail] = useState('');
    const [newEmployeePassword, setNewEmployeePassword] = useState('');
    const [addEmployeeMsg, setAddEmployeeMsg] = useState({ type: '', text: '' });

    useEffect(() => {
        if (activeTab === 'users') {
            fetchEmployees();
            fetchUsers();
        }
        if (activeTab === 'general') fetchCompanySettings();
    }, [activeTab]);

    const fetchCompanySettings = async () => {
        try {
            const res = await apiFetch(`${API_BASE}/api/company-settings/`);
            if (res.ok) {
                const data = await res.json();
                setCompanySettings(data);
                if (data.logo) setLogoPreview(data.logo);
            }
        } catch (e) { console.error(e); }
    };

    const fetchUsers = async () => {
        try {
            const res = await apiFetch(`${API_BASE}/api/system-users/`);
            if (res.ok) setUsers(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchEmployees = async () => {
        try {
            const res = await apiFetch(`${API_BASE}/api/employees/`);
            if (res.ok) setEmployees(await res.json());
        } catch (e) { console.error(e); }
    };

    const handleSaveSettings = async (e: React.FormEvent) => {
        e.preventDefault();
        setSettingsMsg({ type: '', text: '' });

        if (!confirm('Are you sure you want to update the company details? This will reflect on all future challans.')) {
            return;
        }

        try {
            const formData = new FormData();
            formData.append('name', companySettings.name);
            formData.append('address', companySettings.address);
            formData.append('phone', companySettings.phone);
            formData.append('email', companySettings.email);
            formData.append('gst_number', companySettings.gst_number);
            formData.append('website', companySettings.website);
            formData.append('powered_by_name', companySettings.powered_by_name || 'am audiovisuals');
            if (companySettings.dashboard_config) {
                formData.append('dashboard_config', JSON.stringify(companySettings.dashboard_config));
            }
            if (companySettings.theme_template) {
                formData.append('theme_template', companySettings.theme_template);
            }
            formData.append('print_label_width', companySettings.print_label_width.toString());
            formData.append('print_label_height', companySettings.print_label_height.toString());

            if (logoFile) {
                formData.append('logo', logoFile);
            }

            const res = await apiFetch(`${API_BASE}/api/company-settings/`, {
                method: 'POST',
                body: formData
            });

            let data: any = {};
            const contentType = res.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) {
                data = await res.json();
            } else {
                const text = await res.text();
                console.error('Non-JSON response:', text);
                throw new Error(`Server returned non-JSON response: ${res.status} ${res.statusText}`);
            }

            if (res.ok) {
                setSettingsMsg({ type: 'success', text: 'Company settings saved successfully!' });
                setCompanySettings(data);
                if (data.logo) setLogoPreview(data.logo);
                setLogoFile(null);
                setIsEditing(false);
                window.location.reload();
            } else if (res.status !== 401) {
                const errorMsg = typeof data === 'object'
                    ? Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(', ')
                    : 'Failed to save settings.';
                setSettingsMsg({ type: 'error', text: errorMsg });
            }
        } catch (e: any) {
            console.error('Settings save error:', e);
            setSettingsMsg({ type: 'error', text: e.message || 'Connection error.' });
        }
    };

    const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setLogoFile(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setLogoPreview(reader.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setPasswordMsg({ type: '', text: '' });

        try {
            const res = await apiFetch(`${API_BASE}/api/change-password/`, {
                method: 'POST',
                body: JSON.stringify({ old_password: oldPassword, new_password: newPassword })
            });
            const data = await res.json();
            if (res.ok) {
                setPasswordMsg({ type: 'success', text: 'Password updated successfully!' });
                setOldPassword('');
                setNewPassword('');
            } else if (res.status !== 401) {
                setPasswordMsg({ type: 'error', text: data.error || 'Failed to update password.' });
            }
        } catch (err) {
            setPasswordMsg({ type: 'error', text: 'Connection error.' });
        }
    };

    const handleAddUser = async (e: React.FormEvent) => {
        e.preventDefault();
        setAddUserMsg({ type: '', text: '' });

        try {
            const res = await apiFetch(`${API_BASE}/api/system-users/`, {
                method: 'POST',
                body: JSON.stringify({ email: newUserEmail, password: newUserPassword })
            });
            const data = await res.json();
            if (res.ok) {
                setAddUserMsg({ type: 'success', text: 'User added successfully!' });
                setNewUserEmail('');
                setNewUserPassword('');
                fetchUsers();
            } else if (res.status !== 401) {
                const errorText = data.error || data.detail || (typeof data === 'object' ? Object.values(data).flat().join(', ') : 'Failed to add user.');
                setAddUserMsg({ type: 'error', text: errorText });
            }
        } catch (err) {
            setAddUserMsg({ type: 'error', text: 'Connection error.' });
        }
    };

    const handleAddEmployee = async (e: React.FormEvent) => {
        e.preventDefault();
        setAddEmployeeMsg({ type: '', text: '' });

        const mockId = `EMP-${new Date().getTime()}`;

        try {
            const res = await apiFetch(`${API_BASE}/api/employees/`, {
                method: 'POST',
                body: JSON.stringify({
                    name: newEmployeeName,
                    email: newEmployeeEmail,
                    password: newEmployeePassword,
                    employee_id: mockId,
                    department: 'User',
                    phone: 'N/A'
                })
            });
            const data = await res.json();
            if (res.ok) {
                setAddEmployeeMsg({ type: 'success', text: 'User added successfully!' });
                setNewEmployeeName('');
                setNewEmployeeEmail('');
                setNewEmployeePassword('');
                fetchEmployees();
            } else if (res.status !== 401) {
                const errorText = data.error || data.detail || (typeof data === 'object' ? Object.values(data).flat().join(', ') : 'Failed to add user.');
                setAddEmployeeMsg({ type: 'error', text: errorText });
            }
        } catch (err) {
            setAddEmployeeMsg({ type: 'error', text: 'Connection error.' });
        }
    };

    const handleUpdateRole = async (email: string, role: string) => {
        // BUG J-10: Prevent admin from demoting their own account (self-lockout)
        if (email === user?.email && role === 'technician') {
            alert('You cannot demote your own admin account.');
            fetchEmployees();
            fetchUsers();
            return;
        }
        if (!window.confirm(`Are you sure you want to change the role for ${email} to ${role.toUpperCase()}?`)) {
            // Re-fetch to reset dropdown if they cancel (optional but good)
            fetchEmployees();
            fetchUsers();
            return;
        }
        try {
            const res = await apiFetch(`${API_BASE}/api/users/role/`, {
                method: 'PUT',
                body: JSON.stringify({ email, role })
            });
            if (res.ok) {
                fetchEmployees();
                fetchUsers();
            } else {
                const data = await res.json().catch(() => ({}));
                alert(`Failed to update role. ${data.error || 'Please ensure you have permission.'}`);
            }
        } catch (e) {
            alert('Connection error while updating role.');
        }
    };

    const handleDeleteUser = async (id: number) => {
        if (!confirm('Are you sure you want to delete this system administrator?')) return;
        try {
            const res = await apiFetch(`${API_BASE}/api/system-users/${id}/`, {
                method: 'DELETE'
            });
            if (res.ok) fetchUsers();
            else if (res.status !== 401) alert('Failed to delete user. You cannot delete yourself.');
        } catch (e) { alert('Connection error'); }
    };

    const handleDeleteEmployee = async (id: number) => {
        if (!confirm('Are you sure you want to delete this user?')) return;
        try {
            const res = await apiFetch(`${API_BASE}/api/employees/${id}/`, {
                method: 'DELETE'
            });
            if (res.ok) fetchEmployees();
            else if (res.status !== 401) alert('Failed to delete user.');
        } catch (e) { alert('Connection error'); }
    };

    // Consolidated Merge Logic
    const allConsolidatedUsers = React.useMemo(() => {
        // Map employees and system users into a unified format
        const merged = new Map<string, any>();

        // Add employees first
        employees.forEach(emp => {
            merged.set(emp.email.toLowerCase(), {
                ...emp,
                source: 'employee',
                displayName: emp.name || emp.email
            });
        });

        // Add system users if not already present (standalone admins)
        users.forEach(sys => {
            const email = sys.email.toLowerCase();
            if (!merged.has(email)) {
                merged.set(email, {
                    id: sys.id,
                    email: sys.email,
                    name: 'System Admin',
                    displayName: sys.email,
                    role: 'admin',
                    source: 'system'
                });
            } else {
                // If already present as employee, ensure role is prioritized as admin if in sys list
                const existing = merged.get(email);
                if (existing.role !== 'admin') {
                    merged.set(email, {
                        ...existing,
                        role: 'admin',
                        source: 'employee' // Keep employee as source for name/ID, but update role
                    });
                }
            }
        });

        return Array.from(merged.values())
            .filter(u => {
                const search = userSearchQuery.toLowerCase();
                const matchesSearch = !search || 
                    (u.displayName && u.displayName.toLowerCase().includes(search)) ||
                    (u.email && u.email.toLowerCase().includes(search)) ||
                    (u.employee_id && u.employee_id.toLowerCase().includes(search));
                
                const matchesRole = roleFilter === 'All' || u.role === roleFilter;
                
                return matchesSearch && matchesRole;
            })
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }, [employees, users, userSearchQuery, roleFilter]);

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h2 className="text-5xl font-black text-orange-500 uppercase">System Settings</h2>

            <div className="flex gap-4 border-b border-slate-800 pb-1">
                {user?.is_staff && (
                    <button onClick={() => setActiveTab('general')} className={`px-6 py-3 font-black uppercase text-xs tracking-widest transition-all ${activeTab === 'general' ? 'text-sky-500 border-b-2 border-sky-500' : 'text-slate-500 hover:text-white'}`}>
                        General
                    </button>
                )}
                <button onClick={() => setActiveTab('profile')} className={`px-6 py-3 font-black uppercase text-xs tracking-widest transition-all ${activeTab === 'profile' ? 'text-sky-500 border-b-2 border-sky-500' : 'text-slate-500 hover:text-white'}`}>
                    My Account
                </button>
                {user?.is_staff && (
                    <>
                        <button onClick={() => setActiveTab('users')} className={`px-6 py-3 font-black uppercase text-xs tracking-widest transition-all ${activeTab === 'users' ? 'text-sky-500 border-b-2 border-sky-500' : 'text-slate-500 hover:text-white'}`}>
                            Users
                        </button>
                    </>
                )}
            </div>

            {activeTab === 'general' && (
                <div className="max-w-4xl">
                    <form onSubmit={handleSaveSettings} className="bg-slate-900/30 p-5 md:p-10 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-2xl font-black text-white uppercase">Company Details</h3>
                            {!isEditing && (
                                <button type="button" onClick={() => setIsEditing(true)} className="px-6 py-2 bg-slate-800 text-sky-400 rounded-xl font-black uppercase text-xs hover:bg-slate-700 transition">
                                    <i className="fa-solid fa-pen-to-square mr-2"></i> Edit Details
                                </button>
                            )}
                        </div>
                        {settingsMsg.text && (
                            <div className={`p-4 rounded-xl text-xs font-bold uppercase ${settingsMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                {settingsMsg.text}
                            </div>
                        )}

                        <div className="flex flex-col md:flex-row gap-10">
                            <div className="flex-1 space-y-6">
                                <div>
                                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Company Name</label>
                                    <input disabled={!isEditing} value={companySettings.name} onChange={e => setCompanySettings({ ...companySettings, name: e.target.value })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all`} required />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">White-label Branding (Powered by...)</label>
                                    <input disabled={!isEditing} value={companySettings.powered_by_name} onChange={e => setCompanySettings({ ...companySettings, powered_by_name: e.target.value })} placeholder="e.g. tech trolley" className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all`} />
                                </div>
                            </div>

                            <div className="w-full md:w-64 space-y-4">
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Company Logo</label>
                                <div className={`aspect-video rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-4 transition-all ${isEditing ? 'border-slate-700 bg-slate-950/40' : 'border-transparent bg-slate-950/20'}`}>
                                    {logoPreview ? (
                                        <div className="relative group w-full h-full flex items-center justify-center">
                                            <img src={logoPreview} alt="Logo Preview" className="max-w-full max-h-full object-contain" />
                                            {isEditing && (
                                                <button type="button" onClick={() => { setLogoFile(null); setLogoPreview(null); }} className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] shadow-lg">
                                                    <i className="fa-solid fa-xmark"></i>
                                                </button>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="text-center">
                                            <i className="fa-solid fa-image text-slate-700 text-2xl mb-2"></i>
                                            <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest">No Logo Uploaded</p>
                                        </div>
                                    )}
                                </div>
                                {isEditing && (
                                    <label className="block w-full text-center py-3 bg-slate-800 text-slate-300 rounded-xl font-black uppercase text-[10px] cursor-pointer hover:bg-slate-700 transition">
                                        <i className="fa-solid fa-cloud-arrow-up mr-2"></i> {logoPreview ? 'Change Logo' : 'Upload Logo'}
                                        <input type="file" onChange={handleLogoChange} className="hidden" accept="image/*" />
                                    </label>
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-8">
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">GST Number</label>
                                <input disabled={!isEditing} value={companySettings.gst_number} onChange={e => setCompanySettings({ ...companySettings, gst_number: e.target.value })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all`} />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Website</label>
                                <input disabled={!isEditing} value={companySettings.website} onChange={e => setCompanySettings({ ...companySettings, website: e.target.value })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all`} />
                            </div>
                        </div>
                        <div>
                            <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Address</label>
                            <textarea disabled={!isEditing} value={companySettings.address} onChange={e => setCompanySettings({ ...companySettings, address: e.target.value })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all h-24 resize-none`} required />
                        </div>
                        <div className="grid grid-cols-2 gap-8">
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Phone</label>
                                <input disabled={!isEditing} value={companySettings.phone} onChange={e => setCompanySettings({ ...companySettings, phone: e.target.value })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all`} required />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Email</label>
                                <input disabled={!isEditing} type="email" value={companySettings.email} onChange={e => setCompanySettings({ ...companySettings, email: e.target.value })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all`} required />
                            </div>
                        </div>
                        <div className="pt-8 border-t border-slate-800/50 space-y-8">
                            <div>
                                <h4 className="text-xl font-black text-white uppercase mb-4">Dashboard & Print Settings</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <div>
                                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Theme Template</label>
                                        <select disabled={!isEditing} value={companySettings.theme_template || 'blue'} onChange={e => setCompanySettings({ ...companySettings, theme_template: e.target.value as 'blue' | 'green' })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all uppercase text-xs`}>
                                            <option value="blue">Blue (Default)</option>
                                            <option value="green">Green (Personalized)</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">QR Label Dimensions (mm)</label>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="relative">
                                                <input 
                                                    type="number" 
                                                    disabled={!isEditing} 
                                                    value={companySettings.print_label_width} 
                                                    onChange={e => setCompanySettings({ ...companySettings, print_label_width: parseInt(e.target.value) || 0 })} 
                                                    className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 pl-4 pr-12 font-bold transition-all text-xs`} 
                                                    placeholder="Width"
                                                />
                                                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-black text-slate-600 uppercase">W</span>
                                            </div>
                                            <div className="relative">
                                                <input 
                                                    type="number" 
                                                    disabled={!isEditing} 
                                                    value={companySettings.print_label_height} 
                                                    onChange={e => setCompanySettings({ ...companySettings, print_label_height: parseInt(e.target.value) || 0 })} 
                                                    className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 pl-4 pr-12 font-bold transition-all text-xs`} 
                                                    placeholder="Height"
                                                />
                                                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-black text-slate-600 uppercase">H</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block">Stats & Tables Configuration</label>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-4">
                                    {[
                                        { key: 'total_assets', label: 'Total Assets', default: 'Total Assets' },
                                        { key: 'in_use', label: 'In Use', default: 'Currently In Use' },
                                        { key: 'available', label: 'Available', default: 'Ready / Available' },
                                        { key: 'active_conferences', label: 'Active Conferences', default: 'Active Conferences' },
                                        { key: 'active_conferences_table', label: 'Conferences Table', default: 'Active Conferences' },
                                        { key: 'active_allocations_table', label: 'Allocations Table', default: 'Active Allocations' },
                                    ].map(item => (
                                        <div key={item.key} className="flex gap-2 items-center">
                                            <button
                                                type="button"
                                                disabled={!isEditing}
                                                onClick={() => {
                                                    const newConfig = { ...companySettings.dashboard_config, [item.key]: companySettings.dashboard_config?.[item.key] === false ? true : false };
                                                    setCompanySettings({ ...companySettings, dashboard_config: newConfig });
                                                }}
                                                className={`w-10 h-10 flex-shrink-0 rounded-lg flex items-center justify-center transition-all border ${companySettings.dashboard_config?.[item.key] !== false ? 'bg-sky-500/10 border-sky-500 text-sky-500' : 'bg-slate-800/50 border-slate-700 text-slate-500'}`}
                                            >
                                                <i className={`fa-solid ${companySettings.dashboard_config?.[item.key] !== false ? 'fa-eye' : 'fa-eye-slash'}`}></i>
                                            </button>
                                            <input
                                                disabled={!isEditing}
                                                value={companySettings.dashboard_config?.[`${item.key}_label`] || item.default}
                                                onChange={(e) => {
                                                    const newConfig = { ...companySettings.dashboard_config, [`${item.key}_label`]: e.target.value };
                                                    setCompanySettings({ ...companySettings, dashboard_config: newConfig });
                                                }}
                                                placeholder={item.label}
                                                className={`flex-1 bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl px-4 py-2 text-xs font-bold transition-all uppercase`}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {isEditing && (
                            <div className="flex gap-4">
                                <button type="button" onClick={() => { setIsEditing(false); fetchCompanySettings(); setLogoFile(null); }} className="py-4 px-8 bg-slate-800 text-white rounded-xl font-black uppercase hover:bg-slate-700 transition">Cancel</button>
                                <button type="submit" className="py-4 px-8 bg-sky-500 text-white rounded-xl font-black uppercase hover:bg-sky-400 transition shadow-lg shadow-sky-500/20">Save Configuration</button>
                            </div>
                        )}
                    </form>
                </div>
            )}

            {activeTab === 'profile' && (
                <div className="max-w-2xl">
                    <form onSubmit={handleChangePassword} className="bg-slate-900/30 p-5 md:p-10 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                        <h3 className="text-2xl font-black text-white uppercase mb-4">Change Password</h3>
                        {passwordMsg.text && (
                            <div className={`p-4 rounded-xl text-xs font-bold uppercase ${passwordMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                {passwordMsg.text}
                            </div>
                        )}
                        <div>
                            <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Current Password</label>
                            <input type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold" required />
                        </div>
                        <div>
                            <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">New Password</label>
                            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold" required />
                        </div>
                        <button type="submit" className="py-4 px-8 bg-sky-500 text-white rounded-xl font-black uppercase hover:bg-sky-400 transition">Update Password</button>
                    </form>
                </div>
            )}

            {activeTab === 'users' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                    <div className="lg:col-span-8 bg-slate-900/30 p-5 md:p-10 rounded-[2.5rem] border border-slate-800/50">
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-10">
                            <h3 className="text-2xl font-black text-white uppercase">Management</h3>
                            
                            <div className="flex flex-col sm:flex-row gap-4 w-full md:w-auto flex-1 md:max-w-md">
                                <div className="relative flex-1">
                                    <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                                    <input 
                                        type="text" 
                                        placeholder="SEARCH..." 
                                        value={userSearchQuery}
                                        onChange={e => setUserSearchQuery(e.target.value)}
                                        className="w-full bg-slate-950/40 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-[10px] font-black uppercase text-white focus:border-sky-500 outline-none transition"
                                    />
                                </div>
                                <select 
                                    value={roleFilter}
                                    onChange={e => setRoleFilter(e.target.value as any)}
                                    className="bg-slate-950/40 border border-slate-800 rounded-xl px-4 py-2.5 text-[10px] font-black uppercase text-slate-400 outline-none focus:border-sky-500 transition cursor-pointer"
                                >
                                    <option value="All">All Roles</option>
                                    <option value="admin">Admins Only</option>
                                    <option value="godown_incharge">Incharges</option>
                                    <option value="technician">Technicians</option>
                                </select>
                            </div>
                        </div>

                        <div className="space-y-4">
                            {allConsolidatedUsers.map(u => (
                                <div key={u.email} className="flex flex-wrap sm:flex-nowrap items-center justify-between p-5 bg-slate-950/50 rounded-2xl border border-slate-900 group hover:border-slate-700 transition gap-4">
                                    <div className="flex items-center gap-4 min-w-0 flex-1">
                                        <div className={`w-12 h-12 rounded-2xl flex shrink-0 items-center justify-center shadow-inner ${
                                            u.role === 'admin' ? 'bg-orange-500/10 text-orange-400' :
                                            u.role === 'godown_incharge' ? 'bg-sky-500/10 text-sky-400' : 
                                            'bg-teal-500/10 text-teal-400'
                                        }`}>
                                            <i className={`fa-solid ${
                                                u.role === 'admin' ? 'fa-user-shield' :
                                                u.role === 'godown_incharge' ? 'fa-warehouse' : 
                                                'fa-user-tag'
                                            } text-lg`}></i>
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-3">
                                                <p className="text-sm font-black text-white uppercase truncate tracking-tight">{u.displayName}</p>
                                                {u.source === 'system' && (
                                                    <span className="px-2 py-0.5 bg-orange-500/20 text-[8px] font-black uppercase text-orange-400 rounded-md border border-orange-500/20">System Admin</span>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-slate-500 font-medium truncate opacity-70 mt-0.5 uppercase tracking-wider">{u.email} {u.department ? `• ${u.department}` : ''}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-end gap-3 shrink-0">
                                        <select
                                            value={u.role || 'technician'}
                                            onChange={(e) => handleUpdateRole(u.email, e.target.value)}
                                            className="bg-slate-900/80 border border-slate-800 rounded-xl text-white text-[10px] font-black p-2.5 uppercase outline-none focus:border-sky-500 transition cursor-pointer hover:bg-slate-800"
                                        >
                                            <option value="admin">Admin</option>
                                            <option value="godown_incharge">Incharge</option>
                                            <option value="technician">Technician</option>
                                        </select>
                                        <button 
                                            onClick={() => u.source === 'system' ? handleDeleteUser(u.id) : handleDeleteEmployee(u.id!)} 
                                            className="w-10 h-10 flex items-center justify-center text-slate-600 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition"
                                            title="Delete User"
                                        >
                                            <i className="fa-solid fa-trash text-sm"></i>
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {allConsolidatedUsers.length === 0 && (
                                <div className="text-center py-20 bg-slate-950/20 rounded-[2rem] border border-dashed border-slate-800">
                                    <i className="fa-solid fa-users-slash text-4xl text-slate-800 mb-4 block"></i>
                                    <p className="text-slate-500 font-black tracking-widest uppercase text-xs">No users found matching filters.</p>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="lg:col-span-4 sticky top-24">
                        <form onSubmit={handleAddEmployee} className="bg-slate-900/30 p-5 md:p-10 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                            <div className="flex items-center gap-4 mb-2">
                                <div className="w-10 h-10 bg-teal-500/10 text-teal-500 rounded-xl flex items-center justify-center">
                                    <i className="fa-solid fa-plus" />
                                </div>
                                <h3 className="text-2xl font-black text-white uppercase">New User</h3>
                            </div>
                            {addEmployeeMsg.text && (
                                <div className={`p-4 rounded-xl text-xs font-bold uppercase animate-in fade-in zoom-in-95 ${addEmployeeMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                    {addEmployeeMsg.text}
                                </div>
                            )}
                            <div className="space-y-4">
                                <div>
                                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Full Name</label>
                                    <input type="text" value={newEmployeeName} onChange={e => setNewEmployeeName(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold text-xs focus:border-teal-500 outline-none transition-all" placeholder="e.g. John Doe" required />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Login ID / Email</label>
                                    <input type="text" value={newEmployeeEmail} onChange={e => setNewEmployeeEmail(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold text-xs focus:border-teal-500 outline-none transition-all" placeholder="name@company.com" required />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Initial Password</label>
                                    <input type="password" value={newEmployeePassword} onChange={e => setNewEmployeePassword(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold text-xs focus:border-teal-500 outline-none transition-all" placeholder="••••••••" required />
                                </div>
                            </div>
                            <button type="submit" className="w-full py-5 bg-teal-500 text-white rounded-xl font-black uppercase hover:bg-teal-400 transition-all shadow-lg shadow-teal-500/20 active:scale-95">
                                Register User Record
                            </button>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
