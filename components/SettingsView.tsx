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
    const [activeTab, setActiveTab] = useState<'general' | 'profile' | 'team' | 'users'>(user?.is_staff ? 'general' : 'profile');
    const [users, setUsers] = useState<SystemUser[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);

    // Company Settings State
    const [companySettings, setCompanySettings] = useState<CompanySettings>({
        name: '', address: '', phone: '', email: '', gst_number: '', website: '',
        logo: null, powered_by_name: 'am audiovisuals',
        dashboard_config: {}, theme_template: 'blue'
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
        if (activeTab === 'team') fetchUsers();
        if (activeTab === 'users') fetchEmployees();
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
                        <button onClick={() => setActiveTab('team')} className={`px-6 py-3 font-black uppercase text-xs tracking-widest transition-all ${activeTab === 'team' ? 'text-sky-500 border-b-2 border-sky-500' : 'text-slate-500 hover:text-white'}`}>
                            System Administrators
                        </button>
                    </>
                )}
            </div>

            {activeTab === 'general' && (
                <div className="max-w-4xl">
                    <form onSubmit={handleSaveSettings} className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50 space-y-6">
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
                                <h4 className="text-xl font-black text-white uppercase mb-4">Dashboard & Theme</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <div>
                                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Theme Template</label>
                                        <select disabled={!isEditing} value={companySettings.theme_template || 'blue'} onChange={e => setCompanySettings({ ...companySettings, theme_template: e.target.value as 'blue' | 'green' })} className={`w-full bg-[#0f172a] border ${isEditing ? 'border-slate-800 focus:border-sky-500' : 'border-transparent text-slate-400'} rounded-xl p-4 font-bold transition-all uppercase text-xs`}>
                                            <option value="blue">Blue (Default)</option>
                                            <option value="green">Green (Personalized)</option>
                                        </select>
                                    </div>
                                    <div className="space-y-4">
                                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block">Stats & Tables Configuration</label>
                                        <div className="space-y-3">
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
                    <form onSubmit={handleChangePassword} className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50 space-y-6">
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
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Employee List */}
                    <div className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50">
                        <h3 className="text-2xl font-black text-white uppercase mb-8">Users</h3>
                        <div className="space-y-4">
                            {employees.map(emp => (
                                <div key={emp.id} className="flex items-center justify-between p-4 bg-slate-950/50 rounded-2xl border border-slate-900">
                                    <div className="flex items-center gap-4">
                                        <div className="w-10 h-10 bg-slate-900 rounded-full flex items-center justify-center text-teal-500">
                                            <i className="fa-solid fa-user-tag"></i>
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-white uppercase">{emp.name}</p>
                                            <p className="text-[10px] text-slate-500 font-mono">Login: {emp.email}</p>
                                        </div>
                                    </div>
                                    <button onClick={() => handleDeleteEmployee(emp.id!)} className="text-slate-600 hover:text-red-500 transition px-4">
                                        <i className="fa-solid fa-trash"></i>
                                    </button>
                                </div>
                            ))}
                            {employees.length === 0 && (
                                <div className="text-center py-8">
                                    <p className="text-slate-500 font-black tracking-widest uppercase text-xs">No users found.</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Add Employee Form */}
                    <div>
                        <form onSubmit={handleAddEmployee} className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                            <h3 className="text-2xl font-black text-white uppercase mb-4">Add New User</h3>
                            {addEmployeeMsg.text && (
                                <div className={`p-4 rounded-xl text-xs font-bold uppercase ${addEmployeeMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                    {addEmployeeMsg.text}
                                </div>
                            )}
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Name</label>
                                <input type="text" value={newEmployeeName} onChange={e => setNewEmployeeName(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold" placeholder="User Name" required />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Login Credential</label>
                                <input type="text" value={newEmployeeEmail} onChange={e => setNewEmployeeEmail(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold" placeholder="Login ID or Email" required />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Password</label>
                                <input type="password" value={newEmployeePassword} onChange={e => setNewEmployeePassword(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold" placeholder="••••••••" required />
                            </div>
                            <button type="submit" className="w-full py-4 bg-teal-500 text-white rounded-xl font-black uppercase hover:bg-teal-400 transition">Create User</button>
                        </form>
                    </div>
                </div>
            )}

            {activeTab === 'team' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* User List */}
                    <div className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50">
                        <h3 className="text-2xl font-black text-orange-500 uppercase mb-8">System Admins</h3>
                        <div className="space-y-4">
                            {users.map(user => (
                                <div key={user.id} className="flex items-center justify-between p-4 bg-slate-950/50 rounded-2xl border border-slate-900">
                                    <div className="flex items-center gap-4">
                                        <div className="w-10 h-10 bg-slate-900 rounded-full flex items-center justify-center text-orange-500">
                                            <i className="fa-solid fa-crown"></i>
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-white uppercase">{user.email}</p>
                                            <p className="text-[10px] text-slate-500 font-mono">Admin ID: {user.id}</p>
                                        </div>
                                    </div>
                                    <button onClick={() => handleDeleteUser(user.id)} className="text-slate-600 hover:text-red-500 transition px-4">
                                        <i className="fa-solid fa-trash"></i>
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Add User Form */}
                    <div>
                        <form onSubmit={handleAddUser} className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50 space-y-6">
                            <h3 className="text-2xl font-black text-white uppercase mb-4">Add New Admin</h3>
                            {addUserMsg.text && (
                                <div className={`p-4 rounded-xl text-xs font-bold uppercase ${addUserMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                    {addUserMsg.text}
                                </div>
                            )}
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Admin Login Email</label>
                                <input type="email" value={newUserEmail} onChange={e => setNewUserEmail(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold" placeholder="admin@amaudiovisuals.com" required />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Password</label>
                                <input type="password" value={newUserPassword} onChange={e => setNewUserPassword(e.target.value)} className="w-full bg-[#0f172a] border border-slate-800 rounded-xl p-4 text-white font-bold" placeholder="••••••••" required />
                            </div>
                            <button type="submit" className="w-full py-4 bg-orange-500 text-white rounded-xl font-black uppercase hover:bg-orange-400 transition">Create Admin</button>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
