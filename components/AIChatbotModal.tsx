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
  "How many Dynatech we have in total and where are they?",
  "Inventory overview & asset health",
  "Which conferences are ongoing right now?",
  "How many Bose speakers do we have?",
  "Check damaged or on-service gear"
];

// High-contrast markdown parser to prevent light/transparent text
const renderFormattedMessage = (text: string) => {
  const lines = text.split('\n');

  return (
    <div className="space-y-1.5 leading-relaxed text-[13px]" style={{ color: '#0f172a' }}>
      {lines.map((line, lineIdx) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={lineIdx} className="h-1" />;
        }

        // Parse inline bold (**...**) and italic (*...*)
        const renderInline = (str: string) => {
          const parts = str.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
          return parts.map((part, i) => {
            if (part.startsWith('**') && part.endsWith('**')) {
              return (
                <strong
                  key={i}
                  className="font-extrabold"
                  style={{ color: '#020617' }}
                >
                  {part.slice(2, -2)}
                </strong>
              );
            }
            if (part.startsWith('*') && part.endsWith('*')) {
              return (
                <em
                  key={i}
                  className="italic font-medium"
                  style={{ color: '#334155' }}
                >
                  {part.slice(1, -1)}
                </em>
              );
            }
            if (part.startsWith('`') && part.endsWith('`')) {
              return (
                <code
                  key={i}
                  className="px-1.5 py-0.5 rounded bg-slate-200/80 font-mono text-[11px] font-bold"
                  style={{ color: '#0f172a' }}
                >
                  {part.slice(1, -1)}
                </code>
              );
            }
            return <span key={i} style={{ color: '#0f172a' }}>{part}</span>;
          });
        };

        // Bullet point line
        if (trimmed.startsWith('•') || trimmed.startsWith('-')) {
          const content = trimmed.replace(/^[•\-]\s*/, '');
          return (
            <div key={lineIdx} className="flex items-start gap-2 pl-1 py-0.5">
              <span className="text-sky-600 font-black select-none text-xs leading-none mt-1">•</span>
              <div className="flex-1 font-semibold" style={{ color: '#0f172a' }}>
                {renderInline(content)}
              </div>
            </div>
          );
        }

        // Section header (starts with ### or has emoji like 📊, 📍, 📦, 📅, ⚠️, 🟢)
        if (trimmed.startsWith('###') || /^[📊📍📦📅⚠️🟢🟡🔴🎪💡•]/.test(trimmed)) {
          return (
            <div
              key={lineIdx}
              className="pt-2 pb-0.5 font-extrabold text-sm tracking-tight border-b border-slate-200/60"
              style={{ color: '#020617' }}
            >
              {renderInline(trimmed.replace(/^###\s*/, ''))}
            </div>
          );
        }

        return (
          <p key={lineIdx} className="font-semibold" style={{ color: '#0f172a' }}>
            {renderInline(trimmed)}
          </p>
        );
      })}
    </div>
  );
};

export const AIChatbotModal: React.FC<AIChatbotModalProps> = ({ apiFetch, user }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputQuery, setInputQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: `Hello ${user?.name || (user?.role === 'boss' ? 'Boss' : 'Admin')}! I am **AM Orbit AI**, your operations intelligence assistant.\n\nAsk me about equipment locations, quantities, active conferences, or damaged gear (e.g. *"How many Dynatech do we have and where are they?"*).`,
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
              ? 'bg-slate-900 text-white border border-slate-700 shadow-slate-900/40'
              : 'bg-gradient-to-r from-sky-500 via-indigo-600 to-sky-500 bg-[length:200%_auto] hover:bg-right text-white shadow-sky-500/40 hover:shadow-sky-500/60'
          }`}
          title="Open AI Assistant"
        >
          <div className="relative">
            <i className={`fa-solid ${isOpen ? 'fa-xmark text-lg' : 'fa-wand-magic-sparkles text-base'} transition-transform group-hover:scale-110`} />
            {!isOpen && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-400 rounded-full ring-2 ring-white animate-pulse" />
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
        <div
          className="fixed bottom-24 right-4 sm:right-6 z-50 w-[94vw] sm:w-[460px] max-h-[82vh] h-[640px] bg-white border border-slate-200 rounded-[2rem] shadow-[0_25px_70px_rgba(15,23,42,0.25)] flex flex-col overflow-hidden animate-in slide-in-from-bottom-6 fade-in duration-300"
          style={{ backgroundColor: '#ffffff' }}
        >
          {/* Header */}
          <div className="p-4 sm:p-5 border-b border-slate-200 bg-gradient-to-r from-slate-50 via-sky-50/40 to-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-sky-500/20">
                <i className="fa-solid fa-brain text-sm" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-black uppercase tracking-wider" style={{ color: '#0f172a' }}>
                    AM Orbit AI
                  </h3>
                  <span className="px-2 py-0.5 rounded-full bg-sky-100 border border-sky-200 text-[9px] font-black text-sky-700 uppercase tracking-widest">
                    Executive
                  </span>
                  {user?.role === 'boss' && (
                    <span className="px-1.5 py-0.5 rounded-md bg-amber-100 border border-amber-300 text-[9px] font-black text-amber-800 flex items-center gap-1">
                      <i className="fa-solid fa-crown text-[7px]" /> BOSS
                    </span>
                  )}
                </div>
                <p className="text-[10px] font-extrabold uppercase tracking-widest mt-0.5" style={{ color: '#64748b' }}>
                  Live Operations Intelligence
                </p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="w-8 h-8 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 flex items-center justify-center transition active:scale-95"
              title="Close chat"
            >
              <i className="fa-solid fa-xmark text-sm" />
            </button>
          </div>

          {/* Privacy & Security Badge */}
          <div className="px-4 py-2 bg-emerald-50/80 border-b border-emerald-100 flex items-center justify-between text-[9px] font-black uppercase tracking-widest text-emerald-800">
            <span className="flex items-center gap-1.5">
              <i className="fa-solid fa-shield-halved text-[10px] text-emerald-600" /> Strict Privacy • Zero Data Training
            </span>
            <span className="text-slate-500 font-mono text-[8px] bg-white px-1.5 py-0.5 rounded border border-emerald-200">
              TLS 1.3
            </span>
          </div>

          {/* Messages Scroll Area */}
          <div
            className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar"
            style={{ backgroundColor: '#f8fafc' }}
          >
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[88%] rounded-2xl px-4 py-3.5 shadow-sm ${
                    m.sender === 'user'
                      ? 'bg-gradient-to-r from-sky-500 to-indigo-600 text-white rounded-br-none font-bold shadow-sky-500/20'
                      : 'bg-white border border-slate-200/90 rounded-bl-none'
                  }`}
                  style={m.sender === 'assistant' ? { backgroundColor: '#ffffff', color: '#0f172a' } : undefined}
                >
                  {m.sender === 'assistant' ? (
                    renderFormattedMessage(m.text)
                  ) : (
                    <div className="whitespace-pre-wrap text-xs leading-relaxed text-white font-bold">
                      {m.text}
                    </div>
                  )}
                </div>
                <span className="text-[9px] font-bold mt-1 px-1" style={{ color: '#94a3b8' }}>
                  {m.timestamp}
                </span>
              </div>
            ))}

            {isLoading && (
              <div className="flex flex-col items-start">
                <div
                  className="bg-white border border-slate-200 rounded-2xl rounded-bl-none px-4 py-3 flex items-center gap-2.5 shadow-xs"
                  style={{ backgroundColor: '#ffffff' }}
                >
                  <span className="w-2 h-2 rounded-full bg-sky-500 animate-pulse" />
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse delay-150" />
                  <span className="w-2 h-2 rounded-full bg-sky-500 animate-pulse delay-300" />
                  <span className="ml-1 text-[11px] font-black uppercase tracking-wider" style={{ color: '#475569' }}>
                    Scanning Live Inventory...
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompts Carousel */}
          <div
            className="px-3 py-2 border-t border-slate-200 flex items-center gap-2 overflow-x-auto no-scrollbar"
            style={{ backgroundColor: '#ffffff' }}
          >
            {QUICK_PROMPTS.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => handleSend(p)}
                disabled={isLoading}
                className="shrink-0 px-3 py-1.5 rounded-full bg-slate-50 hover:bg-sky-50 border border-slate-200 hover:border-sky-300 text-[11px] font-bold text-slate-700 hover:text-sky-800 transition whitespace-nowrap active:scale-95 disabled:opacity-50 shadow-xs"
                style={{ color: '#334155' }}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Input Box */}
          <div
            className="p-3 sm:p-4 border-t border-slate-200"
            style={{ backgroundColor: '#f8fafc' }}
          >
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
                placeholder="Ask about gear, counts, venues (e.g. 'how many dynatech')..."
                disabled={isLoading}
                className="w-full bg-white border border-slate-300 rounded-2xl pl-4 pr-12 py-3.5 text-xs font-bold placeholder-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 outline-none transition shadow-xs"
                style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
              />
              <button
                type="submit"
                disabled={!inputQuery.trim() || isLoading}
                className="absolute right-2 w-8 h-8 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:opacity-95 disabled:bg-slate-200 text-white disabled:text-slate-400 flex items-center justify-center transition active:scale-95 shadow-sm shadow-sky-500/20"
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
