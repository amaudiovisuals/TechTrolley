import React, { useState } from 'react';
import { Logo } from './components/Logo';

interface LoginProps {
    onLogin: (token: string, user: any) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
    const API_BASE = '';
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const response = await fetch(`${API_BASE}/api/login/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });

            const data = await response.json();

            if (response.ok) {
                onLogin(data.token, { email: data.email, userId: data.user_id });
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
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-8">
            <div className="w-full max-w-md space-y-12">
                <div className="text-center space-y-4 flex flex-col items-center">
                    <Logo size="lg" />
                </div>

                <form onSubmit={handleSubmit} className="bg-slate-900/30 backdrop-blur-xl p-10 rounded-[2.5rem] border border-slate-800/50 shadow-2xl space-y-6">
                    {error && (
                        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl text-xs font-bold uppercase text-center">
                            {error}
                        </div>
                    )}

                    <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Office Email ID</label>
                        <div className="relative">
                            <i className="fa-solid fa-envelope absolute left-5 top-1/2 -translate-y-1/2 text-slate-500"></i>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-slate-950/50 border border-slate-800 rounded-2xl py-4 pl-12 pr-6 text-white font-bold placeholder-slate-600 focus:border-sky-500 focus:outline-none transition-colors"
                                placeholder="user@company.com"
                                required
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Password code</label>
                        <div className="relative">
                            <i className="fa-solid fa-lock absolute left-5 top-1/2 -translate-y-1/2 text-slate-500"></i>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-slate-950/50 border border-slate-800 rounded-2xl py-4 pl-12 pr-6 text-white font-bold placeholder-slate-600 focus:border-sky-500 focus:outline-none transition-colors"
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
