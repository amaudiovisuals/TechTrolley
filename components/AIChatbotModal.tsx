import React, { useState, useRef, useEffect } from 'react';

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

interface AIChatbotModalProps {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  user: any;
}

const QUICK_PROMPTS = [
  "Inventory overview & asset health",
  "Which conferences are ongoing right now?",
  "What equipment is currently in use at venues?",
  "Check damaged or on-service gear"
];

export const AIChatbotModal: React.FC<AIChatbotModalProps> = ({ apiFetch, user }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputQuery, setInputQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: `Hello ${user?.name || (user?.role === 'boss' ? 'Boss' : 'Admin')}! I am **AM Orbit AI**, your real-time inventory and event logistics assistant. Ask me anything about current asset stock, ongoing conferences, or equipment allocations.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen, messages, isLoading]);

  const handleSend = async (textToSend?: string) => {
    const query = (textToSend || inputQuery).trim();
    if (!query || isLoading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: 'user',
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMessage]);
    setInputQuery('');
    setIsLoading(true);

    try {
      const res = await apiFetch('/api/ai-assistant/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: query })
      });

      if (res.ok) {
        const data = await res.json();
        const assistantMessage: ChatMessage = {
          id: `ai-${Date.now()}`,
          sender: 'assistant',
          text: data.reply || "No response received from assistant.",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => [...prev, assistantMessage]);
      } else {
        const err = await res.json().catch(() => ({}));
        setMessages(prev => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            sender: 'assistant',
            text: `⚠️ **Unable to connect**: ${err.error || "The AI service is temporarily unavailable."}`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }
        ]);
      }
    } catch {
      setMessages(prev => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          sender: 'assistant',
          text: "⚠️ **Network Error**: Unable to reach the server. Please check your connection.",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  // Restrict component strictly to Admin and Boss accounts
  const isAuthorized = user?.is_staff || user?.role === 'boss' || user?.role === 'admin';
  if (!isAuthorized) return null;

  return (
    <>
      {/* Floating Executive AI Trigger Button */}
      <div className="fixed bottom-6 right-6 z-40">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`relative group flex items-center gap-3 px-4 py-3.5 rounded-full shadow-2xl transition-all duration-300 active:scale-95 ${
            isOpen
              ? 'bg-slate-900 text-white border border-slate-700'
              : 'bg-gradient-to-r from-sky-500 via-indigo-600 to-sky-500 bg-[length:200%_auto] hover:bg-right text-white shadow-sky-500/30 hover:shadow-sky-500/50'
          }`}
          title="Open AI Assistant"
        >
          <div className="relative">
            <i className={`fa-solid ${isOpen ? 'fa-xmark text-lg' : 'fa-wand-magic-sparkles text-base'} transition-transform group-hover:scale-110`} />
            {!isOpen && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-400 rounded-full ring-2 ring-slate-950 animate-pulse" />
            )}
          </div>
          <span className="text-xs font-black uppercase tracking-wider hidden sm:inline-block">
            {isOpen ? 'Close AI' : 'Orbit AI'}
          </span>
          {user?.role === 'boss' && !isOpen && (
            <span className="w-5 h-5 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center text-[10px] font-black shadow-sm">
              <i className="fa-solid fa-crown text-[8px]" />
            </span>
          )}
        </button>
      </div>

      {/* Floating Chat Drawer / Window */}
      {isOpen && (
        <div className="fixed bottom-24 right-4 sm:right-6 z-50 w-[92vw] sm:w-[440px] max-h-[80vh] h-[620px] bg-slate-950/95 backdrop-blur-2xl border border-slate-800 rounded-[2rem] shadow-[0_20px_60px_rgba(0,0,0,0.7)] flex flex-col overflow-hidden animate-in slide-in-from-bottom-6 fade-in duration-300">
          {/* Header */}
          <div className="p-4 sm:p-5 border-b border-slate-800/80 bg-slate-900/60 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-sky-500/20">
                <i className="fa-solid fa-brain text-sm" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-black text-white uppercase tracking-wider">AM Orbit AI</h3>
                  <span className="px-2 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/30 text-[9px] font-black text-sky-400 uppercase tracking-widest">
                    Executive
                  </span>
                </div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">
                  Live Operations Intelligence
                </p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="w-8 h-8 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition"
              title="Close chat"
            >
              <i className="fa-solid fa-xmark text-sm" />
            </button>
          </div>

          {/* Privacy & Security Badge */}
          <div className="px-4 py-2 bg-emerald-500/5 border-b border-emerald-500/10 flex items-center justify-between text-[8px] font-bold uppercase tracking-widest text-emerald-400/90">
            <span className="flex items-center gap-1.5">
              <i className="fa-solid fa-shield-halved text-[9px]" /> Strict Privacy • Zero Model Training
            </span>
            <span className="text-slate-500 font-mono">TLS 1.3</span>
          </div>

          {/* Messages Scroll Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs leading-relaxed ${
                    m.sender === 'user'
                      ? 'bg-gradient-to-r from-sky-500 to-indigo-600 text-white rounded-br-none shadow-md shadow-sky-500/10'
                      : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none shadow-sm'
                  }`}
                >
                  <div className="space-y-2 whitespace-pre-wrap">
                    {m.text}
                  </div>
                </div>
                <span className="text-[8px] font-bold text-slate-500 mt-1 px-1">
                  {m.timestamp}
                </span>
              </div>
            ))}

            {isLoading && (
              <div className="flex flex-col items-start">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl rounded-bl-none px-4 py-3 flex items-center gap-2 text-xs text-slate-400">
                  <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                  <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse delay-150" />
                  <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse delay-300" />
                  <span className="ml-1 text-[10px] font-black uppercase tracking-wider text-slate-500">Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompts Carousel */}
          <div className="px-4 py-2 border-t border-slate-900 bg-slate-950 flex items-center gap-2 overflow-x-auto no-scrollbar">
            {QUICK_PROMPTS.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => handleSend(p)}
                disabled={isLoading}
                className="shrink-0 px-3 py-1.5 rounded-full bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[10px] font-bold text-slate-300 hover:text-white transition whitespace-nowrap active:scale-95 disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>

          {/* Input Box */}
          <div className="p-3 sm:p-4 border-t border-slate-800/80 bg-slate-900/40">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="relative flex items-center"
            >
              <input
                ref={inputRef}
                type="text"
                value={inputQuery}
                onChange={(e) => setInputQuery(e.target.value)}
                placeholder="Ask about inventory, gear, venues..."
                disabled={isLoading}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-4 pr-12 py-3.5 text-xs text-white placeholder-slate-500 font-bold focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 outline-none transition"
              />
              <button
                type="submit"
                disabled={!inputQuery.trim() || isLoading}
                className="absolute right-2 w-8 h-8 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 text-white disabled:text-slate-600 flex items-center justify-center transition active:scale-95 shadow-sm"
                title="Send query"
              >
                <i className="fa-solid fa-arrow-up text-xs" />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
