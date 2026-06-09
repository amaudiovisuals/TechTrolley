import React, { useState, useEffect } from 'react';
import { Logo } from './components/Logo';
import { CompanySettings } from './types';

interface LoginProps {
    onLogin: (token: string, user: any) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
    const API_BASE = '';
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/company-settings/`);
                if (res.ok) {
                    const data = await res.json();
                    setCompanySettings(data);
                }
            } catch (e) {
                console.error('Failed to fetch company settings:', e);
            }
        };
        fetchSettings();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const response = await fetch(`${API_BASE}/api/login/`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ username: email, password }),
            });

            const data = await response.json();

            if (response.ok) {
                onLogin(data.token, {
                    email: data.email,
                    username: data.username,
                    userId: data.user_id,
                    is_staff: data.is_staff,
                    employee_id: data.employee_id,
                    role: data.role
                });
            } else {
                setError(data.error || 'Login failed');
            }
        } catch (err) {
            setError('Connection refused. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 sm:p-8">
            <div className="w-full max-w-md space-y-8 sm:space-y-12">
                <div className="text-center space-y-4 flex flex-col items-center">
                    <Logo size="lg" companySettings={companySettings} showText={true} variant="login" />
                </div>

                <form onSubmit={handleSubmit} className="bg-slate-900/30 backdrop-blur-xl p-6 sm:p-10 rounded-[2.5rem] border border-slate-800/50 shadow-2xl space-y-6">
                    {error && (
                        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl text-xs font-bold uppercase text-center">
                            {error}
                        </div>
                    )}

                    <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block truncate">Office Email ID</label>
                        <div className="flex items-center w-full bg-slate-950/50 border border-slate-800 rounded-2xl focus-within:border-sky-500 transition-colors overflow-hidden">
                            <div className="pl-5 pr-3 text-slate-500 flex-shrink-0 flex items-center justify-center">
                                <i className="fa-solid fa-envelope"></i>
                            </div>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-transparent py-4 pr-6 text-white font-bold placeholder-slate-600 focus:outline-none"
                                placeholder="user@company.com"
                                required
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block truncate">Password code</label>
                        <div className="flex items-center w-full bg-slate-950/50 border border-slate-800 rounded-2xl focus-within:border-sky-500 transition-colors overflow-hidden">
                            <div className="pl-5 pr-3 text-slate-500 flex-shrink-0 flex items-center justify-center">
                                <i className="fa-solid fa-lock"></i>
                            </div>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-transparent py-4 pr-6 text-white font-bold placeholder-slate-600 focus:outline-none"
                                placeholder="••••••••"
                                required
                            />
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-5 bg-sky-500 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-sky-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-sky-500/20 mt-4"
                    >
                        {loading ? 'Authenticating...' : 'Secure Login'}
                    </button>
                </form>
                <p className="text-center text-[10px] text-slate-600 font-mono">SYSTEM V.2.0 • TERMINAL ACTIVE</p>
            </div>
        </div>
    );
};

export default Login;
