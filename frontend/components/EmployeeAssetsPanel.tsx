import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import jsPDFLib from 'jspdf';
import { StaffWorkQueue, staffScope, staffItem, groupStaffAllocations } from '../state/staffAllocations';
import { setWorkBlocker } from '../state/workSafety';
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
const textError = (reason: unknown) => reason instanceof Error ? reason.message : 'Could not complete staff operation.';
const scopeFor = (user: any) => staffScope(location.origin, String(user?.user_id || user?.id || user?.email || ''));
async function getJson(apiFetch: Fetcher, url: string) { const response = await apiFetch(url); if (!response.ok)
    throw Error(`Could not load staff records (${response.status}).`); return response.json(); }
export function StaffPendingNotice({ user, apiFetch, onChanged }: {
    key?: string;
    user: any;
    apiFetch: Fetcher;
    onChanged: () => void;
}) {
    const key = scopeFor(user), queue = useMemo(() => new StaffWorkQueue(key), [key]);
    const [tick, setTick] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
    let pending: any = null, storageError = '';
    try {
        pending = queue.read();
    }
    catch (reason) {
        storageError = textError(reason);
    }
    useEffect(() => { const update = () => { setTick(n => n + 1); setError(''); }; window.addEventListener('storage', update); window.addEventListener('techtrolley-staff-work', update); return () => { window.removeEventListener('storage', update); window.removeEventListener('techtrolley-staff-work', update); }; }, [key]);
    useEffect(() => { setWorkBlocker(key, Boolean(pending || storageError)); return () => setWorkBlocker(key, false); }, [key, tick, Boolean(pending), storageError]);
    const retry = async () => { setBusy(true); setError(''); try {
        await queue.execute(pending.payload.request_id, apiFetch, async () => { const rows = await getJson(apiFetch, '/api/employee-allocations/'); if (!Array.isArray(rows))
            throw Error('Unexpected allocation response.'); onChanged(); });
    }
    catch (reason) {
        setError(textError(reason));
    }
    finally {
        setBusy(false);
        setTick(n => n + 1);
    } };
    if (!pending && !storageError)
        return null;
    return <div role="status" className="fixed bottom-3 left-3 right-3 z-[250] rounded-xl border border-amber-500 bg-slate-900 text-amber-100 p-3 shadow-xl">
  <p>{storageError || `${pending.payload.action} staff operation ${pending.status === 'rejected' ? 'was rejected' : 'is pending confirmation'}.`}</p>
  {pending?.status === 'pending' && <button type="button" disabled={busy} onClick={retry} className="underline mr-4">Retry saved staff operation</button>}
  {pending?.status === 'rejected' && <><p>{pending.error}. Review current records before another attempt.</p><button type="button" disabled={busy} onClick={async () => { try {
        await queue.discardRejected();
        onChanged();
    }
    catch (reason) {
        setError(textError(reason));
    } }} className="underline">Discard rejected staff attempt and review latest records</button></>}
  {error && <p role="alert">{error}</p>}
 </div>;
}
export default function EmployeeAssetsPanel({ apiFetch, user, refreshKey = 0, onChanged }: {
    apiFetch: Fetcher;
    user: any;
    refreshKey?: number;
    onChanged: () => void;
}) {
    const key = scopeFor(user), queue = useMemo(() => new StaffWorkQueue(key), [key]);
    const [rows, setRows] = useState<any[]>([]), [employees, setEmployees] = useState<any[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [message, setMessage] = useState('');
    const [search, setSearch] = useState(''), [laptopsOnly, setLaptopsOnly] = useState(false);
    const [target, setTarget] = useState<any>(null), [action, setAction] = useState<'issue' | 'return'>('issue'), [selected, setSelected] = useState<any>(null), [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
    const [candidates, setCandidates] = useState<any[]>([]), [candidateSearch, setCandidateSearch] = useState(''), [candidatePage, setCandidatePage] = useState(1), [candidateCount, setCandidateCount] = useState(0), [candidateError, setCandidateError] = useState(''), [candidateLoading, setCandidateLoading] = useState(false);
    const [history, setHistory] = useState<any>(null), [historyError, setHistoryError] = useState('');
    const generation = useRef(0), candidateGeneration = useRef(0), historyGeneration = useRef(0), mounted = useRef(true);
    const modalBusy = useRef(busy);
    modalBusy.current = busy;
    useEffect(() => {
        if (!target && !history) return;
        const previous = document.activeElement as HTMLElement | null;
        const node = document.querySelector<HTMLElement>(history ? '[aria-label="Staff issue return history"]' : '[aria-label="Staff equipment operation"]');
        node?.querySelector<HTMLElement>('button')?.focus();
        const keyboard = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !modalBusy.current) {
                event.preventDefault();
                if (history) { historyGeneration.current++; setHistory(null); }
                else { setTarget(null); setSelected(null); setReason(''); }
            }
            if (event.key !== 'Tab') return;
            const controls = Array.from(node?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])') || []) as HTMLElement[];
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        document.addEventListener('keydown', keyboard);
        return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
    }, [Boolean(target), Boolean(history)]);
    const canWrite = ['admin', 'boss', 'godown_incharge'].includes(user?.role) || Boolean(user?.is_staff);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; candidateGeneration.current++; }; }, [key]);
    const load = useCallback(async () => { const id = ++generation.current; setLoading(true); setError(''); try {
        const [r, e] = await Promise.all([getJson(apiFetch, '/api/employee-allocations/'), getJson(apiFetch, '/api/employees/')]);
        if (!Array.isArray(r) || !Array.isArray(e))
            throw Error('Unexpected staff records response.');
        if (!mounted.current || id !== generation.current)
            throw Error('Staff view changed during reload.');
        setRows(r);
        setEmployees(e);
        return;
    }
    catch (err) {
        if (mounted.current && id === generation.current)
            setError(textError(err));
        throw err;
    }
    finally {
        if (mounted.current && id === generation.current)
            setLoading(false);
    } }, [apiFetch, key]);
    useEffect(() => { void load().catch(() => { }); }, [load, refreshKey]);
    useEffect(() => { setTarget(null); setSelected(null); setReason(''); }, [refreshKey]);
    useEffect(() => { setWorkBlocker(`${key}:draft`, Boolean(target && (selected || reason))); return () => setWorkBlocker(`${key}:draft`, false); }, [key, target, selected, reason]);
    useEffect(() => { if (!target || action !== 'issue')
        return; const id = ++candidateGeneration.current; let current = true; setCandidateLoading(true); setCandidateError(''); const timer = setTimeout(() => { getJson(apiFetch, `/api/staff-issue-candidates/?search=${encodeURIComponent(candidateSearch)}&page=${candidatePage}`).then(data => { if (!Array.isArray(data.results) || typeof data.count !== 'number')
        throw Error('Unexpected issue candidate response.'); if (current && id === candidateGeneration.current) {
        setCandidates(data.results);
        setCandidateCount(data.count);
    } }).catch(err => { if (current)
        setCandidateError(textError(err)); }).finally(() => { if (current)
        setCandidateLoading(false); }); }, 180); return () => { current = false; clearTimeout(timer); }; }, [target, action, candidateSearch, candidatePage, apiFetch, refreshKey]);
    const grouped = useMemo(() => groupStaffAllocations(rows, laptopsOnly), [rows, laptopsOnly]);
    const filtered = employees.filter(e => `${e.name} ${e.employee_id}`.toLowerCase().includes(search.toLowerCase()));
    const open = (employee: any, operation: 'issue' | 'return', asset: any = null) => { setTarget(employee); setAction(operation); setSelected(asset); setReason(''); setMessage(''); setCandidateSearch(''); setCandidatePage(1); setCandidates([]); };
    const save = async () => { if (!selected || !reason.trim())
        return; setBusy(true); setMessage(''); try {
        const prepared = await queue.prepare('/api/staff-commands/', { request_id: crypto.randomUUID(), action, employee_id: Number(target.id), items: [staffItem(selected)], reason: reason.trim() });
        await queue.execute(prepared.payload.request_id, apiFetch, load);
        if (mounted.current) {
            setTarget(null);
            setSelected(null);
            setReason('');
            setMessage('Staff operation confirmed.');
            onChanged();
        }
    }
    catch (err) {
        if (mounted.current)
            setMessage(textError(err));
    }
    finally {
        if (mounted.current)
            setBusy(false);
    } };
    const exportRows = () => { const data = filtered.flatMap(e => (grouped[String(e.id)] || []).map(a => ({ 'Employee ID': e.employee_id, 'Employee': e.name, 'Item': a.alias_name || a.sku, 'SKU': a.sku, 'Category': a.type, 'Supplier': a.subrental_company_name || 'Owned stock', 'Issued': a.staff_issue?.issued_at || 'Original issue not recorded', 'Status': a.status }))); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(data), 'Employee Assets'); XLSX.writeFile(book, 'Employee_Assets.xlsx'); };
    const exportPdf = () => { const doc = new jsPDFLib(); doc.setFontSize(16); doc.text('Employee Assets', 15, 18); doc.setFontSize(10); let y = 28; for (const e of filtered) {
        for (const a of grouped[String(e.id)] || []) {
            const lines = doc.splitTextToSize(`${e.name} (${e.employee_id}) - ${a.alias_name || a.sku} [${a.sku}] - ${a.type} - ${a.subrental_company_name || 'Owned stock'} - Issued: ${a.staff_issue?.issued_at || 'Original issue not recorded'}`, 175);
            for (const line of lines) {
                if (y > 278) {
                    doc.addPage();
                    y = 18;
                }
                doc.text(line, 15, y);
                y += 5;
            }
            y += 3;
        }
    } doc.save('Employee_Assets.pdf'); };
    const showHistory = async (asset: any) => { const id = ++historyGeneration.current; setHistory({ asset, records: null }); setHistoryError(''); try {
        const data = await getJson(apiFetch, `/api/employee-allocations/${asset.id}/history/`);
        if (mounted.current && id === historyGeneration.current)
            setHistory({ asset, ...data });
    }
    catch (err) {
        if (mounted.current && id === historyGeneration.current)
            setHistoryError(textError(err));
    } };
    return <section className="bg-slate-900/30 rounded-2xl p-5 text-slate-100 space-y-4">
  <h3 className="text-xl font-bold">Employee Assets</h3>
  <p>Issued equipment across all inventory categories and ownership sources.</p>
  <div className="flex flex-wrap gap-3"><input aria-label="Search employee allocations" value={search} onChange={e => setSearch(e.target.value)} placeholder="Employee name or ID" className="form-input-night"/><label><input type="checkbox" checked={laptopsOnly} onChange={e => setLaptopsOnly(e.target.checked)}/> Laptops category only</label><button type="button" onClick={() => void load().catch(() => { })}>Reload allocations</button><button type="button" disabled={loading || Boolean(error)} onClick={exportRows}>Export employee assets</button><button type="button" disabled={loading || Boolean(error)} onClick={exportPdf}>Export employee assets PDF</button></div>
  {loading && <p role="status">Loading staff allocations…</p>}{error && <p role="alert">{error} Allocation data may be out of date.</p>}{message && <p role="status">{message}</p>}
  {!loading && !error && rows.length === 0 && <p>No active staff allocations are recorded.</p>}
  {!loading && !error && filtered.length === 0 && <p>No employees match this search.</p>}
  {!error && filtered.map(e => <div key={e.id} className="border border-slate-700 rounded-xl p-4" data-employee-id={e.id}><h4 className="font-bold">{e.name} · {e.employee_id}</h4>{canWrite && <button type="button" onClick={() => open(e, 'issue')}>Issue equipment to {e.name}</button>}
   {(grouped[String(e.id)] || []).length === 0 && <p>{laptopsOnly ? 'No issued items in the Laptops category.' : 'No issued equipment for this employee.'}</p>}
   {(grouped[String(e.id)] || []).map(a => <div key={a.id} className="mt-3 p-3 bg-slate-950 rounded-lg" data-issued-asset-id={a.id}><p>{a.alias_name || a.sku} · {a.type} · {a.subrental_company_name || 'Owned stock'}</p><p>Issued: {a.staff_issue?.issued_at ? new Date(a.staff_issue.issued_at).toLocaleString() : 'Original issue date not recorded'} · {a.status}</p>{a.staff_issue?.history_matches_current_custodian === false && <p role="alert">History differs from current custodian; requires review.</p>}<button type="button" onClick={() => showHistory(a)}>History of {a.alias_name || a.sku}</button>{canWrite && <button type="button" onClick={() => open(e, 'return', a)} disabled={a.staff_issue?.history_matches_current_custodian === false} className="ml-4">Record return of {a.alias_name || a.sku}</button>}</div>)}
  </div>)}
  {target && <div role="dialog" aria-modal="true" aria-label="Staff equipment operation" className="fixed inset-0 z-[180] bg-black/80 flex items-center justify-center p-4"><div className="bg-slate-900 rounded-xl p-5 w-full max-w-xl max-h-[90vh] overflow-auto space-y-3"><h3>{action === 'issue' ? 'Issue equipment' : 'Record equipment return'} · {target.name}</h3><button type="button" disabled={busy} onClick={() => { setTarget(null); setSelected(null); setReason(''); }}>Close staff operation</button>
   {action === 'issue' && <><input aria-label="Search staff issue candidates" value={candidateSearch} onChange={e => { setCandidateSearch(e.target.value); setCandidatePage(1); setSelected(null); }} className="form-input-night" placeholder="SKU, name, serial or barcode"/>{candidateLoading && <p>Loading available equipment…</p>}{candidateError && <p role="alert">{candidateError}</p>}{!candidateLoading && !candidateError && candidates.length === 0 && <p>No eligible equipment matches.</p>}{!candidateLoading && !candidateError && candidates.map(a => <button key={a.id} type="button" onClick={() => setSelected(a)} className="block p-2 border border-slate-700 w-full">Select {a.alias_name || a.sku} · {a.type} · {a.subrental_company_name || 'Owned stock'}</button>)}<button type="button" disabled={candidatePage === 1 || candidateLoading} onClick={() => setCandidatePage(n => n - 1)}>Previous candidates</button><button type="button" disabled={candidatePage * 25 >= candidateCount || candidateLoading} onClick={() => setCandidatePage(n => n + 1)}>Next candidates</button></>}
   {selected && <p>Selected: {selected.alias_name || selected.sku}</p>}<label>Reason for staff operation<textarea aria-label="Reason for staff operation" value={reason} onChange={e => setReason(e.target.value)} className="form-input-night"/></label>{action === 'return' && <p>Confirm the equipment was physically returned. Restrictions and any event holding remain protected.</p>}<button type="button" disabled={busy || !selected || !reason.trim()} onClick={save}>{busy ? 'Saving staff operation…' : 'Confirm staff operation'}</button>
  </div></div>}
  {history && <div role="dialog" aria-modal="true" aria-label="Staff issue return history" className="fixed inset-0 z-[180] bg-black/80 p-5 overflow-auto"><div className="bg-slate-900 p-5 rounded-xl max-w-3xl mx-auto"><h3>{history.asset.alias_name || history.asset.sku} — issue/return history</h3><button type="button" onClick={() => { historyGeneration.current++; setHistory(null); }}>Close staff history</button>{historyError && <p role="alert">{historyError}</p>}{history.records === null && !historyError && <p>Loading history…</p>}{history.legacy_assignment_without_issue_record && <p>Current assignment predates recorded issue history.</p>}{history.records?.map((r: any) => <div key={r.id} className="border border-slate-700 p-3 mt-3"><p>Employee: {r.issue_snapshot.employee_name || r.return_snapshot.employee_name || r.employee_id}</p><p>Issued: {r.issued_at || 'Original issue not recorded'} · Operator: {r.issued_by ?? 'Unknown'}</p><p>{r.issue_reason}</p><p>Returned: {r.returned_at || 'Still issued'} · Operator: {r.returned_by ?? '—'}</p><p>{r.return_reason}</p></div>)}</div></div>}
  {(['admin', 'boss'].includes(user?.role) || user?.is_staff) && <EmployeeLinkPanel apiFetch={apiFetch} queue={queue} refresh={load} onChanged={onChanged} refreshKey={refreshKey}/>}
 </section>;
}
function EmployeeLinkPanel({ apiFetch, queue, refresh, onChanged, refreshKey }: {
    apiFetch: Fetcher;
    queue: StaffWorkQueue;
    refresh: () => Promise<void>;
    onChanged: () => void;
    refreshKey: number;
}) {
    const [context, setContext] = useState<any>(null), [error, setError] = useState(''), [selectedUser, setSelectedUser] = useState(''), [employeeId, setEmployeeId] = useState(''), [name, setName] = useState(''), [code, setCode] = useState(''), [department, setDepartment] = useState('Operations'), [phone, setPhone] = useState('-'), [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
    const reload = useCallback(async () => { setError(''); const data = await getJson(apiFetch, '/api/employee-link-context/'); setContext(data); }, [apiFetch]);
    useEffect(() => { let current = true; getJson(apiFetch, '/api/employee-link-context/').then(data => { if (current)
        setContext(data); }).catch(err => { if (current)
        setError(textError(err)); }); return () => { current = false; }; }, [apiFetch, refreshKey]);
    useEffect(() => { setWorkBlocker(`${queue.key}:link-draft`, Boolean(selectedUser && (name || code || employeeId || reason))); return () => setWorkBlocker(`${queue.key}:link-draft`, false); }, [queue.key, selectedUser, name, code, employeeId, reason]);
    const save = async () => { setBusy(true); setError(''); try {
        const employee = context.employees.find((e: any) => String(e.id) === employeeId);
        const payload: any = { request_id: crypto.randomUUID(), action: employeeId ? 'link' : 'create_link', user_id: Number(selectedUser), reason: reason.trim() };
        if (employee)
            Object.assign(payload, { employee_id: Number(employee.id), expected_revision: employee.identity_revision, expected_user_id: employee.user });
        else
            payload.profile = { name, employee_id: code, department, phone };
        const prepared = await queue.prepare('/api/employee-link-commands/', payload);
        await queue.execute(prepared.payload.request_id, apiFetch, async () => { await reload(); await refresh(); });
        setSelectedUser('');
        setEmployeeId('');
        setReason('');
        setName('');
        setCode('');
        onChanged();
    }
    catch (err) {
        setError(textError(err));
    }
    finally {
        setBusy(false);
    } };
    return <div className="border-t border-slate-700 pt-4 space-y-3"><h4 className="font-bold">Link login to employee</h4><p>Choose the real employee explicitly. Linking does not change login privileges.</p>{error && <p role="alert">{error}</p>}{!context && !error && <p>Loading identity records…</p>}{context && <><label>Login account<select aria-label="Login account to link" value={selectedUser} onChange={e => { setSelectedUser(e.target.value); setEmployeeId(''); }} className="form-input-night"><option value="">Choose an unlinked account</option>{context.users.filter((u: any) => u.active && !u.employee_id).map((u: any) => <option key={u.id} value={u.id}>{u.name} · {u.email} · Account #{u.id}</option>)}</select></label><label>Employee profile<select aria-label="Employee profile to link" value={employeeId} onChange={e => setEmployeeId(e.target.value)} className="form-input-night"><option value="">Create a reviewed employee profile</option>{context.employees.filter((e: any) => !e.user).map((e: any) => <option key={e.id} value={e.id}>{e.name} · {e.employee_id}</option>)}</select></label>{!employeeId && <><input aria-label="Linked employee name" value={name} onChange={e => setName(e.target.value)} placeholder="Employee name" className="form-input-night"/><input aria-label="Linked employee business ID" value={code} onChange={e => setCode(e.target.value)} placeholder="Stable employee ID" className="form-input-night"/><input aria-label="Linked employee department" value={department} onChange={e => setDepartment(e.target.value)} className="form-input-night"/><input aria-label="Linked employee phone" value={phone} onChange={e => setPhone(e.target.value)} className="form-input-night"/></>}<input aria-label="Reason for employee link" value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for verified link" className="form-input-night"/><button type="button" disabled={busy || !selectedUser || !reason.trim() || !employeeId && (!name.trim() || !code.trim())} onClick={save}>Confirm employee link</button></>}</div>;
}
