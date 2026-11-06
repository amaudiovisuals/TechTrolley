import { SavedContacts } from './components/SavedContacts';
import { LedCasePicker } from './components/LedCasePicker';
import { LedCaseRecord } from './components/LedCaseRecord';
import { SavedWorkRecovery } from './components/SavedWorkRecovery';
import OfflineScanning from './components/OfflineScanning';
import { downloadEventPdf } from './state/privateDownloads';
import { eventEditorData, eventMetadata, eventDraftKey, readEventDraft } from './state/eventDrafts';
import { resolveScan } from './state/scanIdentity';
import { challanAssetIds } from './state/challanSelection';
import { MovementOutbox, RejectedMovement } from './state/movementOutbox';
import { isBulkStock, quantityLimit, dispatchQuantities, quantityLabel, eventQuantityTotal, canVerifyReturns } from './state/quantityWorkflow';
import { consumableDraftHash, consumablePayload, consumableLimit, editConsumableRequest, editConsumableReturn } from './state/consumableWorkflow';
import { hasRecordedQuantities, masterQuantityPreview } from './state/challanDocuments';
import { manifestCommand } from './state/truckManifests';
import CustodyReview, { CustodyReviewData } from './components/CustodyReview';
import { StaffPendingNotice } from './components/EmployeeAssetsPanel';
import EventLifecycle from './components/EventLifecycle';
import ReconciliationReview from './components/ReconciliationReview';
import InventoryOwnershipSummary from './components/InventoryOwnershipSummary';
import SupplierBalancePanel from './components/SupplierBalancePanel';
import SupplierSaveNotice, { useSupplierSaving } from './components/SupplierSaveNotice';
import { eventLifecycleLabel, matchesLifecycleFilter } from './state/eventLifecycle';
import { mapConference, stockQuantity } from './state/conferences';
import { acceptRevision } from './state/challanDrafts';
import { hasPendingWork, retireLegacyApiCache, setWorkBlocker } from './state/workSafety';
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Asset,
  AssetStatus,
  Booking,
  Client,
  AssetCategory,
  UICategory,
  CATEGORY_MAP,
  ConferenceType,
  DeliveryChallanRecord,
  Employee,
  CompanySettings,
  AssetFlag,
  SubrentalCompany,
  SubrentalTicket,
  SubrentalTicketItem,
  TruckChallan
} from './types';
import QRCode from 'qrcode';
import * as XLSX from 'xlsx';

const GLOBAL_CONSUMABLES_SKU = 'GLOBAL-CONSUMABLES';

function getSkuFamily(sku: string): string {
  if (!sku) return 'Unknown';
  const stripped = sku.replace(/-\d+$/, '').replace(/_\d+$/, '');
  return stripped.replace(/_/g, ' ').trim();
}

const normalizeSearch = (s: string) => (s || '').replace(/[-_\s]/g, '').toLowerCase();

const EXCLUDED_LAPTOP_KEYWORDS = [
  'connector', 'modem', 'monitor', 'mouse', 'server', 'printer', 'ups', 
  'router', 'hub', 'cable', 'splitter', 'switcher', 'switch', 'adapter', 'talkback', 
  'handycam', 'projector', 'speaker', 'mixer', 'camera', 'scanner', 'screen',
  'tv', 'display', 'led wall', 'sound card', 'capture card', 'mic', 'microphone'
];

const WINDOWS_LAPTOP_BRANDS = [
  'hp', 'dell', 'asus', 'acer', 'lenovo', 'thinkpad', 'msi', 'samsung', 'intel', 'amd', 'ryzen', 'windows'
];

/**
 * Returns a display-level sub-group label for laptop assets ('MacBook' or 'Windows Laptop').
 * Also optionally appends the original sub-identifier in parentheses e.g. 'MacBook (M-17)'.
 * Returns null for non-laptop assets — leaves them completely unchanged.
 */
function getLaptopSubGroup(
  arg1?: Asset | string | null,
  type?: string,
  sku?: string,
  description?: string,
  includeSubId: boolean = false
): string | null {
  let an = '';
  let t = '';
  let s = '';
  let d = '';

  if (typeof arg1 === 'string') {
    an = arg1.trim();
    t = (type || '').trim();
    s = (sku || '').trim();
    d = (description || '').trim();
  } else if (arg1 && typeof arg1 === 'object') {
    an = (arg1.aliasName || (arg1 as any).alias_name || '').trim();
    t = (arg1.type || '').trim();
    s = (arg1.sku || '').trim();
    d = (arg1.description || '').trim();
  }

  const combined = `${an} ${s} ${d}`.toLowerCase();

  // 1. Exclusion Check: if it contains any non-laptop keyword, it is NOT a laptop!
  if (EXCLUDED_LAPTOP_KEYWORDS.some(k => combined.includes(k))) {
    return null;
  }

  // 2. Inclusion Check: is it a laptop?
  const itTypes = ['laptops', 'it & networking', 'computers & servers'];
  const explicitAliases = ['apple macbook', 'windows laptop', 'macbook'];
  const laptopKeywords = ['laptop', 'macbook', 'vivobook', 'thinkpad', 'ideapad', 'pavilion', 'inspiron', 'latitude', 'precision', 'zenbook', 'tuf_fx', 'omen', 'helios', 'victus'];

  const isLaptopType = itTypes.includes(t.toLowerCase());
  const isExplicit = explicitAliases.includes(an.toLowerCase());
  const isLaptopName = laptopKeywords.some(k => combined.includes(k));

  let isLaptop = isExplicit || isLaptopName;
  if (!isLaptop && isLaptopType) {
    const anUpper = an.toUpperCase();
    if (anUpper.startsWith('M-') || anUpper.startsWith('AM-') || anUpper.startsWith('M') || anUpper.startsWith('AM') || /^\d+$/.test(an)) {
      isLaptop = true;
    }
  }

  if (!isLaptop) return null;

  // 3. Classify MacBook vs Windows Laptop
  let isMac = false;
  if (WINDOWS_LAPTOP_BRANDS.some(b => combined.includes(b))) {
    isMac = false;
  } else if (combined.includes('macbook') || combined.includes('apple') || combined.includes('imac')) {
    isMac = true;
  } else {
    const checkStr = (an || s).toUpperCase();
    if (checkStr.startsWith('M-') || checkStr.startsWith('M1') || checkStr.startsWith('M2') || checkStr.startsWith('M3') || checkStr.startsWith('M4')) {
      isMac = true;
    }
  }

  const group = isMac ? 'MacBook' : 'Windows Laptop';

  if (!includeSubId) return group;

  // Determine sub-identifier (the old alias name or SKU model like 105, M-17, etc.)
  let subId = '';
  if (an && !['Apple MacBook', 'Windows Laptop', 'MacBook'].includes(an)) {
    subId = an;
  } else if (s) {
    const lastDash = s.lastIndexOf('-');
    subId = (lastDash !== -1 ? s.slice(0, lastDash) : s).replace(/_/g, ' ');
  }

  const cleanSubId = subId.trim();
  return cleanSubId ? `${group} (${cleanSubId})` : group;
}

const ScanPrompt: React.FC<{ title?: string, subtitle?: string }> = ({
  title = "Ready to Scan",
  subtitle = "Type a SKU or scan a QR code to see results"
}) => (
  <div className="col-span-full py-32 flex flex-col items-center justify-center text-center space-y-6 animate-in fade-in zoom-in duration-700">
    <div className="relative">
      <div className="absolute inset-0 bg-sky-500/20 blur-3xl rounded-full scale-150 animate-pulse"></div>
      <div className="relative w-24 h-24 bg-gradient-to-br from-sky-500 to-blue-600 rounded-3xl flex items-center justify-center text-white text-4xl shadow-2xl shadow-sky-500/20 ring-4 ring-white">
        <i aria-hidden="true" className="fa-solid fa-qrcode animate-bounce"></i>
      </div>
    </div>
    <div className="space-y-2">
      <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">{title}</h3>
      <p className="text-xs text-slate-400 font-bold uppercase tracking-widest max-w-xs leading-relaxed">{subtitle}</p>
    </div>
    <div className="flex gap-2">
      <div className="w-2 h-2 bg-sky-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
      <div className="w-2 h-2 bg-sky-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
      <div className="w-2 h-2 bg-sky-500 rounded-full animate-bounce"></div>
    </div>
  </div>
);
import {
  MOCK_ASSETS,
  MOCK_CLIENTS,
  MOCK_BOOKINGS
} from './constants';
import { Scanner } from './components/Scanner';
import { ChallanView } from './components/ChallanView';
import { ProgramDeliveries } from './components/ProgramDeliveries';
import { ConsumablePanel } from './components/ConsumablePanel';
import { TruckManifestPanel } from './components/TruckManifestPanel';
import { Logo } from './components/Logo';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts';

import Login from './Login';
import { SettingsView } from './components/SettingsView';
import { ReportsView } from './components/ReportsView';
import { useAppUpdates } from './state/useAppUpdates';
import { QRLabelModal } from './components/QRLabelModal';
import { AIChatbotModal } from './components/AIChatbotModal';
import jsPDF from 'jspdf';

type Page = 'Dashboard' | 'Assets' | 'Employees' | 'Conferences' | 'Billing' | 'Reports' | 'Settings' | 'Subrentals';
type AssetView = 'List' | 'Form' | 'Details';
type EmployeeView = 'List' | 'Form';
type ConferenceView = 'List' | 'Form' | 'Details';

const GlobalQRPreview: React.FC<{ value?: string }> = ({ value = GLOBAL_CONSUMABLES_SKU }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, value || GLOBAL_CONSUMABLES_SKU, {
        width: 120,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(console.error);
    }
  }, [value]);
  return <canvas ref={canvasRef} className="rounded-lg shadow-md" style={{ width: '60px', height: '60px' }} />;
};

const App: React.FC = () => {
  const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
    ? 'http://127.0.0.1:8000' 
    : window.location.origin;

  const showUnknownError = true;
  const isMobilePhone = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const ua = navigator.userAgent;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isTouch = 'ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
    const isNarrow = window.innerWidth < 1024;
    const isPDA = /Zebra|TC21|TC26|MC33|MC93|Scanner|Honeywell|Datalogic/i.test(ua);
    return (isMobile || isTouch || isNarrow) && !isPDA;
  }, []);

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [currentPage, setCurrentPage] = useState<Page>('Dashboard');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [assetView, setAssetView] = useState<AssetView>('List');
  const [companySettings, setCompanySettings] = useState<any>(null);
  const [isEditingDashboard, setIsEditingDashboard] = useState(false);

  // Subrental State
  const [subrentalCompanies, setSubrentalCompanies] = useState<SubrentalCompany[]>([]);
  const [selectedSubrentalCompany, setSelectedSubrentalCompany] = useState<SubrentalCompany | null>(null);
  const [isSubrentalFormOpen, setIsSubrentalFormOpen] = useState(false);
  const [subrentalFormData, setSubrentalFormData] = useState({ name: '', address: '', gst_number: '' });
  const [editingSubrentalId, setEditingSubrentalId] = useState<string | null>(null);
  const [subrentalAssets, setSubrentalAssets] = useState<Asset[]>([]);
  const [subrentalSearchQuery, setSubrentalSearchQuery] = useState('');
  const [subrentalTickets, setSubrentalTickets] = useState<SubrentalTicket[]>([]);
  const [showSubrentalInventory, setShowSubrentalInventory] = useState(false);
  const [isTicketFormOpen, setIsTicketFormOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<SubrentalTicket | null>(null);
  const [ticketFormData, setTicketFormData] = useState({ conference_id: '', custom_conference_name: '', available_from: '', available_till: '', is_custom: false });
  const [isAddingTicketItem, setIsAddingTicketItem] = useState(false);
  const [ticketItemForm, setTicketItemForm] = useState({ name: '', price: 0, depreciation: 0, quantity: 1, rental_price: 0, asset_id: '' });
  const [confSubrentalTickets, setConfSubrentalTickets] = useState<SubrentalTicket[]>([]);
  const [confTicketSourceState, setConfTicketSourceState] = useState({ accountId: '', eventId: '', status: 'loading' });
  const confTicketRequestRef = useRef(0);
  const [ticketItemSearch, setTicketItemSearch] = useState('');
  const [editingTicketItem, setEditingTicketItem] = useState<any>(null);
  const [bookings, setBookings] = useState<Booking[]>(MOCK_BOOKINGS);
  const [clients] = useState<Client[]>(MOCK_CLIENTS);
  const [challans, setChallans] = useState<DeliveryChallanRecord[]>([]);
  const [showScanner, setShowScanner] = useState(false);
  const [selectedBookingForChallan, setSelectedBookingForChallan] = useState<Booking | null>(null);
  const [selectedConferenceDetails, setSelectedConferenceDetails] = useState<Booking | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRequestIdRef = useRef<number>(0);

  useEffect(() => { void retireLegacyApiCache().catch(() => {}); }, []);

  // Updates wait for saved work and explicit operator approval.
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
    updating, updateBlocked,
  } = useAppUpdates();

  const closeUpdatePrompt = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  // Print Mode State
  const [isPrintMode, setIsPrintMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('print') === 'true';
  });
  const [printConfId, setPrintConfId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('confId');
  });

  // Removed redundant useEffect for URL parsing

  useEffect(() => {
    const token = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    if (token) {
      setIsLoggedIn(true);

      // Refresh User Profile from server to avoid stale localStorage permissions
      fetch(`${API_BASE}/api/my-profile/`, {
        headers: { 'Authorization': `Token ${token}` }
      })
        .then(async res => {
          if (token !== localStorage.getItem('token')) return;
          if (res.ok) {
            const profileData = await res.json();
            if (token !== localStorage.getItem('token')) return;
            const fullUser = { ...profileData, token }; // Ensure token is preserved
            setUser(fullUser);
            localStorage.setItem('user', JSON.stringify(fullUser));
          } else if (res.status === 401) {
            // Token expired or invalid
            handleLogout();
          }
        })
        .catch(err => {
          console.error("Failed to refresh profile", err);
          // Fallback to stored user if offline or server error, but don't clear if server was just down
          if (storedUser && token === localStorage.getItem('token')) setUser(JSON.parse(storedUser));
        });

      // Fetch company settings
      fetch(`${API_BASE}/api/company-settings/`, {
        headers: { 'Authorization': `Token ${token}` }
      })
        .then(res => res.json())
        .then(data => { if (token === localStorage.getItem('token')) setCompanySettings(data); })
        .catch(err => console.error("Failed to fetch company settings", err));
    }
    setIsLoading(false);
  }, [isLoggedIn]); // Depend on isLoggedIn to refetch settings if login state changes

  useEffect(() => {
    if (isLoggedIn && user?.role === 'technician' && currentPage === 'Dashboard') {
      setCurrentPage('Conferences');
    }
  }, [isLoggedIn, user, currentPage]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (registerDropdownRef.current && !registerDropdownRef.current.contains(event.target as Node)) {
        setIsRegisterDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (companySettings?.theme_template) {
      document.documentElement.setAttribute('data-theme', companySettings.theme_template);
    } else {
      document.documentElement.setAttribute('data-theme', 'blue');
    }
  }, [companySettings?.theme_template]);

  // EMERGENCY SYSTEM RECOVERY: Force-show vital dashboard sections if they were accidentally hidden
  useEffect(() => {
    if (companySettings && companySettings.dashboard_config) {
      const config = companySettings.dashboard_config;
      let needsReset = false;
      const criticalKeys = ['active_allocations_table', 'active_conferences_table', 'total_assets', 'in_use', 'available', 'active_conferences'];
      
      criticalKeys.forEach(key => {
        if (config[key] === false) {
          config[key] = true;
          needsReset = true;
        }
      });

      if (needsReset) {
        console.warn("🔧 System Recovery: Dashboard visibility was restored for critical sections.");
        setCompanySettings({ ...companySettings, dashboard_config: config });
      }
    }
  }, [companySettings]);

  const toggleCardVisibility = (cardKey: string) => {
    const currentConfig = companySettings?.dashboard_config || {};
    const newConfig = {
      ...currentConfig,
      [cardKey]: currentConfig[cardKey] === false ? true : false
    };
    setCompanySettings({ ...companySettings, dashboard_config: newConfig });
  };

  const handleSaveDashboardConfig = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/company-settings/`, {
        method: 'POST',
        body: JSON.stringify({
          dashboard_config: companySettings.dashboard_config,
          theme_template: companySettings.theme_template
        })
      });
      if (res.ok) {
        setIsEditingDashboard(false);
      }
    } catch (err) {
      console.error("Failed to save dashboard config", err);
    }
  };

  const handleUpdateLabel = (cardKey: string, newLabel: string) => {
    const currentConfig = companySettings?.dashboard_config || {};
    const newConfig = {
      ...currentConfig,
      [`${cardKey}_label`]: newLabel
    };
    setCompanySettings({ ...companySettings, dashboard_config: newConfig });
  };

  const apiFetch = useCallback(async (url: string, options: any = {}) => {
    const token = localStorage.getItem('token');
    const requestKey = `request:${crypto.randomUUID()}`;
    const isWrite = !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase());
    if (isWrite) setWorkBlocker(requestKey, true);
    try {
    const headers: any = {
      ...options.headers,
    };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers['Authorization'] = `Token ${token}`;
    }

    // Callers capture the version they edited, rather than reading a newer version
    // just before sending an old full replacement.
    const conferenceMatch = url.match(/\/api\/conferences\/(\d+)\/\?(?:.*)$/) || url.match(/\/api\/conferences\/(\d+)\/$/);
    if (isWrite && conferenceMatch) {
      const id = conferenceMatch[1];
      const snapshot = conferenceSnapshotsRef.current.get(id);
      if (options.body instanceof FormData) {
        if (!options.body.has('expected_revision')) options.body.set('expected_revision', String(options.expectedRevision ?? options.body.get('revision') ?? snapshot?.revision ?? 0));
      } else {
        const body = JSON.parse(options.body || '{}');
        if (body.expected_revision === undefined) body.expected_revision = options.expectedRevision ?? body.revision ?? snapshot?.revision ?? 0;
        options = { ...options, body: JSON.stringify(body) };
      }
    }
      const response = await fetch(url, { ...options, headers, cache: 'no-store' });
      if (token !== localStorage.getItem('token')) throw new Error('Account changed during request');
      const originalJson = response.json.bind(response);
      response.json = async () => {
        const value = await originalJson();
        if (token !== localStorage.getItem('token')) throw new Error('Account changed during response');
        return value;
      };
      if (response.status === 401) {
        handleLogout();
        return response;
      }
      if (isWrite && response.ok && conferenceMatch && response.status !== 204) {
        const canonical = await response.clone().json();
        if (token !== localStorage.getItem('token')) throw new Error('Account changed during response');
        if (canonical.id && canonical.revision !== undefined) {
          const event = mapConference(canonical);
          const previous = conferenceSnapshotsRef.current.get(event.id);
          if (previous && !acceptRevision(previous.revision, event.revision)) return response;
          conferenceSnapshotsRef.current.set(event.id, event);
          conferenceFetchIdRef.current++;
          setBackendConferences(prev => prev.map(old => old.id === event.id ? event : old));
          setSelectedBookingForChallan(prev => prev?.id === event.id ? event : prev);
        }
      }
      return response;
    } catch (error) {
      console.error('API Fetch Error:', error);
      throw error;
    } finally {
      if (isWrite) setWorkBlocker(requestKey, false);
    }
  }, []);

  const handleLogin = (token: string, userData: any) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setIsLoggedIn(true);
    setUser(userData);
    console.log("Logged in user role:", userData?.role);
    if (userData?.role === 'technician') {
      setCurrentPage('Conferences');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setIsLoggedIn(false);
    setUser(null);
    setAssets([]);
    setEmployees([]);
    setDashboardStats(null);
    setSubrentalCompanies([]); setSubrentalAssets([]); setSubrentalTickets([]); setConfSubrentalTickets([]);
    setSelectedSubrentalCompany(null); setSelectedTicket(null); setViewingAsset(null);
    setEditingEmployee(null); setEditingConference(null); setConferenceView('List'); setShowScanner(false); setLedCasePicker(null);
    setEmployeeInitialPassword('');
    setAssetView('List'); setEmployeeView('List'); setIsTicketFormOpen(false); setIsSubrentalFormOpen(false);
    setAllocationAssets(null); dashboardFetchIdRef.current++;
    setAllocationLoadError('');
    setCustodyReviewEventId(null);
    setLifecycleReviewEventId(null);
    setReconciliationEventId(null);
    setPendingParentAsset(null); setShowTransferModal(false); setShowTruckTransferModal(null);
    setBackendConferences([]);
    setSelectedBookingForChallan(null);
    setSelectedConferenceDetails(null);
    allAssetsRef.current = [];
    knownAssetsMapRef.current.clear();
    conferenceSnapshotsRef.current.clear();
    conferenceFetchIdRef.current++;
    scanFetchIdRef.current++;
    movementOutboxesRef.current.clear();
    setPendingMovementCount(0);
    searchRequestIdRef.current++;
    void retireLegacyApiCache().catch(() => {});
  };

  const handleServerLogout = async () => {
    const token = localStorage.getItem('token');
    if (!token) { handleLogout(); return; }
    try {
      const res = await fetch(`${API_BASE}/api/logout/`, {
        method: 'POST', headers: { Authorization: `Token ${token}` }, cache: 'no-store',
      });
      if (token !== localStorage.getItem('token')) return;
      if (!res.ok && res.status !== 401) throw Error('Server logout was not confirmed.');
      handleLogout();
    } catch {
      if (token === localStorage.getItem('token')) alert('Server logout was not confirmed. Reconnect and retry. Saved work remains on this device.');
    }
  };
  const handleDownloadPdf = (id: string | number) => {
    void downloadEventPdf(id, apiFetch).catch(error => alert(error.message));
  };

  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [employeeView, setEmployeeView] = useState<EmployeeView>('List');
  const [employeeInitialPassword, setEmployeeInitialPassword] = useState('');
  useEffect(() => { if (employeeView !== 'Form' || currentPage !== 'Employees') setEmployeeInitialPassword(''); }, [employeeView, currentPage]);
  const [conferenceView, setConferenceView] = useState<ConferenceView>('List');
  const [custodyReviewEventId, setCustodyReviewEventId] = useState<number | null>(null);
  const [lifecycleReviewEventId, setLifecycleReviewEventId] = useState<number | null>(null);
  const [reconciliationEventId, setReconciliationEventId] = useState<number | null>(null);
  const loadCustodyReview = useCallback(async (id: number): Promise<CustodyReviewData> => {
    const res = await apiFetch(`${API_BASE}/api/conferences/${id}/custody-review/`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Could not load custody review.');
    return data;
  }, [apiFetch, API_BASE]);
  const [challanViewMode, setChallanViewMode] = useState<'List' | 'Detail'>('List');
  const [quickAddInput, setQuickAddInput] = useState('');
  const [quickRemoveInput, setQuickRemoveInput] = useState('');
  const [uploadFeedback, setUploadFeedback] = useState<{type: 'loading' | 'success' | 'error', text: string} | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  // Refs for scanner focus
  const inventorySearchRef = useRef<HTMLInputElement>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const quickRemoveRef = useRef<HTMLInputElement>(null);

  // Refs for scroll management
  const mainRef = useRef<HTMLElement>(null);
  const inventoryScrollPos = useRef<number>(0);
  const [showScrollTop, setShowScrollTop] = useState(false);

  // Status for scanner
  const [assets, setAssets] = useState<Asset[]>([]);
  // Persistent scan-index and known assets cache across entire application lifecycle
  const allAssetsRef = useRef<Asset[]>([]);
  const knownAssetsMapRef = useRef<Map<string, Asset>>(new Map());

  // Helper to normalize any raw asset object from backend to frontend Asset model
  const mapRawAsset = useCallback((asset: any): Asset => ({
    ...asset,
    id: asset.id ? asset.id.toString() : '',
    aliasName: asset.alias_name || asset.aliasName || asset.sku,
    macAddress: asset.mac_address || asset.macAddress || '',
    imeiNumber1: asset.imei_number_1 || asset.imeiNumber1 || '',
    imeiNumber2: asset.imei_number_2 || asset.imeiNumber2 || '',
    serialNumber: asset.serial_number || asset.serialNumber || '',
    isBarcodeAdded: asset.is_barcode_added !== undefined ? asset.is_barcode_added : asset.isBarcodeAdded,
    quantity: stockQuantity(asset.quantity),
    quantity_tracking: asset.quantity_tracking, quantity_available: asset.quantity_available,
    itemPrice: parseFloat(asset.item_price !== undefined ? asset.item_price : asset.itemPrice) || 0,
    depreciationPercentage: parseFloat(asset.depreciation_percentage !== undefined ? asset.depreciation_percentage : asset.depreciationPercentage) || 0,
    purchasedDate: asset.purchased_date || asset.purchasedDate || '',
    availableFrom: asset.available_from || asset.availableFrom || '',
    availableTill: asset.available_till || asset.availableTill || '',
    createdAt: asset.created_at || asset.createdAt || new Date().toISOString(),
    barcode: asset.barcode || '',
    barcodeType: asset.barcode_type || asset.barcodeType || '',
    qrCode: asset.qr_code || asset.qrCode || '',
    lastMaintained: asset.last_maintained || asset.lastMaintained || '',
    isTemporary: asset.is_temporary !== undefined ? asset.is_temporary : asset.isTemporary,
    returnDate: asset.return_date || asset.returnDate || '',
    flag: asset.flag || AssetFlag.NONE,
    currentVenue: asset.current_venue || asset.currentVenue || '',
    assigned_to: asset.assigned_to,
    assigned_to_name: asset.assigned_to_name,
    parent_asset: asset.parent_asset,
    current_conference_name: asset.current_conference_name,
    sub_assets: asset.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
  }), []);

  const registerKnownAssets = useCallback((assetList: any[]) => {
    if (!Array.isArray(assetList)) return;
    assetList.forEach(raw => {
      if (!raw || !raw.id) return;
      const mapped = mapRawAsset(raw);
      knownAssetsMapRef.current.set(String(mapped.id), mapped);

    });
  }, [mapRawAsset]);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeSearchQuery, setEmployeeSearchQuery] = useState('');
  const [backendConferences, setBackendConferences] = useState<Booking[]>([]);
  const [invoicingId, setInvoicingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<any>({});

  // Pending assignment state for sub-assets
  const [pendingParentAsset, setPendingParentAsset] = useState<Asset | null>(null);
  const [pendingAction, setPendingAction] = useState<'add' | 'remove' | 'verify_crosscheck' | null>(null);
  const [scannedSubAssetIds, setScannedSubAssetIds] = useState<string[]>([]);

  // Sub-Asset Linkage State
  const [addingSubAssetMode, setAddingSubAssetMode] = useState<boolean>(false);
  const [creatingSubAssetMode, setCreatingSubAssetMode] = useState<boolean>(false);
  const [subAssetSearchQuery, setSubAssetSearchQuery] = useState('');
  const [selectedSubAssetToLink, setSelectedSubAssetToLink] = useState<Asset | null>(null);

  const [isRegisterDropdownOpen, setIsRegisterDropdownOpen] = useState(false);
  const registerDropdownRef = useRef<HTMLDivElement>(null);

  // Partial Quantity Modal State
  const [showQuantityModal, setShowQuantityModal] = useState(false);
  const [ledCasePicker, setLedCasePicker] = useState<{asset: Asset; action: string} | null>(null);
  const [quantityAsset, setQuantityAsset] = useState<Asset | null>(null);
  const [selectedQuantity, setSelectedQuantity] = useState(1);
  const [quantityAction, setQuantityAction] = useState('stage');
  const [quantitySaving, setQuantitySaving] = useState(false);
  const quantityFlightRef = useRef(false);

  // Global Consumables Picker State
  const [showConsumablesPicker, setShowConsumablesPicker] = useState(false);
  const [consumablesPickerSearchQuery, setConsumablesPickerSearchQuery] = useState('');
  useEffect(() => {
    if (showQuantityModal || showConsumablesPicker || ledCasePicker) setShowScanner(false);
  }, [showQuantityModal, showConsumablesPicker, ledCasePicker]);

  // Asset Transfer Modal State
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferSelectedIds, setTransferSelectedIds] = useState<Set<string>>(new Set());
  const [transferTargetConfId, setTransferTargetConfId] = useState<string>('');
  const [transferScanInput, setTransferScanInput] = useState<string>('');
  const [transferring, setTransferring] = useState(false);
  const [showTransferScanner, setShowTransferScanner] = useState(false);
  const transferScanRef = useRef<HTMLInputElement>(null);

  // Print Selection & Challan Detail View state
  const [printSelectConf, setPrintSelectConf] = useState<Booking | null>(null);
  const [challanDetailTab, setChallanDetailTab] = useState<'dispatch' | 'return'>('dispatch');

  // Multi-Truck Challan State
  const [activeTruckChallanId, setActiveTruckChallanId] = useState<string | null>(null);
  const [showTruckTransferModal, setShowTruckTransferModal] = useState<{fromTruckId: string, toTruckId: string} | null>(null);
  const [editingTruckId, setEditingTruckId] = useState<string | null>(null);
  const [truckEditValues, setTruckEditValues] = useState<{vehicle_number: string, driver_phone: string, challan_number?: string, expected_revision?: number}>({vehicle_number: '', driver_phone: '', challan_number: ''});
  const [truckTransferSelection, setTruckTransferSelection] = useState<string[]>([]);
  const [truckTransferQuantities, setTruckTransferQuantities] = useState<Record<string, number>>({});
  const [packingTargetTruckId, setPackingTargetTruckId] = useState<string | null>(null);

  const [quickSubAssetData, setQuickSubAssetData] = useState({ sku: '', serialNumber: '', type: 'Other', itemPrice: 0, generateQR: false });

  const [viewingAsset, setViewingAsset] = useState<Asset | null>(null);
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  const [dashboardStats, setDashboardStats] = useState<{total: number, ready: number, in_use: number, maintenance: number} | null>(null);
  const [aliasDictionary, setAliasDictionary] = useState<any[]>([]);

  // Asset Form State
  const [assetFormData, setAssetFormData] = useState<Partial<Asset>>({
    sku: '',
    aliasName: '',
    macAddress: '',
    imeiNumber1: '',
    imeiNumber2: '',
    serialNumber: '',
    description: '',
    isBarcodeAdded: false,
    type: AssetCategory.OTHER,
    purchasedDate: '',
    itemPrice: 0,
    depreciationPercentage: 15,
    availableFrom: '',
    availableTill: '',
    status: AssetStatus.AVAILABLE,
    condition: 'Good',
    barcode: '',
    barcodeType: '',
    qrCode: '',
    flag: AssetFlag.NONE,
    quantity: 1,
    assigned_to: undefined,
    generateQR: false
  });

  // Employee Form State
  const [employeeFormData, setEmployeeFormData] = useState<Partial<Employee>>({
    name: '',
    employee_id: '',
    department: '',
    email: '',
    phone: ''
  });


  const silentBackgroundFetch = (url: string) => {
    setIsBackgroundSyncing(true);
    const secureUrl = url.replace('http://', 'https://');
    apiFetch(secureUrl)
      .then(async res => {
        const data = await res.json();
        const results = data.results || data;

        if (Array.isArray(results)) {
          const mappedAssets: Asset[] = results.map((asset: any) => ({
            ...asset,
            id: asset.id.toString(),
            aliasName: asset.alias_name,
            macAddress: asset.mac_address,
            imeiNumber1: asset.imei_number_1,
            imeiNumber2: asset.imei_number_2,
            serialNumber: asset.serial_number,
            isBarcodeAdded: asset.is_barcode_added,
            quantity: stockQuantity(asset.quantity),
            quantity_tracking: asset.quantity_tracking, quantity_available: asset.quantity_available,
            itemPrice: parseFloat(asset.item_price),
            depreciationPercentage: parseFloat(asset.depreciation_percentage),
            purchasedDate: asset.purchased_date,
            availableFrom: asset.available_from,
            availableTill: asset.available_till,
            createdAt: asset.created_at,
            barcode: asset.barcode,
            barcodeType: asset.barcode_type,
            qrCode: asset.qr_code,
            lastMaintained: asset.last_maintained,
            isTemporary: asset.is_temporary,
            returnDate: asset.return_date,
            flag: asset.flag || AssetFlag.NONE,
            currentVenue: asset.current_venue,
            assigned_to: asset.assigned_to,
            assigned_to_name: asset.assigned_to_name,
            parent_asset: asset.parent_asset,
            current_conference_name: asset.current_conference_name,
            sub_assets: asset.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
          }));
          
          setAssets(prev => {
            const existingIds = new Set(prev.map(a => a.id));
            const newAssets = mappedAssets.filter(a => !existingIds.has(a.id));
            return [...prev, ...newAssets];
          });
        }
        
        if (data.next) {
          silentBackgroundFetch(data.next);
        } else {
          setIsBackgroundSyncing(false);
        }
      })
      .catch(err => {
        console.error("Silent background fetch failed:", err);
        setIsBackgroundSyncing(false);
      });
  };

  const fetchAssets = (search: string = ''): Promise<Asset[]> => {
    const requestId = ++searchRequestIdRef.current;
    // Use ?all=true so every asset is returned in a single response.
    // The backend already supports this (skips pagination when all=true).
    // This eliminates the blinking / batch-loading flicker and loads everything
    // in one network round-trip.
    const url = `${API_BASE}/api/assets/?all=true&search=${encodeURIComponent(search)}&_t=${Date.now()}`;
    return apiFetch(url)
      .then(async res => {
        if (requestId !== searchRequestIdRef.current) return [];
        const data = await res.json();
        if (requestId !== searchRequestIdRef.current) return [];
        const results = Array.isArray(data) ? data : (data.results ?? data);

        if (Array.isArray(results)) {
          if (requestId !== searchRequestIdRef.current) return [];
          const mappedAssets: Asset[] = results.map((asset: any) => ({
            ...asset,
            id: asset.id.toString(),
            aliasName: asset.alias_name,
            macAddress: asset.mac_address,
            imeiNumber1: asset.imei_number_1,
            imeiNumber2: asset.imei_number_2,
            serialNumber: asset.serial_number,
            isBarcodeAdded: asset.is_barcode_added,
            quantity: stockQuantity(asset.quantity),
            quantity_tracking: asset.quantity_tracking, quantity_available: asset.quantity_available,
            itemPrice: parseFloat(asset.item_price),
            depreciationPercentage: parseFloat(asset.depreciation_percentage),
            purchasedDate: asset.purchased_date,
            availableFrom: asset.available_from,
            availableTill: asset.available_till,
            createdAt: asset.created_at,
            barcode: asset.barcode,
            barcodeType: asset.barcode_type,
            qrCode: asset.qr_code,
            lastMaintained: asset.last_maintained,
            isTemporary: asset.is_temporary,
            returnDate: asset.return_date,
            flag: asset.flag || AssetFlag.NONE,
            currentVenue: asset.current_venue,
            assigned_to: asset.assigned_to,
            assigned_to_name: asset.assigned_to_name,
            parent_asset: asset.parent_asset,
            current_conference_name: asset.current_conference_name,
            sub_assets: asset.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
          }));
          // Register incoming assets
          registerKnownAssets(mappedAssets);
          setAssets(mappedAssets);
          setIsBackgroundSyncing(false);
          return mappedAssets;
        } else if (res.status !== 401) {
          console.error("Failed to fetch assets: Invalid data format", data);
        }
        return [];
      })
      .catch(err => {
        console.error("Failed to fetch assets:", err);
        return [];
      });
  };

  const silentPollUpdates = (search: string = '') => {
    // If the user has typed an active search query in the inventory search, DO NOT poll or overwrite assets!
    if (searchQuery.trim().length > 0) return Promise.resolve([]);
    const url = `${API_BASE}/api/assets/?search=${encodeURIComponent(search)}&_t=${Date.now()}`;
    return apiFetch(url)
      .then(async res => {
        if (searchQuery.trim().length > 0) return [];
        const data = await res.json();
        const results = data.results !== undefined ? data.results : data;

        if (Array.isArray(results)) {
          const mappedAssets: Asset[] = results.map((asset: any) => ({
            ...asset,
            id: asset.id.toString(),
            aliasName: asset.alias_name,
            macAddress: asset.mac_address,
            imeiNumber1: asset.imei_number_1,
            imeiNumber2: asset.imei_number_2,
            serialNumber: asset.serial_number,
            isBarcodeAdded: asset.is_barcode_added,
            quantity: stockQuantity(asset.quantity),
            quantity_tracking: asset.quantity_tracking, quantity_available: asset.quantity_available,
            itemPrice: parseFloat(asset.item_price),
            depreciationPercentage: parseFloat(asset.depreciation_percentage),
            purchasedDate: asset.purchased_date,
            availableFrom: asset.available_from,
            availableTill: asset.available_till,
            createdAt: asset.created_at,
            barcode: asset.barcode,
            barcodeType: asset.barcode_type,
            qrCode: asset.qr_code,
            lastMaintained: asset.last_maintained,
            isTemporary: asset.is_temporary,
            returnDate: asset.return_date,
            flag: asset.flag || AssetFlag.NONE,
            currentVenue: asset.current_venue,
            assigned_to: asset.assigned_to,
            assigned_to_name: asset.assigned_to_name,
            parent_asset: asset.parent_asset,
            current_conference_name: asset.current_conference_name,
            sub_assets: asset.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
          }));
          
          setAssets(prev => {
            const newAssets = [...prev];
            mappedAssets.forEach(incomingAsset => {
              const existingIdx = newAssets.findIndex(a => a.id === incomingAsset.id);
              if (existingIdx !== -1) {
                newAssets[existingIdx] = incomingAsset; // Update existing
              } else {
                newAssets.unshift(incomingAsset); // Add new to top
              }
            });
            return newAssets;
          });
        }
      })
      .catch(err => {
        console.error("Silent poll failed:", err);
      });
  };

  const fetchEmployees = () => {
    apiFetch(`${API_BASE}/api/employees/`)
      .then(async res => {
        const data = await res.json();
        if (Array.isArray(data)) {
          setEmployees(data);
        } else if (res.status !== 401) {
          console.error("Failed to fetch employees: Invalid data format", data);
          setEmployees([]);
        }
      })
      .catch(err => console.error("Failed to fetch employees:", err));
  };

  const fetchSubrentalCompanies = () => {
    apiFetch(`${API_BASE}/api/subrental-companies/`)
      .then(async res => {
        const data = await res.json();
        if (Array.isArray(data)) {
          setSubrentalCompanies(data);
        }
      })
      .catch(err => console.error("Failed to fetch subrental companies:", err));
  };

  const subrentalAssetRequestRef = useRef(0);
  const [subrentalInventoryStatus, setSubrentalInventoryStatus] = useState({ companyId: '', status: 'loading', error: '' });
  const fetchSubrentalAssets = (companyId: string) => {
    const requestId = ++subrentalAssetRequestRef.current, session = localStorage.getItem('token');
    setSubrentalAssets([]); setSubrentalInventoryStatus({ companyId: String(companyId), status: 'loading', error: '' });
    apiFetch(`${API_BASE}/api/assets/?all=true&subrental_company_id=${encodeURIComponent(companyId)}`)
      .then(async response => {
        const data = await response.json();
        if (!response.ok || !Array.isArray(data) || data.some((raw: any) => String(raw.subrental_company) !== String(companyId))) throw Error('Supplier inventory could not load. Retry this company.');
        if (requestId !== subrentalAssetRequestRef.current || session !== localStorage.getItem('token') || supplierCompanyRef.current !== String(companyId)) return;
        setSubrentalAssets(data.map(mapRawAsset).filter((asset: Asset) => !asset.isTemporary));
        setSubrentalInventoryStatus({ companyId: String(companyId), status: 'ready', error: '' });
      }).catch(error => {
        if (requestId !== subrentalAssetRequestRef.current || session !== localStorage.getItem('token') || supplierCompanyRef.current !== String(companyId)) return;
        setSubrentalInventoryStatus({ companyId: String(companyId), status: 'error', error: error instanceof Error ? error.message : 'Supplier inventory could not load.' });
      });
  };

  const mapTicketData = (data: any[]) => data.map((t: any) => ({
    ...t,
    items: t.items?.map((i: any) => ({
      ...i,
      asset_details: i.asset_details ? {
        ...i.asset_details,
        aliasName: i.asset_name || i.asset_details?.alias_name || i.asset_details?.name || i.asset_details?.sku || "New Subrental Item",
        sku: i.asset_details?.sku || i.asset_name || i.asset_details?.alias_name || i.asset_details?.name
      } : null
    }))
  }));

  const fetchSubrentalTickets = (companyId: string | number) => {
    apiFetch(`${API_BASE}/api/subrental-tickets/?company_id=${companyId}&_t=${Date.now()}`)
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          setSubrentalTickets(mapTicketData(data));
        }
      })
      .catch(err => console.error("Failed to fetch subrental tickets:", err));
  };

  const fetchConferenceSubrentalTickets = (confId: string | number) => {
    const requestId = ++confTicketRequestRef.current;
    const sessionToken = localStorage.getItem('token');
    const accountId = String(user?.user_id || user?.email || '');
    const current = () => requestId === confTicketRequestRef.current && localStorage.getItem('token') === sessionToken;
    setConfTicketSourceState({ accountId, eventId: String(confId), status: 'loading' });
    apiFetch(`${API_BASE}/api/subrental-tickets/?conference_id=${confId}&_t=${Date.now()}`)
      .then(async res => {
        if (!res.ok) throw Error(`Rental sources could not load (${res.status})`);
        const data = await res.json();
        if (!Array.isArray(data)) throw Error('Rental sources response is incomplete');
        if (!current()) return;
        setConfSubrentalTickets(mapTicketData(data));
        setConfTicketSourceState({ accountId, eventId: String(confId), status: 'ready' });
      })
      .catch(err => {
        if (!current()) return;
        setConfTicketSourceState({ accountId, eventId: String(confId), status: 'error' });
        showScanToast(`Rental sources not confirmed: ${err.message}. Retry loading sources before creating a new challan.`, 'error');
      });
  };
  const challanSourcesReady = (conf: Booking, truckId?: string | null) => Boolean(truckId ||
    conf.challan_documents?.some(document => document.scope === 'master') ||
    (confTicketSourceState.status === 'ready' && confTicketSourceState.eventId === String(conf.id) &&
      confTicketSourceState.accountId === String(user?.user_id || user?.email || '')));

  const [allocationAssets, setAllocationAssets] = useState<Asset[] | null>(null);
  const [allocationLoadError, setAllocationLoadError] = useState('');
  const [allocationRefreshKey, setAllocationRefreshKey] = useState(0);
  const reportApiFetch = useCallback((url: string, options?: RequestInit) => apiFetch(url.startsWith('/api/') ? `${API_BASE}${url}` : url, options), [apiFetch, API_BASE]);
  const refreshLifecycleEvent = useCallback(async (id: number) => {
    const response = await apiFetch(`${API_BASE}/api/conferences/${id}/`);
    if (!response.ok) throw new Error(`Current event could not be loaded (${response.status}). Retry the saved operation.`);
    const raw = await response.json();
    if (raw.id !== id || !['open', 'completed', 'archived'].includes(raw.lifecycle_state)) throw new Error('Unexpected current event response.');
    const event = mapConference(raw), previous = conferenceSnapshotsRef.current.get(event.id);
    if (previous && !acceptRevision(previous.revision, event.revision)) throw new Error('Current event changed during refresh. Retry the saved operation.');
    conferenceSnapshotsRef.current.set(event.id, event); conferenceFetchIdRef.current++;
    setBackendConferences(old => old.map(value => value.id === event.id ? event : value));
  }, [apiFetch, API_BASE]);
  const dashboardFetchIdRef = useRef(0);
  const refreshReconciliationState = useCallback(async (id: number, assetIds: number[] = []) => {
    const session = localStorage.getItem('token');
    const response = await reportApiFetch('/api/reconciliation/current-state/', { method: 'POST', body: JSON.stringify({ asset_ids: assetIds, conference_ids: [id] }) });
    const data = await response.json();
    if (!response.ok || data.operation !== 'reconciliation_current_state' || !Array.isArray(data.asset_states) || !Array.isArray(data.conferences)) throw new Error('Current repair records could not be loaded. Recover the exact saved request.');
    if (session !== localStorage.getItem('token')) throw new Error('Account changed during repair refresh.');
    if (data.asset_states.length !== assetIds.length || data.asset_states.some((row: any) => !assetIds.includes(row.id)) || data.conferences.length !== 1 || data.conferences[0].id !== id) throw new Error('Unexpected current repair projection.');
    const event = mapConference(data.conferences[0]), previous = conferenceSnapshotsRef.current.get(event.id);
    if (previous && !acceptRevision(previous.revision, event.revision)) throw new Error('Current event changed during refresh. Recover the saved request.');
    const states = new Map<string, Asset>(data.asset_states.map((raw: any) => { const asset = mapRawAsset(raw); return [asset.id, asset]; }));
    conferenceSnapshotsRef.current.set(event.id, event); conferenceFetchIdRef.current++; scanFetchIdRef.current++; searchRequestIdRef.current++;
    setBackendConferences(old => old.map(value => value.id === event.id ? event : value));
    setAssets(old => old.map(asset => states.get(asset.id) || asset)); allAssetsRef.current = allAssetsRef.current.map(asset => states.get(asset.id) || asset);
    states.forEach((asset, key) => knownAssetsMapRef.current.set(key, asset));
  }, [reportApiFetch]);
  const fetchEmployeeAllocations = async (requestId: number) => {
    try {
      const response = await apiFetch(`${API_BASE}/api/employee-allocations/`);
      if (!response.ok) throw new Error(`Allocation load failed (${response.status})`);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Unexpected allocation response');
      if (requestId === dashboardFetchIdRef.current) { setAllocationAssets(rows.map(asset => ({...mapRawAsset(asset), assigned_to:asset.allocation_employee_id ?? asset.assigned_to, assigned_to_name:asset.allocation_employee_name ?? asset.assigned_to_name}))); setAllocationLoadError(''); }
    } catch (error) { if (requestId === dashboardFetchIdRef.current) setAllocationLoadError('Allocation summary could not be loaded.'); }
  };
  const fetchDashboardStats = () => {
    const requestId = ++dashboardFetchIdRef.current;
    void fetchEmployeeAllocations(requestId);
    apiFetch(`${API_BASE}/api/asset-stats/`)
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          if (requestId === dashboardFetchIdRef.current) setDashboardStats(data);
        }
      })
      .catch(err => console.error("Failed to fetch dashboard stats:", err));
  };
  const allocationsChanged = () => { setAllocationRefreshKey(value => value + 1); fetchDashboardStats(); };

  const fetchAliases = () => {
    apiFetch(`${API_BASE}/api/aliases/`)
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          const dictData = data.results !== undefined ? data.results : data;
          setAliasDictionary(Array.isArray(dictData) ? dictData : []);
        }
      })
      .catch(err => console.error("Failed to fetch aliases:", err));
  };

  // Build the complete scan-index (all assets) silently into a ref.
  // Does NOT call setAssets — zero UI re-renders.
  const scanFetchIdRef = useRef(0);
  const fetchAllAssetsForScan = () => {
    if (!isLoggedIn || !user || hasPendingWork()) return;
    const requestId = ++scanFetchIdRef.current;
    const sessionToken = localStorage.getItem('token');
    apiFetch(`${API_BASE}/api/assets/?all=true`)
      .then(async res => {
        if (!res.ok) return;
        const data = await res.json();
        const results: any[] = Array.isArray(data) ? data : (data.results ?? []);
        const mappedResults: Asset[] = results.map((asset: any) => ({
          ...asset,
          id: asset.id.toString(),
          aliasName: asset.alias_name,
          macAddress: asset.mac_address,
          imeiNumber1: asset.imei_number_1,
          imeiNumber2: asset.imei_number_2,
          serialNumber: asset.serial_number,
          isBarcodeAdded: asset.is_barcode_added,
          quantity: stockQuantity(asset.quantity),
          quantity_tracking: asset.quantity_tracking, quantity_available: asset.quantity_available,
          itemPrice: parseFloat(asset.item_price),
          depreciationPercentage: parseFloat(asset.depreciation_percentage),
          purchasedDate: asset.purchased_date,
          availableFrom: asset.available_from,
          availableTill: asset.available_till,
          createdAt: asset.created_at,
          barcode: asset.barcode,
          barcodeType: asset.barcode_type,
          qrCode: asset.qr_code,
          lastMaintained: asset.last_maintained,
          isTemporary: asset.is_temporary,
          returnDate: asset.return_date,
          flag: asset.flag || AssetFlag.NONE,
          currentVenue: asset.current_venue,
          assigned_to: asset.assigned_to,
          assigned_to_name: asset.assigned_to_name,
          parent_asset: asset.parent_asset,
          current_conference_name: asset.current_conference_name,
          sub_assets: asset.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
        }));

        if (requestId !== scanFetchIdRef.current || sessionToken !== localStorage.getItem('token')) return;
        registerKnownAssets(mappedResults);

        knownAssetsMapRef.current = new Map(mappedResults.map(asset => [String(asset.id), asset]));
        allAssetsRef.current = mappedResults;

      })
      .catch(err => console.error('Scan index refresh failed:', err));
  };

  // Fetch data on load
  React.useEffect(() => {
    if (!isLoggedIn || !user) return;
    fetchAssets();
    fetchAllAssetsForScan(); // Build complete scan-index on mount
    fetchDashboardStats();
    fetchAliases();
    fetchEmployees();
    fetchSubrentalCompanies();

    // Refresh scan-index every 2 minutes silently in background
    const scanRefreshInterval = setInterval(fetchAllAssetsForScan, 120000);
    return () => clearInterval(scanRefreshInterval);
  }, [isLoggedIn, user?.user_id]);

  const [supplierSaveReason, setSupplierSaveReason] = useState('');
  const supplierCompanyRef = useRef(''); supplierCompanyRef.current = String(selectedSubrentalCompany?.id || '');
  const refreshSupplierTicket = useCallback(async (ack: { ticket_id: number; conference_id: number }) => {
    const session = localStorage.getItem('token');
    const response = await reportApiFetch(`/api/subrental-tickets/${ack.ticket_id}/`);
    const data = await response.json();
    if (!response.ok || data.id !== ack.ticket_id || data.conference !== ack.conference_id || !Array.isArray(data.items) || !Number.isSafeInteger(data.conference_revision)) throw Error('Current supplier ticket could not load. Recover the saved request.');
    const eventResponse = await reportApiFetch(`/api/conferences/${ack.conference_id}/`);
    const rawEvent = await eventResponse.json();
    if (!eventResponse.ok || rawEvent.id !== ack.conference_id || !Number.isSafeInteger(rawEvent.revision)) throw Error('Current supplier event could not load. Recover the saved request.');
    if (session !== localStorage.getItem('token')) throw Error('Account changed during supplier refresh.');
    const ticket = mapTicketData([data])[0], event = mapConference(rawEvent), previous = conferenceSnapshotsRef.current.get(event.id);
    if (previous && !acceptRevision(previous.revision, event.revision)) throw Error('Newer event records are already displayed. Recover the saved request.');
    conferenceSnapshotsRef.current.set(event.id, event); conferenceFetchIdRef.current++; confTicketRequestRef.current++;
    setBackendConferences(old => old.some(value => value.id === event.id) ? old.map(value => value.id === event.id ? event : value) : [...old, event]);
    setSelectedTicket(old => old && String(old.id) === String(ticket.id) ? ticket : old);
    if (supplierCompanyRef.current === String(ticket.company)) setSubrentalTickets(old => old.some(value => String(value.id) === String(ticket.id)) ? old.map(value => String(value.id) === String(ticket.id) ? ticket : value) : [...old, ticket]);
    setConfSubrentalTickets(old => old.map(value => String(value.id) === String(ticket.id) ? ticket : value));
    setConfTicketSourceState(old => String(old.eventId) === String(ack.conference_id) ? { ...old, status: 'error', error: 'Supplier sources changed. Reload rental sources before importing.' } : old);
  }, [reportApiFetch]);
  const supplierSaving = useSupplierSaving(user, reportApiFetch, refreshSupplierTicket);
  useEffect(() => { const key = `supplier-editor:${user?.user_id || user?.email || ''}`; setWorkBlocker(key, isTicketFormOpen || isAddingTicketItem); return () => setWorkBlocker(key, false); }, [isTicketFormOpen, isAddingTicketItem, user?.user_id, user?.email]);

  const handleCreateSubrentalTicket = async () => {
    if (!selectedSubrentalCompany || supplierSaving.busy) return;
    const session = localStorage.getItem('token');
    try {
      let revision: number | null = null;
      const custom = ticketFormData.is_custom, conferenceId = custom ? null : Number(ticketFormData.conference_id);
      if (!custom) {
        const response = await reportApiFetch(`/api/conferences/${conferenceId}/`), event = await response.json();
        if (!response.ok || event.id !== conferenceId || !Number.isSafeInteger(event.revision)) throw Error('Select an existing event and reload its records.');
        revision = event.revision;
      }
      if (session !== localStorage.getItem('token')) throw Error('Account changed before supplier saving.');
      await supplierSaving.save({ request_id: crypto.randomUUID(), action: custom ? 'create_custom_ticket' : 'create_ticket', conference_id: conferenceId, expected_revision: revision, reason: supplierSaveReason,
        data: { company_id: Number(selectedSubrentalCompany.id), available_from: ticketFormData.available_from || null, available_till: ticketFormData.available_till || null, ...(custom ? { name: ticketFormData.custom_conference_name } : {}) } });
      if (session !== localStorage.getItem('token')) return;
      setIsTicketFormOpen(false); setSupplierSaveReason('');
      setTicketFormData({ conference_id: '', custom_conference_name: '', available_from: '', available_till: '', is_custom: false });
      showScanToast('Supplier ticket saved', 'success');
    } catch (error) { if (session === localStorage.getItem('token')) showScanToast(error instanceof Error ? error.message : 'Supplier save remains unresolved.', 'error'); }
  };

  const handleAddTicketItem = async () => {
    if (!selectedTicket || supplierSaving.busy) return;
    const session = localStorage.getItem('token');
    try {
      const ticketId = Number(selectedTicket.id), editing = Boolean(editingTicketItem);
      const data = editing ? { ticket_id: ticketId, item_id: Number(editingTicketItem!.id), quantity: ticketItemForm.quantity, rental_price: ticketItemForm.rental_price } :
        ticketItemForm.asset_id ? { ticket_id: ticketId, asset_id: Number(ticketItemForm.asset_id), quantity: ticketItemForm.quantity, rental_price: ticketItemForm.rental_price } :
        { ticket_id: ticketId, asset_id: null, name: ticketItemForm.name, price: ticketItemForm.price, depreciation: ticketItemForm.depreciation, quantity: ticketItemForm.quantity, rental_price: ticketItemForm.rental_price };
      await supplierSaving.save({ request_id: crypto.randomUUID(), action: editing ? 'edit_item' : 'add_item', conference_id: Number(selectedTicket.conference), expected_revision: selectedTicket.conference_revision ?? null, reason: supplierSaveReason, data });
      if (session !== localStorage.getItem('token')) return;
      setIsAddingTicketItem(false); setEditingTicketItem(null); setSupplierSaveReason('');
      setTicketItemForm({ name: '', price: 0, depreciation: 0, quantity: 1, rental_price: 0, asset_id: '' });
      showScanToast(editing ? 'Supplier item updated' : 'Supplier item added', 'success');
    } catch (error) { if (session === localStorage.getItem('token')) showScanToast(error instanceof Error ? error.message : 'Supplier save remains unresolved.', 'error'); }
  };

  const handleDeleteTicketItem = (itemId: string | number) => {
    if (!confirm("Are you sure you want to remove this item from the ticket?")) return;
    apiFetch(`${API_BASE}/api/subrental-ticket-items/${itemId}/`, { method: 'DELETE' })
      .then(async res => {
        if (!res.ok) {
          const result = await res.json();
          throw new Error(['reviewed_supplier_removal_required', 'ticket_item_has_event_lifecycle_history', 'ticket_item_has_challan_history'].includes(result.error)
            ? 'This supplier entry has history that needs review. Nothing was removed; its recorded return or cancellation workflow must be completed first.'
            : 'The supplier entry could not be removed. Its current records were kept.');
        }
        if (res.ok) {
          if (selectedTicket) {
             apiFetch(`${API_BASE}/api/subrental-tickets/${selectedTicket.id}/`)
               .then(async r => {
                 if (r.ok) {
                   const updatedTicket = await r.json();
                   setSelectedTicket(updatedTicket);
                   fetchSubrentalTickets(selectedTicket.company);
                 }
               });
          }
          showScanToast("Item Removed", "success");
        }
      }).catch(error => showScanToast(error.message || 'The supplier entry could not be removed.', 'error'));
  };

  const handleEditTicketItem = (item: any) => {
    if (supplierSaving.busy || supplierSaving.pending || supplierSaving.error) return;
    setEditingTicketItem(item);
    setTicketItemForm({
      name: item.asset_details?.aliasName || item.asset_details?.alias_name || item.asset_details?.sku || '',
      price: item.asset_details?.item_price || 0,
      depreciation: item.asset_details?.depreciation_percentage || 0,
      quantity: item.quantity,
      rental_price: item.rental_price,
      asset_id: item.asset.toString()
    });
    setIsAddingTicketItem(true);
  };

  useEffect(() => {
    const targetId = selectedBookingForChallan?.id || (isPrintMode ? printConfId : null);
    if (!user) { ++confTicketRequestRef.current; setConfTicketSourceState({ accountId: '', eventId: '', status: 'loading' }); return; }
    if (targetId) {
      fetchConferenceSubrentalTickets(targetId);
    } else if (!isPrintMode) {
      ++confTicketRequestRef.current;
      setConfSubrentalTickets([]);
    }
  }, [selectedBookingForChallan?.id, isPrintMode, printConfId, user?.user_id, user?.email]);

  // Performance optimizations: Debounced Search & Pagination
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  // Polling: background refresh adjusted to 25s to prevent UI clobbering, race conditions, and excessive requests
  // Skips polling if tab is hidden, or if searching inventory, or if viewing challan details or editing conference.
  React.useEffect(() => {
    if (!isLoggedIn || !user) return;
    const interval = setInterval(() => {
      // 1. Do not poll if the browser tab is hidden/inactive
      if (typeof document !== 'undefined' && document.hidden) return;
      if (hasPendingWork()) return;

      // 2. Only poll assets if no active search query is typed or settling
      if (!isBackgroundSyncing && !searchQuery.trim() && !debouncedSearchQuery.trim()) {
        silentPollUpdates();
      }

      // 3. Poll dashboard statistics
      fetchDashboardStats();

      // 4. Do not poll conferences while in conference form or while viewing a challan in detail mode
      const isViewingChallanDetail = currentPage === 'Billing' && challanViewMode === 'Detail';
      if (conferenceView !== 'Form' && !isViewingChallanDetail) {
        fetchConferences();
      }
    }, 25000);
    return () => clearInterval(interval);
  }, [isLoggedIn, user?.user_id, conferenceView, isBackgroundSyncing, searchQuery, debouncedSearchQuery, currentPage, challanViewMode]);


  // J-115: Revert J-114 UI, Restore original filter
  const [inventoryCategoryFilter, setInventoryCategoryFilter] = useState<string>('All');
  // J-118: Alias Filter State
  const [selectedAlias, setSelectedAlias] = useState<string>('All');
  const [inventoryStatusFilter, setInventoryStatusFilter] = useState<string>('All');
  const [inventorySortOption, setInventorySortOption] = useState<string>('newest');
  const [purchaseDateFrom, setPurchaseDateFrom] = useState<string>('');
  const [purchaseDateTo, setPurchaseDateTo] = useState<string>('');
  const [inventoryPage, setInventoryPage] = useState(1);
  const itemsPerPage = 20; 

  // Smart SKU batch sequencing algorithm
  const generateBatchSkus = (baseSku: string, count: number): string[] => {
    const trimmed = baseSku.trim();
    if (count <= 1 || !trimmed) return [trimmed];

    const skus: string[] = [];
    const match = trimmed.match(/^(.*?)([-_])(\d+)$/);

    if (match) {
      const prefix = match[1];
      const sep = match[2];
      const numStr = match[3];
      const startNum = parseInt(numStr, 10);
      const padLen = numStr.length;

      for (let i = 0; i < count; i++) {
        const currentNum = (startNum + i).toString().padStart(padLen, '0');
        skus.push(`${prefix}${sep}${currentNum}`);
      }
    } else {
      for (let i = 0; i < count; i++) {
        skus.push(`${trimmed}-${i + 1}`);
      }
    }

    return skus;
  }; 

  // Mapping Helper
  const getUICategory = (type: string): UICategory => {
    return CATEGORY_MAP[type] || UICategory.OTHER;
  };

  const mapUIToDBType = (uiCat: string): string => {
    switch (uiCat) {
      case UICategory.IT: return AssetCategory.IT;
      case UICategory.AV: return AssetCategory.SWITCHERS;
      case UICategory.SOUND: return AssetCategory.SPEAKERS;
      case UICategory.DISPLAY: return AssetCategory.MONITORS;
      case UICategory.CABLE: return AssetCategory.CABLE;
      case UICategory.CONSUMABLES: return AssetCategory.CONSUMABLES;
      case UICategory.LIGHTING: return AssetCategory.LIGHTING;
      default: return AssetCategory.OTHER;
    }
  };

  // Debounce: update debouncedSearchQuery 300ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Trigger server-side fetch whenever debounced query settles
  useEffect(() => {
    setInventoryPage(1);
    fetchAssets(debouncedSearchQuery);
  }, [debouncedSearchQuery]);
  // Compute derived categories
  const derivedCategories = useMemo(() => {
    return ['All', ...new Set(assets.map(a => (a as any).category || getUICategory(a.type)).filter(Boolean))] as string[];
  }, [assets]);

  // J-118: Compute unique aliases with count badges and laptop OS sub-grouping
  const uniqueAliases = useMemo(() => {
    // NOTE: We use `assets` (not allAssetsRef) — allAssetsRef is declared later in the
    // function body and would be in TDZ here, causing a crash.
    const BAD_STATUSES = new Set(['Damaged', 'On Service', 'Missing', 'Expired']);
    const countMap: Record<string, number> = {};

    assets.forEach(a => {
      if (a.isTemporary) return;
      // Compute the display-level alias (sub-group for laptops, raw alias for everything else)
      const displayAlias = getLaptopSubGroup(a) ?? a.aliasName;
      if (!displayAlias) return;
      // Exclude damaged / flagged assets from the count
      const isDamagedOrFlagged = BAD_STATUSES.has(a.status) || !!(a.flag && a.flag !== '');
      if (!isDamagedOrFlagged) {
        countMap[displayAlias] = (countMap[displayAlias] || 0) + 1;
      }
    });

    const sorted = Object.keys(countMap).sort();
    return [
      { label: 'All Aliases', value: 'All', count: 0 },
      ...sorted.map(alias => ({ label: alias, value: alias, count: countMap[alias] }))
    ];
  }, [assets]);

  // J-PhaseB: Memoized map of active conference names for fast asset location lookup
  const assetConferenceMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!backendConferences || backendConferences.length === 0) return map;
    backendConferences.forEach(c => {
      if (c.isAudit) return;
      const confName = c.conferenceName || (c as any).name || 'Active Conference';
      const allIds = [
        ...(c.assets || []),
        ...(c.crosscheckAssets || [])
      ];
      allIds.forEach(id => {
        if (id) map.set(String(id), confName);
      });
    });
    return map;
  }, [backendConferences]);

  const getAssetConferenceName = useCallback((asset: Asset): string | undefined => {
    if (asset.current_conference_name) return asset.current_conference_name;
    return assetConferenceMap.get(String(asset.id));
  }, [assetConferenceMap]);

  // Compute filtered assets once
  const filteredInventoryAssets = useMemo(() => {
    // 1. Text Search: Instant client-side filtering on searchQuery
    const q = searchQuery.trim().toLowerCase();
    
    // 2. Category & Alias Filter
    const filtered = assets.filter(asset => {
      if (asset.stock_kind === 'led_case') return false;
      // Main inventory belongs to the issuing company; the shared scan pool includes all owners.
      if (asset.isTemporary || asset.subrental_company) return false;

      // J-118: Alias Filter Condition — match against display-level alias (sub-group for laptops)
      if (selectedAlias !== 'All') {
        const displayAlias = getLaptopSubGroup(asset) ?? asset.aliasName;
        if (displayAlias !== selectedAlias) return false;
      }

      if (inventoryCategoryFilter !== 'All') {
        const assetCat = (asset as any).category || getUICategory(asset.type);
        if (assetCat !== inventoryCategoryFilter) return false;
      }

      // Status Filter (Available, In Use, Damaged, Crosscheck, etc.)
      if (inventoryStatusFilter !== 'All') {
        if (asset.status !== inventoryStatusFilter) return false;
      }

      if (purchaseDateFrom) {
        if (!asset.purchasedDate || asset.purchasedDate < purchaseDateFrom) return false;
      }
      if (purchaseDateTo) {
        if (!asset.purchasedDate || asset.purchasedDate > purchaseDateTo) return false;
      }

      if (q) {
        const nameMatch = (asset.aliasName || '').toLowerCase().includes(q);
        const skuMatch = (asset.sku || '').toLowerCase().includes(q);
        const serialMatch = (asset.serialNumber || '').toLowerCase().includes(q);
        const typeMatch = (asset.type || '').toLowerCase().includes(q);
        const barcodeMatch = (asset.barcode || '').toLowerCase().includes(q);
        const venueMatch = (asset.currentVenue || '').toLowerCase().includes(q);
        const confName = (asset.current_conference_name || assetConferenceMap.get(String(asset.id)) || '').toLowerCase();
        const confMatch = confName.includes(q);
        if (!nameMatch && !skuMatch && !serialMatch && !typeMatch && !barcodeMatch && !venueMatch && !confMatch) {
          return false;
        }
      }
      
      return true;
    });

    // 3. Dynamic Sorting based on inventorySortOption
    return filtered.sort((a, b) => {
      if (inventorySortOption === 'oldest') {
        const dateA = new Date(a.createdAt || 0).getTime() || 0;
        const dateB = new Date(b.createdAt || 0).getTime() || 0;
        return dateA - dateB;
      }
      if (inventorySortOption === 'name-asc') {
        const nameA = (a.aliasName || a.sku || '').toLowerCase();
        const nameB = (b.aliasName || b.sku || '').toLowerCase();
        return nameA.localeCompare(nameB);
      }
      if (inventorySortOption === 'sku-asc') {
        const skuA = (a.sku || '').toLowerCase();
        const skuB = (b.sku || '').toLowerCase();
        return skuA.localeCompare(skuB);
      }
      if (inventorySortOption === 'qty-desc') {
        return (b.quantity || 1) - (a.quantity ?? 1);
      }
      if (inventorySortOption === 'price-desc') {
        return (Number(b.itemPrice) || 0) - (Number(a.itemPrice) || 0);
      }
      // Default: newest first
      const dateA = new Date(a.createdAt || 0).getTime() || 0;
      const dateB = new Date(b.createdAt || 0).getTime() || 0;
      return dateB - dateA; // Descending
    });
  }, [assets, inventoryCategoryFilter, selectedAlias, searchQuery, purchaseDateFrom, purchaseDateTo, inventoryStatusFilter, inventorySortOption, assetConferenceMap]);
  const assetUsageHistory = useMemo(() => {
    if (!viewingAsset) return { history: [], timesUsed: 0 };
    
    // Use deployment history from backend if available (includes subrentals)
    if ((viewingAsset as any).deployment_history) {
      const history = (viewingAsset as any).deployment_history;
      return { history, timesUsed: history.length };
    }

    const history: { name: string, date: string }[] = [];
    backendConferences.forEach(c => {
      const allAssigned = [...(c.assets || []), ...(c.crosscheckAssets || [])];
      if (allAssigned.some(id => String(id) === String(viewingAsset.id))) {
        history.push({ name: c.conferenceName || (c as any).name, date: c.startDate });
      }
    });
    // Sort by most recent first
    history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return { history, timesUsed: history.length };
  }, [viewingAsset, backendConferences]);

  const totalInventoryPages = Math.ceil(filteredInventoryAssets.length / itemsPerPage);
  const paginatedInventoryAssets = filteredInventoryAssets.slice(
    (inventoryPage - 1) * itemsPerPage,
    inventoryPage * itemsPerPage
  );

  const [challanSearchQuery, setChallanSearchQuery] = useState('');
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // Upload result banner state
  const [uploadResult, setUploadResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);

  // Scan toast state
  const [scanToast, setScanToast] = useState<{ message: string; type: 'success' | 'warning' | 'error' } | null>(null);

  // QR Label modal state
  const [qrTarget, setQrTarget] = useState<{ id?: string; sku: string; name: string; assetType?: string } | null>(null);

  // Unrecognized Scan Linking state
  const [unrecognizedScan, setUnrecognizedScan] = useState<string | null>(null);
  const [linkingAsset, setLinkingAsset] = useState<Asset | null>(null);
  const [flagMenuAssetId, setFlagMenuAssetId] = useState<string | null>(null);
  // F-3: Cart view expanded-group state
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));

  // Dedicated refs for deduplication (to prevent double-processing on hardware scanners)
  const lastScannedCode = useRef('');
  const lastScannedTime = useRef(0);
  const lastScannedScope = useRef('');

  // Compute true item quantity sum for a conference challan (including multi-quantity assets & consumables)
  const getChallanTotalItemsCount = useCallback((conf: Booking): number => {
    const document = conf.challan_documents?.find(document => document.scope === 'master');
    if (document) return document.lines.reduce((total, line) => total + line.quantity, 0);
    if (hasRecordedQuantities(conf)) {
      const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
      return masterQuantityPreview(conf, pool, 'dispatch').reduce((total, row) => total + row.quantity, 0);
    }
    const targetAssetIds = (conf.challanAssets && conf.challanAssets.length > 0)
      ? conf.challanAssets.map(String)
      : [...(conf.assets || []), ...(conf.staged_assets || [])].map(String);

    if (targetAssetIds.length === 0) return 0;

    const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
    const targetSet = new Set(targetAssetIds);
    let totalQty = 0;
    let matchedCount = 0;

    for (const a of pool) {
      if (targetSet.has(String(a.id))) {
        totalQty += (Number(a.quantity) || 1);
        matchedCount++;
      }
    }

    // Unmatched IDs (e.g. ad-hoc or items not yet loaded in current pool) count as 1 each
    const unmatched = targetAssetIds.length - matchedCount;
    if (unmatched > 0) {
      totalQty += unmatched;
    }

    // Also include consumables if any
    const cData = (conf as any).consumable_data || {};
    Object.values(cData).forEach((item: any) => {
      const q = Number(item?.requested || item?.quantity || 0);
      if (q > 0) totalQty += q;
    });

    return totalQty;
  }, [assets]);

  // Diagnostic Logs
  const [systemLogs, setSystemLogs] = useState<string[]>([]);
  const addLog = (msg: string) => setSystemLogs(prev => [new Date().toLocaleTimeString() + ': ' + msg, ...prev].slice(0, 10));

  const handleSystemRecovery = async () => {
    showScanToast('Recovery requires reviewed maintenance. This control no longer changes database records.', 'error');
  };

  const activeConferencesCount = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return backendConferences.filter(conf => {
      const start = new Date(conf.startDate);
      const end = new Date(conf.endDate);
      return today >= start && today <= end;
    }).length;
  }, [backendConferences]);

  // Fetch business data only after the account identity is ready.
  useEffect(() => {
    if (isLoggedIn && user) fetchConferences();
  }, [isLoggedIn, user?.user_id]);

  // --- CONFERENCE STATE & HANDLERS ---
  const [editingConference, setEditingConference] = useState<Booking | null>(null);
  const [expandedConferenceId, setExpandedConferenceId] = useState<string | number | null>(null);
  const [assetTab, setAssetTab] = useState<'available' | 'assigned' | 'packup' | 'crosscheck'>('available');
  const [conferenceSearchTerm, setConferenceSearchTerm] = useState("");
  const [conferenceStatusFilter, setConferenceStatusFilter] = useState("ALL");
  const [conferenceTypeFilter, setConferenceTypeFilter] = useState<string>("ALL");
  const [conferenceFormData, setConferenceFormData] = useState<any>(() => ({
    name: '',
    association_name: '',
    billing_address: '',
    transport_address: '',
    gst_number: '',
    vehicle_number: '',
    driver_phone: '',
    challan_date: '',
    contact_person: '',
    contact_phone: '',
    contact_email: '',
    start_date: '',
    end_date: '',
    conference_type: 'Medical Conference',
    requirements: [],
    staged_assets: [],
    crosscheck_assets: [],
    assets: [],
    assigned_employees: [],
    pdf_document: null,
    is_audit: false  // J-109: Audit Mode — non-blocking by default
  }));

  const eventFormSealed = (backendConferences.find(event => String(event.id) === String(conferenceFormData.id))?.lifecycle_state || conferenceFormData.lifecycle_state || 'open') !== 'open';
  const eventBaseMetadataRef = useRef('');
  const eventDraftContextRef = useRef<string | null>(null);
  const eventSavingRef = useRef(false);
  const [consumableSaving, setConsumableSaving] = useState(false);
  const [manifestSaving, setManifestSaving] = useState(false);
  const manifestFlightRef = useRef(false);
  const conferenceFormDataRef = useRef(conferenceFormData);
  conferenceFormDataRef.current = conferenceFormData;
  const [eventDraftStorageFailed, setEventDraftStorageFailed] = useState(false);
  const [eventDraftConflict, setEventDraftConflict] = useState(false);
  const currentEventDraftKey = (id: string) => eventDraftKey(window.location.origin, String(user?.user_id || user?.email), id);
  useEffect(() => {
    if (!isLoggedIn || conferenceView !== 'Form' || !eventDraftContextRef.current) return;
    const key = eventDraftContextRef.current;
    setWorkBlocker(key, true);
    try {
      localStorage.setItem(key, JSON.stringify({ schema: 2, baseRevision: conferenceFormData.revision ?? 0,
        form: conferenceFormData, updatedAt: new Date().toISOString() }));
      setEventDraftStorageFailed(false);
    } catch { setEventDraftStorageFailed(true); }
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { setWorkBlocker(key, false); window.removeEventListener('beforeunload', warn); };
  }, [conferenceFormData, conferenceView, isLoggedIn]);
  const loadLatestEventDetails = () => {
    const latest = conferenceSnapshotsRef.current.get(String(conferenceFormData.id));
    if (!latest || !window.confirm('Discard your event-detail draft and load the latest saved details?')) return;
    const form = eventEditorData(latest);
    eventBaseMetadataRef.current = eventMetadata(form);
    setConferenceFormData(form); setEventDraftConflict(false); setPdfFile(null);
  };

  useEffect(() => {
    setWorkBlocker('scan-context', showScanner || showTransferScanner || Boolean(pendingParentAsset) || conferenceView === 'Form');
    return () => setWorkBlocker('scan-context', false);
  }, [showScanner, showTransferScanner, pendingParentAsset, conferenceView]);

  const conferenceSnapshotsRef = useRef<Map<string, Booking>>(new Map());
  const conferenceFetchIdRef = useRef(0);
  const fetchConferences = () => {
    const requestId = ++conferenceFetchIdRef.current;
    const sessionToken = localStorage.getItem('token');
    if (!sessionToken) return Promise.resolve();
    return apiFetch(`${API_BASE}/api/conferences/?_t=${Date.now()}`)
      .then(res => { if (!res.ok) throw new Error(`Conference load failed (${res.status})`); return res.json(); })
      .then(data => {
        if (requestId !== conferenceFetchIdRef.current || sessionToken !== localStorage.getItem('token')) return;
        if (Array.isArray(data)) {
          // Register all embedded asset details from conferences and trucks
          data.forEach((c: any) => {
            if (c.challan_assets_details) {
              registerKnownAssets(c.challan_assets_details);
            }
            if (c.truck_challans_data) {
              c.truck_challans_data.forEach((t: any) => {
                if (t.assets_details) {
                  registerKnownAssets(t.assets_details);
                }
              });
            }
          });

          const mapped = data.map(mapConference);
          const accepted = mapped.map(next => {
            const previous = conferenceSnapshotsRef.current.get(next.id);
            return previous && !acceptRevision(previous.revision, next.revision) ? previous : next;
          });
          conferenceSnapshotsRef.current = new Map(accepted.map(event => [event.id, event]));
          setBackendConferences(accepted);
          setSelectedBookingForChallan(prev => prev ? accepted.find(event => event.id === prev.id) || null : null);
          setSelectedConferenceDetails(prev => prev ? accepted.find(event => event.id === prev.id) || null : null);

          // If in print mode, set the selected booking immediately after fetching
          if (isPrintMode && printConfId) {
            const found = accepted.find((b: { id: string; }) => b.id === printConfId);
            if (found) {
              setSelectedBookingForChallan(found);
            }
          }
        } else {
          console.error("Failed to fetch conferences: Invalid data format", data);
          throw new Error("Conference response is not a complete list");
        }
      })
      .catch(err => console.error("Failed to fetch conferences", err));
  };

  const handleQuickUpdateAsset = async (asset: Asset, updates: Partial<Asset>, conferenceId?: string, stage?: string) => {
    try {
      // Optimistic Update
      setAssets(prev => prev.map(a => a.id === asset.id ? { ...a, ...updates } as Asset : a));

      const payload = { ...updates };
      if (conferenceId) {
        (payload as any).conference_id = conferenceId;
        (payload as any).stage = stage || 'Unknown';
      }

      const res = await apiFetch(`${API_BASE}/api/assets/${asset.id}/`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        showScanToast(`✅ Asset Updated Successfully`, 'success');
        fetchAssets(); // Full refresh to ensure consistency
      } else {
        showScanToast(`⚠️ Failed to update asset status.`, 'error');
        fetchAssets(); // Revert on failure
      }
    } catch (err) {
      console.error("Quick update failed", err);
      showScanToast(`⚠️ Connection error.`, 'error');
    } finally {
      setFlagMenuAssetId(null);
    }
  };



  const handleSaveChallanDocument = async (conferenceId: string, scope: string, payload: import('./types').ChallanSave) => {
    const current = conferenceSnapshotsRef.current.get(String(conferenceId));
    if (current?.truck_manifest && payload.manifest_command) {
      if (scope !== 'master') throw Error('Use the truck quantity panel to change or issue this truck copy.');
      const result = await submitManifestCommand(conferenceId, 'save_master', { request_id: payload.request_id }, payload.manifest_command);
      return result.document as import('./types').ChallanDocument;
    }
    const sessionToken = localStorage.getItem('token');
    const response = await apiFetch(`${API_BASE}/api/conferences/${conferenceId}/challan-documents/${scope}/`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || `Challan save failed (${response.status})`) as Error & { definitive: boolean };
      error.definitive = [400, 403, 404, 409, 428].includes(response.status);
      throw error;
    }
    if (localStorage.getItem('token') !== sessionToken) throw new Error('Account changed before save confirmation. Reopen the original account to confirm it.');
    applyMovementReceipt(result);
    return result.document as import('./types').ChallanDocument;
  };





  

  // ─── Multi-Truck Challan Handlers ──────────────────────────────
  const handleAddTruck = async (conferenceId: string) => {
    const current = conferenceSnapshotsRef.current.get(String(conferenceId));
    if (current?.truck_manifest || (current?.challan_documents?.some(doc => doc.scope === 'master') && !current.truckChallans?.length)) {
      try { await submitManifestCommand(conferenceId, current.truck_manifest ? 'add' : 'start'); }
      catch (error) { showScanToast((error as Error).message, 'error'); }
      return;
    }
    try {
      const activeMasterAssetIds = selectedBookingForChallan
        ? (
            (selectedBookingForChallan.challanAssets && selectedBookingForChallan.challanAssets.length > 0)
              ? selectedBookingForChallan.challanAssets
              : [...(selectedBookingForChallan.assets || []), ...(selectedBookingForChallan.staged_assets || [])]
          ).map(id => parseInt(String(id), 10)).filter(id => !isNaN(id))
        : [];

      const res = await apiFetch(`${API_BASE}/api/conferences/${conferenceId}/trucks/`, {
        method: 'POST',
        body: JSON.stringify({ asset_ids: activeMasterAssetIds, expected_revision: selectedBookingForChallan?.revision ?? 0 }),
      });
      if (res.ok) {
        const data = await res.json();
        const mappedTrucks: TruckChallan[] = (data || []).map((t: any) => ({
          id: String(t.id),
          conference: String(t.conference),
          truck_number: t.truck_number,
          label: t.label || `Truck ${t.truck_number}`,
          vehicle_number: t.vehicle_number || '',
          driver_phone: t.driver_phone || '',
          challan_number: t.challan_number || '',
          assets: (t.assets || []).map(String),
          asset_quantities: t.asset_quantities || {},
          assets_details: t.assets_details || [],
          created_at: t.created_at || '',
        }));
        setSelectedBookingForChallan(prev => prev ? { ...prev, truckChallans: mappedTrucks } : null);
        if (mappedTrucks.length > 0) {
          const latestTruck = mappedTrucks[mappedTrucks.length - 1];
          setActiveTruckChallanId(latestTruck.id);
          setPackingTargetTruckId(latestTruck.id);
        }
        showScanToast('✅ Truck added successfully', 'success');
        fetchConferences();
      } else {
        showScanToast('❌ Failed to add truck', 'error');
      }
    } catch (err) {
      console.error("Failed to add truck", err);
      showScanToast('❌ Network error adding truck', 'error');
    }
  };

  const handleDeleteAllTrucks = async (anyTruckId: string, conferenceId: string) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/truck-challans/${anyTruckId}/`, {
        method: 'DELETE',
        body: JSON.stringify({ expected_revision: selectedBookingForChallan?.revision ?? conferenceSnapshotsRef.current.get(String(conferenceId))?.revision ?? 0 }),
      });
      if (res.ok) {
        showScanToast('✅ Trucks cleared — back to single main challan', 'success');
        setSelectedBookingForChallan(prev => prev ? { ...prev, truckChallans: [] } : null);
        setActiveTruckChallanId(null);
        fetchConferences();
      } else {
        showScanToast('❌ Failed to delete trucks', 'error');
      }
    } catch (err) {
      console.error("Failed to delete trucks", err);
      showScanToast('❌ Network error deleting trucks', 'error');
    }
  };

  const handleUpdateTruck = async (truckId: string, updates: { vehicle_number?: string; driver_phone?: string; label?: string; assets?: string[] | number[]; challan_number?: string; asset_quantities?: Record<string, number>; expected_revision?: number }, expectedRevision?: number) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/truck-challans/${truckId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ ...updates, expected_revision: expectedRevision ?? updates.expected_revision ?? selectedBookingForChallan?.revision ?? 0 }),
      });
      if (res.status === 409) await fetchConferences();
      if (res.ok) {
        const updated = await res.json();
        if (updated.conference) applyMovementReceipt({ conference: updated.conference });
        showScanToast('✅ Truck details updated', 'success');
        return updated.conference_revision;
      } else {
        showScanToast('❌ Failed to update truck details', 'error');
        throw new Error(`Truck save failed (${res.status})`);
      }
    } catch (err) {
      console.error("Failed to update truck details", err);
      showScanToast('❌ Network error updating truck', 'error');
      throw err;
    }
  };

  const handleTransferToTruck = async (
    fromTruckId: string,
    toTruckId: string,
    transfersOrIds: { asset_id: number; quantity: number }[] | string[]
  ) => {
    try {
      const isStructured = transfersOrIds.length > 0 && typeof transfersOrIds[0] === 'object';
      const bodyData = isStructured
        ? {
            to_truck_id: parseInt(toTruckId, 10),
            transfers: transfersOrIds,
          }
        : {
            to_truck_id: parseInt(toTruckId, 10),
            asset_ids: (transfersOrIds as string[]).map(id => parseInt(id, 10)),
          };

      const result = await getMovementOutbox().enqueueTruck(String(selectedBookingForChallan?.id), fromTruckId, bodyData);
      {
        setSelectedBookingForChallan(prev => {
          if (!prev || !prev.truckChallans) return prev;
          return {
            ...prev,
            truckChallans: prev.truckChallans.map(t => {
              if (t.id === fromTruckId) {
                return {
                  ...t,
                  assets: (result.source.assets || []).map(String),
                  asset_quantities: result.source.asset_quantities || {},
                  assets_details: result.source.assets_details || t.assets_details,
                };
              }
              if (t.id === toTruckId) {
                return {
                  ...t,
                  assets: (result.dest.assets || []).map(String),
                  asset_quantities: result.dest.asset_quantities || {},
                  assets_details: result.dest.assets_details || t.assets_details,
                };
              }
              return t;
            }),
          };
        });

        showScanToast('✅ Items transferred successfully', 'success');
      }
    } catch (err) {
      console.error("Failed to transfer items", err);
      showScanToast('❌ Network error transferring items', 'error');
    } finally {
      setPendingMovementCount(getMovementOutbox().pending().length);
    }
  };

  const handleSaveSubrentalCompany = async () => {
    try {
      const method = editingSubrentalId ? 'PATCH' : 'POST';
      const url = editingSubrentalId 
        ? `${API_BASE}/api/subrental-companies/${editingSubrentalId}/`
        : `${API_BASE}/api/subrental-companies/`;
      
      const res = await apiFetch(url, {
        method,
        body: JSON.stringify(subrentalFormData)
      });
      
      if (res.ok) {
        setIsSubrentalFormOpen(false);
        setSubrentalFormData({ name: '', address: '', gst_number: '' });
        setEditingSubrentalId(null);
        fetchSubrentalCompanies();
        showScanToast(`✅ Company ${editingSubrentalId ? 'Updated' : 'Created'} Successfully`, 'success');
      }
    } catch (err) {
      console.error("Failed to save subrental company", err);
      showScanToast(`❌ Failed to save company`, 'error');
    }
  };

  const handleDeleteSubrentalCompany = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this company? All associated inventory will be removed.")) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/subrental-companies/${id}/`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        await res.json();
        showScanToast('This supplier has protected or unverified event history. Nothing was deleted; review its returns and records before removal.', 'error');
        return;
      }
      if (res.ok) {
        fetchSubrentalCompanies();
        showScanToast(`✅ Company Deleted`, 'success');
      }
    } catch (err) {
      console.error("Failed to delete company", err);
      showScanToast("Supplier removal could not be confirmed. Reload its records before trying again.", "error");
    }
  };



  const handlePrintAsset = async (assetId: string, sku: string) => {
    if (sku === GLOBAL_CONSUMABLES_SKU) return; // Skip for global QR
    
    try {
      const res = await apiFetch(`${API_BASE}/api/assets/${assetId}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_barcode_added: true,
          qr_code: sku,
          barcode: sku // Fallback barcode as well
        })
      });
      if (res.ok) {
        console.log(`Asset ${assetId} marked as QR-assigned.`);
        fetchAssets(); // Sync local state
      }
    } catch (err) {
      console.error("Failed to mark asset as QR-assigned", err);
    }
  };

  const handleSaveConference = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (eventSavingRef.current) return;
    if (eventDraftConflict) { showScanToast('Load the latest event details and compare your draft before saving.', 'error'); return; }
    if (editingConference && JSON.stringify(conferenceFormData.consumable_data || {}) !== JSON.stringify(conferenceSnapshotsRef.current.get(String(editingConference.id))?.consumable_data || {})) {
      void handleSaveConsumables('save'); return;
    }
    eventSavingRef.current = true;
    const savedDraftKey = eventDraftContextRef.current;
    const url = editingConference
      ? `${API_BASE}/api/conferences/${editingConference.id}/`
      : `${API_BASE}/api/conferences/`;

    const method = editingConference ? 'PUT' : 'POST';
    const token = localStorage.getItem('token');

    // Coerce IDs to integers and handle empty strings for optional fields
    const payload = {
      ...conferenceFormData,
      start_date: conferenceFormData.start_date || null,
      end_date: conferenceFormData.end_date || null,
      challan_date: conferenceFormData.challan_date || null,
      assets: (conferenceFormData.assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
      requirements: (conferenceFormData.requirements || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
      staged_assets: (conferenceFormData.staged_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
      crosscheck_assets: (conferenceFormData.crosscheck_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
      assigned_employees: (conferenceFormData.assigned_employees || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id))
    };

    const isFormData = !!pdfFile;
    let body: any;

    if (isFormData) {
      body = new FormData();
      Object.entries(payload).forEach(([key, value]) => {
        if (key === 'pdf_document' && pdfFile) return; // Skip old URL string if we have a new file
        if (Array.isArray(value)) {
          body.append(key, JSON.stringify(value));
        } else if (value !== null && value !== undefined) {
          body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      });
      if (pdfFile) {
        body.append('pdf_document', pdfFile);
      }
    } else {
      body = JSON.stringify(payload);
    }

    apiFetch(url, {
      method: method,
      body: body
    })
      .then(async res => {
        if (res.ok) {
          const savedData = await res.json();
          if (savedDraftKey) localStorage.removeItem(savedDraftKey);
          eventDraftContextRef.current = null;
          if (savedData && savedData.id) {
            const mappedNew: Booking = mapConference(savedData);
            setBackendConferences(prev => {
              const exists = prev.some(c => c.id === mappedNew.id);
              if (exists) {
                return prev.map(c => c.id === mappedNew.id ? mappedNew : c);
              }
              return [mappedNew, ...prev];
            });
          }
          fetchConferences();
          fetchAssets();
          setConferenceView('List');
          setScanToast({ message: "Conference saved successfully!", type: 'success' });
          setPdfFile(null); // Clear pending file
          setEditingConference(null);
          setConferenceFormData({
            name: '', association_name: '', billing_address: '', transport_address: '', gst_number: '',
            vehicle_number: '', driver_phone: '', challan_date: '',
            contact_person: '', contact_phone: '', contact_email: '', start_date: '', end_date: '', conference_type: 'Medical Conference', 
            assets: [], requirements: [], staged_assets: [], crosscheck_assets: [], assigned_employees: [], pdf_document: null
          });
          setPdfFile(null);
          setAssetTab((user?.role === 'technician' || user?.role === 'godown_incharge' || user?.role === 'accounts') ? 'assigned' : 'available'); // Smart default tab
        } else {
          if (res.status === 409) { setEventDraftConflict(true); await fetchConferences(); }
          const errData = await res.json().catch(() => ({}));
          alert(`Failed to save conference. Status: ${res.status}\n${JSON.stringify(errData)}`);
        }
      })
      .catch(err => alert(`Event not confirmed as saved: ${err}`))
      .finally(() => { eventSavingRef.current = false; });
  };

  const handleDeleteConference = (id: string) => {
    if (!confirm("Are you sure you want to delete this conference?")) return;
    apiFetch(`${API_BASE}/api/conferences/${id}/`, {
      method: 'DELETE'
    }).then(res => {
      if (res.ok) {
        fetchConferences();
        fetchAssets(); // Refresh asset statuses — deleted conf releases its assets
      } else {
        alert("Failed to delete conference.");
      }
    });
  };

  const handleDeleteChallan = (challanId: string) => {
    if (!window.confirm("Are you absolutely sure you want to permanently delete this Delivery Challan? This cannot be undone.")) return;
    apiFetch(`${API_BASE}/api/conferences/${challanId}/`, {
      method: 'DELETE'
    }).then(res => {
      if (res.ok) {
        fetchConferences();
        fetchAssets(); // Refresh asset statuses
        alert("Challan deleted successfully.");
      } else {
        alert("Failed to delete challan.");
      }
    });
  };

  const handleToggleInvoiced = async (confId: string, currentStatus: boolean) => {
    if (invoicingId === confId) return;
    setInvoicingId(confId);
    const newStatus = !currentStatus;

    // Optimistic UI update
    setBackendConferences(prev => prev.map(c => c.id === confId ? { ...c, is_invoiced: newStatus, isInvoiced: newStatus } : c));
    setSelectedBookingForChallan(prev => prev && prev.id === confId ? { ...prev, is_invoiced: newStatus, isInvoiced: newStatus } : prev);

    try {
      const res = await apiFetch(`${API_BASE}/api/conferences/${confId}/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_invoiced: newStatus })
      });
      if (!res.ok) {
        throw new Error(`Server responded with status ${res.status}`);
      }
    } catch (err) {
      console.error('Error toggling invoice status:', err);
      // Revert optimistic update
      setBackendConferences(prev => prev.map(c => c.id === confId ? { ...c, is_invoiced: currentStatus, isInvoiced: currentStatus } : c));
      setSelectedBookingForChallan(prev => prev && prev.id === confId ? { ...prev, is_invoiced: currentStatus, isInvoiced: currentStatus } : prev);
      alert('Failed to update invoice status. Please check your network connection and try again.');
    } finally {
      setInvoicingId(null);
    }
  };

  const handleUpdateLogistics = (settle = false) => {
    if (settle && Object.values(conferenceFormData.consumable_data || {}).some((value: any) => Number(value?.requested || 0) > 0 && value.status !== 'settled')) {
      void handleSaveConsumables('settle'); return;
    }
    handleSaveConference();
  };

  // ── Asset Transfer Handler ──────────────────────────────────────────────
  const handleAssetTransfer = async () => {
    const sourceId = conferenceFormData.id;
    if (!sourceId) return;
    const fromAddress = backendConferences.find(c => c.id === String(sourceId))?.transportAddress || '';
    if (!fromAddress.trim() || fromAddress !== conferenceFormData.transport_address) {
      alert('Save this program’s delivery address before transferring equipment. It will be recorded as the dispatch venue.');
      return;
    }
    if (transferSelectedIds.size === 0) {
      alert('Please select at least one asset to transfer.');
      return;
    }
    if (!transferTargetConfId) {
      alert('Please select a destination conference.');
      return;
    }

    const targetConf = backendConferences.find(c => c.id === transferTargetConfId);
    const assetNames = Array.from(transferSelectedIds).map(id => {
      const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
      const a = pool.find(x => String(x.id) === id);
      return a?.aliasName || a?.sku || `#${id}`;
    });

    const confirmed = window.confirm(
      `⚠️ ASSET TRANSFER CONFIRMATION\n\n` +
      `You are about to transfer ${transferSelectedIds.size} item(s):\n` +
      assetNames.join(', ') + `\n\n` +
      `FROM: ${fromAddress}\n` +
      `TO:   ${targetConf?.conferenceName || targetConf?.name || 'Selected Conference'}\n\n` +
      `This will:\n` +
      `• Freeze the current dispatch challan (if not already frozen)\n` +
      `• Remove these items from THIS conference's Packup list\n` +
      `• Add them to the destination conference's Packup list\n\n` +
      `This action CANNOT be undone. Proceed?`
    );
    if (!confirmed) return;

    setTransferring(true);
    try {
      const receipt = await getMovementOutbox().enqueue(String(sourceId), 'transfer', Array.from(transferSelectedIds).map(Number),
        fromAddress, Number(transferTargetConfId));
      const data = { success: true, source_conference: receipt.conference, target_conference: receipt.target_conference, transferred_count: receipt.asset_ids.length };
      {
        const src = data.source_conference;
        setConferenceFormData((prev: any) => ({
          ...prev,
          assets: (src.assets || []).map(String),
          challan_assets: (src.challan_assets || []).map(String),
          transfer_log: src.transfer_log || []
        }));

        setBackendConferences(prev => prev.map(c => {
          if (c.id === String(src.id)) {
            return {
              ...c,
              assets: (src.assets || []).map(String),
              challanAssets: (src.challan_assets || []).map(String),
              transfer_log: src.transfer_log || []
            };
          }
          if (c.id === String(data.target_conference.id)) {
            const tgt = data.target_conference;
            return {
              ...c,
              assets: (tgt.assets || []).map(String),
              transfer_log: tgt.transfer_log || []
            };
          }
          return c;
        }));

        setShowTransferModal(false);
        setTransferSelectedIds(new Set());
        setTransferTargetConfId('');
        setTransferScanInput('');

        setScanToast({ message: `✅ Transferred ${data.transferred_count} item(s) to ${targetConf?.conferenceName || targetConf?.name}`, type: 'success' });
        setTimeout(() => { fetchConferences(); fetchAssets(); }, 500);
      }
    } catch (err) {
      console.error('Asset transfer network error:', err);
      alert(`❌ Network error during transfer.\n\n${err}`);
    } finally {
      setPendingMovementCount(getMovementOutbox().pending().length);
      setTransferring(false);
    }
  };

  const openNewConferenceForm = () => {
    fetchAssets();      // Always get fresh statuses before interacting with conference
    fetchConferences(); // Refresh backend conference data too
    setEditingConference(null);
    setAssetTab((user?.role === 'technician' || user?.role === 'godown_incharge' || user?.role === 'accounts') ? 'assigned' : 'available'); // Smart default tab
    setConferenceFormData({
      name: '', association_name: '', billing_address: '', transport_address: '', gst_number: '',
      vehicle_number: '', driver_phone: '', challan_date: '',
      contact_person: '', contact_phone: '', contact_email: '', start_date: '', end_date: '', conference_type: 'Medical Conference',
      assets: [], requirements: [], staged_assets: [], crosscheck_assets: [], assigned_employees: [], pdf_document: null
    });
    const key = currentEventDraftKey('new');
    const draft = readEventDraft(localStorage, key);
    eventDraftContextRef.current = key; eventBaseMetadataRef.current = '';
    if (draft) setConferenceFormData(draft.form);
    setEventDraftConflict(false);
    setConferenceView('Form');
  };



  const openEditConferenceForm = (conf: any) => {
    fetchAssets();      // Always get fresh statuses before interacting with conference
    fetchConferences(); // Refresh backend conference data too
    fetchEmployees();   // Ensure technician names are loaded
    setEditingConference(conf);
    setAssetTab((user?.role === 'technician' || user?.role === 'godown_incharge' || user?.role === 'accounts') ? 'assigned' : 'available'); // Reset to default tab based on role
    const canonical = eventEditorData(conf);
    const key = currentEventDraftKey(String(conf.id));
    const draft = readEventDraft(localStorage, key);
    eventDraftContextRef.current = key;
    eventBaseMetadataRef.current = eventMetadata(canonical);
    setEventDraftConflict(Boolean(draft && draft.baseRevision !== canonical.revision));
    setConferenceFormData(draft ? { ...canonical, ...draft.form, id: String(conf.id), revision: draft.baseRevision } : canonical);

    setConferenceView('Form');
    setCurrentPage('Conferences');
  };

  // Stats derived from total assets (summing quantities)
  const stats = useMemo(() => {
    if (dashboardStats) {
      return { 
        total: dashboardStats.total || 0, 
        inUse: dashboardStats.in_use || 0, 
        available: dashboardStats.ready || 0, 
        damaged: dashboardStats.maintenance || 0 
      };
    }
    // Never present a filtered inventory page as the global warehouse total.
    return { total: null, inUse: null, available: null, damaged: null };
  }, [dashboardStats]);

  // Bar Graph Data: Status Situation
  const statusData = useMemo(() => [
    { name: 'Available', value: stats.available, fill: '#10b981' },
    { name: 'In Use', value: stats.inUse, fill: '#f97316' },
    { name: 'Needs service', value: stats.damaged, fill: '#ef4444' }
  ], [stats]);

  // Scroll Logic & Effect
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;

    const handleScroll = () => {
      setShowScrollTop(main.scrollTop > 400);
    };

    main.addEventListener('scroll', handleScroll);
    return () => main.removeEventListener('scroll', handleScroll);
  }, []);

  // Capture/Restore Scroll for Assets List
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;

    if (currentPage === 'Assets' && assetView === 'List') {
      // Restore scroll position
      main.scrollTo({ top: inventoryScrollPos.current, behavior: 'instant' as ScrollBehavior });
    } else if (currentPage === 'Assets' && (assetView === 'Details' || assetView === 'Form')) {
      // Don't reset scroll if moving within Assets (already handled by capture)
    } else {
      // Reset scroll for other pages
      main.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
  }, [currentPage, assetView]);

  // Capture scroll position before leaving List view
  const handleViewChange = (newPage: Page, newAssetView: AssetView = 'List') => {
    if (currentPage === 'Assets' && assetView === 'List' && mainRef.current) {
      inventoryScrollPos.current = mainRef.current.scrollTop;
    }
    setCurrentPage(newPage);
    setAssetView(newAssetView);
    setEmployeeView('List');
    setIsMobileMenuOpen(false);
  };

  const openAssetDetails = (asset: Asset) => {
    if (mainRef.current) inventoryScrollPos.current = mainRef.current.scrollTop;
    setViewingAsset(asset);
    setAssetView('Details');
  };

  // Pie Chart Data: Equipment Categories
  const categoryData = useMemo(() => {
    const palette = ['#00AEEF', '#F15A24', '#8b5cf6', '#ec4899', '#64748b'];
    return Object.values(AssetCategory).map((cat, i) => ({
      name: cat,
      value: assets.filter(a => a.type === cat).length,
      color: palette[i % palette.length]
    })).filter(c => c.value > 0);
  }, [assets]);

  // Bar Chart Data: Categories (previously brands)
  const typeData = useMemo(() => {
    const types: Record<string, number> = {};
    assets.forEach(a => {
      const t = a.type || 'Other';
      types[t] = (types[t] || 0) + 1;
    });
    return Object.entries(types)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [assets]);

  // Pie Chart Data: Conditions
  const conditionData = useMemo(() => {
    const conditions: Record<string, number> = {};
    assets.forEach(a => {
      const c = a.condition || 'Unknown';
      conditions[c] = (conditions[c] || 0) + 1;
    });
    const palette = ['#10b981', '#f59e0b', '#ef4444', '#64748b'];
    return Object.entries(conditions).map(([name, value], i) => ({
      name,
      value,
      color: palette[i % palette.length]
    }));
  }, [assets]);

  const showScanToast = (message: string, type: 'success' | 'warning' | 'error') => {
    setScanToast({ message, type });
    setTimeout(() => setScanToast(null), 3500);
  };

  const normalizeId = (id: string) => (id || '').toString().toUpperCase().replace(/[^A-Z0-9#\-_.]/g, '');

  // PDA & Scanner Focus Management
  useEffect(() => {
    if (currentPage === 'Assets' && assetView === 'List' && !viewingAsset) {
      inventorySearchRef.current?.focus();
    }
    if (currentPage === 'Conferences' && conferenceView === 'Form') {
      if (assetTab === 'available') quickAddRef.current?.focus();
      else if (assetTab === 'assigned') quickRemoveRef.current?.focus();
    }
  }, [currentPage, assetView, assetTab, conferenceView, viewingAsset]);

  const findAssetFromScan = (decodedText: string) => {
    const pool = [...allAssetsRef.current, ...assets];
    const result = resolveScan(decodedText, pool);
    if (result.kind === 'matched') return result.asset;
    if (result.kind === 'ambiguous') showScanToast('This code matches multiple items. Ask the warehouse manager to resolve the duplicate identifier.', 'error');
    return null;
  };

  const movementOutboxesRef = useRef(new Map<string, MovementOutbox>());
  const [pendingMovementCount, setPendingMovementCount] = useState(0);
  const applyMovementReceipt = (receipt: any) => {
    if (Array.isArray(receipt.asset_states)) {
      const states = new Map<string, Asset>(receipt.asset_states.map((raw: any) => { const asset = mapRawAsset(raw); return [asset.id, asset]; }));
      scanFetchIdRef.current++; searchRequestIdRef.current++;
      setAssets(prev => prev.map(asset => states.get(asset.id) || asset));
      allAssetsRef.current = allAssetsRef.current.map(asset => states.get(asset.id) || asset);
      states.forEach((asset, id) => knownAssetsMapRef.current.set(id, asset));
    }
    for (const raw of [receipt.conference, receipt.target_conference].filter(Boolean)) {
      const next = mapConference(raw);
      const previous = conferenceSnapshotsRef.current.get(next.id);
      if (previous && !acceptRevision(previous.revision, next.revision)) continue;
      conferenceSnapshotsRef.current.set(next.id, next); conferenceFetchIdRef.current++;
      setBackendConferences(prev => prev.map(old => old.id === next.id ? next : old));
      setSelectedBookingForChallan(prev => prev?.id === next.id ? next : prev);
      setSelectedConferenceDetails(prev => prev?.id === next.id ? next : prev);
      const metadataUnchanged = eventBaseMetadataRef.current === eventMetadata(eventEditorData(next));
      setConferenceFormData((prev: any) => String(prev.id || '') === next.id ? {
        ...prev, revision: metadataUnchanged ? next.revision : prev.revision, assets: next.assets, requirements: next.requirements,
        staged_assets: next.staged_assets, crosscheck_assets: next.crosscheckAssets,
        challan_assets: next.challanAssets,
        quantity_allocations: next.quantity_allocations,
      } : prev);
    }
  };
  const getMovementOutbox = () => {
    const key = `tt:movement:2:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(String(user?.user_id || user?.email))}`;
    let outbox = movementOutboxesRef.current.get(key);
    if (!outbox) {
      const queueSession = localStorage.getItem('token');
      const assertQueueSession = () => { if (!queueSession || queueSession !== localStorage.getItem('token')) throw new Error('Sign in again to retry your saved movements'); };
      outbox = new MovementOutbox(key, localStorage, async operation => {
        assertQueueSession();
        if (operation.endpoint && !/^\/api\/truck-challans\/\d+\/transfer\/$/.test(operation.endpoint) && operation.endpoint !== `/api/conferences/${operation.eventId}/quantity-commands/` && operation.endpoint !== `/api/conferences/${operation.eventId}/consumable-commands/` && operation.endpoint !== `/api/conferences/${operation.eventId}/manifest-commands/`) throw new Error('Invalid saved movement route');
        const endpoint = operation.endpoint || `/api/conferences/${operation.eventId}/asset-commands/`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response: Response;
        try { response = await apiFetch(`${API_BASE}${endpoint}`, {
          method: 'POST', body: JSON.stringify(operation.payload), signal: controller.signal,
        }); } finally { clearTimeout(timeout); }
        const result = await response.json();
        if (!response.ok) {
          const ErrorType = [400, 403, 404, 409, 428].includes(response.status) && result.error !== 'request_id_reused' ? RejectedMovement : Error;
          const sourceMessages: Record<string, string> = { external_rental_uses_supplier_balance: 'This is an external rental. Record its receipt or return in the supplier ticket.', supplier_inventory_classification_required: 'This supplier inventory needs shared-godown classification before new quantity movements.', supplier_ticket_quantity_requires_review: 'This stock also has supplier order history. Review those quantities before reserving it.' };
          throw new ErrorType(`${sourceMessages[result.error] || result.error || 'Movement rejected'}${result.conflicts?.length ? ': ' + result.conflicts.map((item: any) => `${item.asset_id} ${item.reason}`).join(', ') : ''}`);
        }
        return result;
      }, async result => { assertQueueSession(); if (result.operation === 'consumable') await publishConsumableReceipt(result, assertQueueSession); else applyMovementReceipt(result); });
      movementOutboxesRef.current.set(key, outbox);
    }
    return outbox;
  };
  const publishConsumableReceipt = async (receipt: any, assertSession: () => void) => {
    const snapshot = conferenceFormDataRef.current;
    const signature = eventMetadata(snapshot);
    const hash = await consumableDraftHash(snapshot);
    assertSession();
    const next = mapConference(receipt.conference);
    const latest = conferenceSnapshotsRef.current.get(next.id);
    const canPublish = String(snapshot.id) === next.id && hash === receipt.client_draft_hash && (!latest || acceptRevision(latest.revision, next.revision));
    applyMovementReceipt(receipt);
    if (canPublish && eventMetadata(conferenceFormDataRef.current) === signature) {
      eventBaseMetadataRef.current = eventMetadata(eventEditorData(next));
      setConferenceFormData((prev: any) => String(prev.id) === next.id && eventMetadata(prev) === signature ? eventEditorData(next) : prev);
      setEventDraftConflict(false);
    } else if (String(conferenceFormDataRef.current.id) === next.id) {
      setEventDraftConflict(true);
      showScanToast('Consumable save confirmed. Newer edits remain in your draft; compare with the latest event before saving again.', 'warning');
    }
    if (receipt.replayed) { void fetchConferences(); fetchAssets(); }
  };
  const handleSaveConsumables = async (action: 'save' | 'dispatch' | 'settle') => {
    if (eventSavingRef.current) return;
    if (eventDraftConflict) { showScanToast('Compare the event draft with the latest saved details before saving consumables.', 'warning'); return; }
    const form = conferenceFormDataRef.current;
    const eventId = String(form.id || '');
    const canonical = conferenceSnapshotsRef.current.get(eventId);
    if (!canonical || !eventId) { showScanToast('Save the event before reserving consumables.', 'warning'); return; }
    if (pdfFile) { showScanToast('Clear the PDF selection, save consumables, then select the PDF again and save the event.', 'warning'); return; }
    eventSavingRef.current = true; setConsumableSaving(true);
    let outbox: MovementOutbox | undefined;
    try {
      outbox = getMovementOutbox();
      if (outbox.pending().length) throw Error('Confirm the saved movement queue before changing consumables.');
      const payload = await consumablePayload(action, form, canonical, user?.role || '');
      setPendingMovementCount(1);
      await outbox.enqueueConsumable(eventId, payload);
      showScanToast(action === 'settle' ? 'Consumable settlement confirmed.' : action === 'dispatch' ? 'Consumables dispatched.' : 'Consumable quantities and event details saved.', 'success');
    } catch (error) { showScanToast(`Consumable save not confirmed: ${(error as Error).message}`, 'error'); }
    finally {
      eventSavingRef.current = false; setConsumableSaving(false);
      try { setPendingMovementCount(outbox?.pending().length || 0); } catch { setPendingMovementCount(1); }
    }
  };
  const submitManifestCommand = async (eventId: string, action: string, fields: Record<string, any> = {}, prepared?: Record<string, any>) => {
    if (manifestFlightRef.current) throw Error('A truck command is already saving.');
    const current = conferenceSnapshotsRef.current.get(String(eventId));
    if (!current) throw Error('Reload the saved event before changing truck quantities.');
    manifestFlightRef.current = true; setManifestSaving(true);
    let outbox: MovementOutbox | undefined;
    try {
      outbox = getMovementOutbox();
      if (outbox.pending().some(record => record.payload.request_id !== fields.request_id)) throw Error('Confirm the pending movement queue before changing trucks.');
      setPendingMovementCount(1);
      const result = await outbox.enqueueManifest(String(eventId), prepared || manifestCommand(current, action, fields));
      showScanToast('Truck manifest confirmed.', 'success'); return result;
    } catch (error) {
      if (error instanceof RejectedMovement) (error as Error & { definitive?: boolean }).definitive = true;
      throw error;
    } finally {
      manifestFlightRef.current = false; setManifestSaving(false);
      try { setPendingMovementCount(outbox?.pending().length || 0); } catch { setPendingMovementCount(1); }
    }
  };
  useEffect(() => {
    if (!user) { setPendingMovementCount(0); return; }
    try { setPendingMovementCount(getMovementOutbox().pending().length); }
    catch { showScanToast('The saved movement queue needs review before scanning.', 'error'); }
  }, [user?.user_id]);
  useEffect(() => {
    const key = `movement:${user?.user_id}`;
    setWorkBlocker(key, pendingMovementCount > 0);
    return () => setWorkBlocker(key, false);
  }, [pendingMovementCount, user?.user_id]);
  const retryPendingMovements = async () => {
    const outbox = getMovementOutbox();
    try { await outbox.flush(); showScanToast('✅ Pending movements confirmed', 'success'); }
    catch (error) { showScanToast(`Pending movements: ${(error as Error).message}`, 'error'); }
    finally { setPendingMovementCount(outbox.pending().length); }
  };
  const prepareOfflineEvent = async (id: number) => {
    const response = await apiFetch(`${API_BASE}/api/conferences/${id}/offline-package/`);
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Offline data could not be prepared.');
    return data;
  };
  const queueOfflineAsset = async (eventId: number, assetId: number) => {
    const session = localStorage.getItem('token');
    if (!session) throw Error('Sign in as the original account before scanning.');
    const outbox = getMovementOutbox();
    try { return await outbox.queueOfflineStage(String(eventId), assetId); }
    finally { if (session === localStorage.getItem('token')) setPendingMovementCount(outbox.pending().length); }
  };
  const submitAssetCommand = async (action: string, ids: string[]) => {
    const eventId = String(editingConference?.id || conferenceFormData.id || '');
    if (!eventId) { showScanToast('Save the event details before scanning equipment.', 'warning'); return false; }
    const outbox = getMovementOutbox();
    try {
      setPendingMovementCount(outbox.pending().length + 1);
      await outbox.enqueue(eventId, action, ids.map(Number));
      showScanToast('✅ Movement saved', 'success');
      return true;
    } catch (error) {
      showScanToast(`Movement not confirmed: ${(error as Error).message}`, 'error');
      return false;
    } finally { setPendingMovementCount(outbox.pending().length); }
  };
  const conferenceMovementAction = (action: 'add' | 'remove' | 'unassign' | 'verify_crosscheck') => {
    if (conferenceFormData.is_audit) return action === 'add' ? 'audit_observe' : 'audit_remove';
    if (action === 'verify_crosscheck') return 'verify_return';
    if (action === 'add') return user?.role === 'technician' ? 'require' : 'stage';
    if (action === 'remove') return 'return';
    return user?.role === 'technician' ? 'unrequire' : 'unstage';
  };
  const openQuantityAction = (asset: Asset, action: string) => {
    const limit = quantityLimit(asset, conferenceFormData, action);
    if (!limit) { showScanToast('No units available for this action. Older allocations may need warehouse reconciliation.', 'warning'); return; }
    setQuantityAction(action); setQuantityAsset(asset); setSelectedQuantity(1); setShowQuantityModal(true);
  };
  const submitQuantityCommand = async (payload: Record<string, any>): Promise<boolean> => {
    if (quantityFlightRef.current) return false;
    const eventId = String(conferenceFormData.id || '');
    if (!eventId) { showScanToast('Save the event before allocating stock.', 'warning'); return false; }
    let outbox: MovementOutbox;
    try {
      outbox = getMovementOutbox();
      if (outbox.pending().length) { showScanToast('Confirm the saved movement queue before changing quantities.', 'warning'); return false; }
    } catch (error) { showScanToast(`Saved quantities need review: ${(error as Error).message}`, 'error'); return false; }
    quantityFlightRef.current = true; setQuantitySaving(true);
    try {
      setPendingMovementCount(1);
      await outbox.enqueueQuantity(eventId, payload);
      showScanToast('Quantity movement saved.', 'success'); return true;
    } catch (error) {
      showScanToast(`Quantity not confirmed: ${(error as Error).message}`, 'error'); return false;
    } finally {
      quantityFlightRef.current = false; setQuantitySaving(false); setPendingMovementCount(outbox.pending().length);
    }
  };
  const submitStagedDispatch = async () => {
    const ids = (conferenceFormData.staged_assets || []).map(String);
    if (conferenceFormData.is_audit) { await submitAssetCommand('audit_observe', ids); return; }
    try {
      const payload = dispatchQuantities(conferenceFormData, [...allAssetsRef.current, ...assets]);
      if (payload.items.length) await submitQuantityCommand(payload);
      else await submitAssetCommand('dispatch', ids);
    } catch (error) { showScanToast((error as Error).message, 'error'); }
  };
  const triggerAssetConferenceAction = (asset: Asset, action: 'add' | 'remove' | 'unassign', qty = 1) => {
    if (user?.role === 'accounts') { showScanToast('Accounts cannot move equipment.', 'error'); return; }
    if (asset.stock_kind === 'led_case') {
      setLedCasePicker({asset, action: conferenceMovementAction(action)}); return;
    }
    if (asset.type === AssetCategory.CONSUMABLES && action === 'add') {
      setQuantityAsset(asset); setSelectedQuantity(asset.quantity); setShowQuantityModal(true); return;
    }
    if (isBulkStock(asset) && !conferenceFormData.is_audit && !(user?.role === 'technician' && action !== 'remove')) {
      openQuantityAction(asset, action === 'add' ? 'stage' : action === 'remove' ? 'return' : 'unstage'); return;
    }
    if (asset.sub_assets?.length) {
      setPendingParentAsset(asset); setPendingAction(action === 'unassign' ? 'remove' : action);
      setScannedSubAssetIds([]); return;
    }
    void submitAssetCommand(conferenceMovementAction(action), [String(asset.id)]);
  };
  const verifyCrosscheckAsset = (asset: Asset) => {
    if (!canVerifyReturns(user)) { showScanToast('Only warehouse managers can verify returns.', 'error'); return; }
    if (asset.stock_kind === 'led_case') { setLedCasePicker({asset, action: conferenceMovementAction('verify_crosscheck')}); return; }
    if (isBulkStock(asset) && !conferenceFormData.is_audit) { openQuantityAction(asset, 'verify_return'); return; }
    if (asset.sub_assets?.length) {
      setPendingParentAsset(asset); setPendingAction('verify_crosscheck'); setScannedSubAssetIds([]); return;
    }
    void submitAssetCommand(conferenceMovementAction('verify_crosscheck'), [String(asset.id)]);
  };
  const completeParentMovement = () => {
    if (!pendingParentAsset || !pendingAction) return;
    const ids = [String(pendingParentAsset.id), ...(pendingParentAsset.sub_assets || []).map(asset => String(asset.id))];
    void submitAssetCommand(conferenceMovementAction(pendingAction), ids);
    setPendingParentAsset(null); setPendingAction(null); setScannedSubAssetIds([]);
  };

  const handleUpdateRequestedConsumable = (assetId: string, delta: number) => {
    if (eventSavingRef.current || pendingMovementCount > 0) return;
    try {
      const data = editConsumableRequest(conferenceFormDataRef.current.consumable_data || {}, String(assetId), delta);
      setConferenceFormData((prev: any) => ({ ...prev, consumable_data: data }));
    } catch (error) { showScanToast((error as Error).message, 'warning'); }
  };

  const handleUpdateReturnedConsumable = (assetId: string, count: number | null) => {
    if (eventSavingRef.current || pendingMovementCount > 0) return;
    try {
      const data = editConsumableReturn(conferenceFormDataRef.current.consumable_data || {}, String(assetId), count);
      setConferenceFormData((prev: any) => ({ ...prev, consumable_data: data }));
    } catch (error) { showScanToast((error as Error).message, 'warning'); }
  };

  const submitQuantityAssignment = async () => {
    if (!quantityAsset || !conferenceFormData.id) return;
    if (quantityAsset.type === AssetCategory.CONSUMABLES) {
      if (eventSavingRef.current || pendingMovementCount > 0) return;
      const data = conferenceFormDataRef.current.consumable_data || {};
      const requested = Number(data[String(quantityAsset.id)]?.requested || 0);
      const limit = consumableLimit(quantityAsset, conferenceFormData.consumable_ledger?.[String(quantityAsset.id)]);
      if (!Number.isInteger(selectedQuantity) || selectedQuantity <= 0 || requested + selectedQuantity > limit) {
        showScanToast('Choose an available whole-unit quantity; older stock may need reconciliation.', 'warning'); return;
      }
      handleUpdateRequestedConsumable(String(quantityAsset.id), selectedQuantity);
      showScanToast('Consumable request kept in your draft. Save it to reserve stock.', 'success');
      setShowQuantityModal(false); return;
    }
    if (!Number.isInteger(selectedQuantity) || selectedQuantity < 1 || selectedQuantity > quantityLimit(quantityAsset, conferenceFormData, quantityAction)) {
      showScanToast('Choose a valid quantity and reopen the event if its balance has changed.', 'warning'); return;
    }
    const confirmed = await submitQuantityCommand({ action: quantityAction, expected_revision: conferenceFormData.revision ?? 0,
      items: [{ asset_id: Number(quantityAsset.id), quantity: selectedQuantity }] });
    if (confirmed) setShowQuantityModal(false);
  };

  const handleScan = (decodedText: string, isAddingVal: boolean | null = null) => {
    // A quantity selection is an operator decision. Further reads must not
    // replace its asset/count while that decision or its save is in progress.
    if (showQuantityModal || quantitySaving || consumableSaving || ledCasePicker) return;
    // setShowScanner(false); // REMOVED: Allow continuous scanning
    const scanned = (decodedText || '').trim();
    if (!scanned) return;

    // 0. DEDUPLICATION (Safety for hardware scanners and continuous camera scanning)
    const now = Date.now();
    const upperScanned = scanned.toUpperCase();
    const scanScope = `${currentPage}:${conferenceFormData.id || ''}:${assetTab}:${isAddingVal}`;
    if (scanScope === lastScannedScope.current && upperScanned === lastScannedCode.current.toUpperCase() && (now - lastScannedTime.current) < 2000) {
      console.log('Skipping duplicate scan within 2s window:', scanned);
      return;
    }
    lastScannedCode.current = upperScanned;
    lastScannedTime.current = now;
    lastScannedScope.current = scanScope;

    console.log('--- Handle Scan ---', scanned, 'Page:', currentPage);

    // New: Global Consumables QR Logic
    if (scanned === GLOBAL_CONSUMABLES_SKU) {
      if (currentPage === 'Conferences' && (conferenceView === 'Form' || conferenceView === 'Details')) {
        setConsumablesPickerSearchQuery('');
        setShowConsumablesPicker(true);
        showScanToast('📦 Global Consumables QR Scanned', 'success');
        return;
      } else {
        showScanToast('📦 This is the Global Consumables QR. Use it inside a Conference/Challan.', 'warning');
        return;
      }
    }

    const identity = resolveScan(scanned, [...allAssetsRef.current, ...assets]);
    if (identity.kind === 'ambiguous' || identity.kind === 'invalid') {
      showScanToast(identity.kind === 'ambiguous' ? 'Duplicate identifier: ask the warehouse manager to resolve it.' : 'This scan is not a valid equipment identifier.', 'error');
      return;
    }
    const asset = identity.kind === 'matched' ? identity.asset : null;

    // 1. ASSET LINKING MODAL (Only for Assets Page)
    if (!asset && currentPage === 'Assets' && scanned.length > 2) {
      console.warn('No match for:', scanned);
      setUnrecognizedScan(scanned);

      // NEW: If already viewing an asset, suggest linking this QR to IT!
      if (viewingAsset) {
        setLinkingAsset(viewingAsset);
        showScanToast(`🔍 Unrecognized QR. Link to current asset?`, 'warning');
      }
      return;
    }

    // 2. CONFERENCE FORM LOGIC
    if (currentPage === 'Conferences' && (conferenceView === 'Form' || conferenceView === 'Details')) {
      if (!asset) {
        if (showUnknownError) {
          showScanToast(`❌ Unknown scan: "${scanned}" — no matching asset found.`, 'error');
        }
        return;
      }

      if (pendingParentAsset) {
        const isSubAsset = pendingParentAsset.sub_assets?.some(sub => String(sub.id) === String(asset.id));
        if (isSubAsset) {
          // Check locks for sub-assets too
          if (pendingAction === 'add') {
            if (asset.status === AssetStatus.IN_USE) {
              showScanToast(`🔒 Component "${asset.aliasName || asset.sku}" is In Use and cannot be added.`, 'error');
              return;
            }
            if (asset.status === AssetStatus.CROSSCHECK) {
              showScanToast(`🔒 Component "${asset.aliasName || asset.sku}" is in Crosscheck and cannot be added.`, 'error');
              return;
            }
          }
          const subAssetIdStr = asset.id.toString();
          if (!scannedSubAssetIds.includes(subAssetIdStr)) {
            const newScanned = [...scannedSubAssetIds, subAssetIdStr];
            setScannedSubAssetIds(newScanned);
            showScanToast(`✅ Scanned Component: "${asset.aliasName || asset.sku}"`, 'success');

            if (newScanned.length >= (pendingParentAsset.sub_assets?.length || 0)) { completeParentMovement(); }
          } else {
            showScanToast(`⚠️ Component "${asset.aliasName || asset.sku}" already scanned.`, 'warning');
          }
        } else {
          showScanToast(`❌ "${asset.aliasName || asset.sku}" is not a required component`, 'error');
        }
        return;
      }

      const strId = String(asset.id);
      if (asset.stock_kind === 'led_case') {
        if (assetTab === 'crosscheck') verifyCrosscheckAsset(asset);
        else triggerAssetConferenceAction(asset, assetTab === 'packup' ? 'remove' : 'add');
        setQuickAddInput(''); setQuickRemoveInput(''); return;
      }
      if (isBulkStock(asset) && !conferenceFormData.is_audit && (user?.role !== 'technician' || assetTab === 'packup')) {
        if (assetTab === 'crosscheck') verifyCrosscheckAsset(asset);
        else triggerAssetConferenceAction(asset, assetTab === 'packup' ? 'remove' : 'add');
        setQuickAddInput(''); setQuickRemoveInput(''); return;
      }
      
      if (assetTab === 'packup') {
        if ((conferenceFormData.crosscheck_assets || []).some((id: any) => String(id) === strId)) {
          alert("This specific item has already been scanned/added!");
          setQuickAddInput('');
          setQuickRemoveInput('');
          return;
        }
        triggerAssetConferenceAction(asset, 'remove');
      } else if (assetTab === 'assigned') {
        if (asset.type === AssetCategory.CONSUMABLES) {
          const currentReq = Number(conferenceFormData.consumable_data?.[String(asset.id)]?.requested || 0);
          const totalStock = consumableLimit(asset, conferenceFormData.consumable_ledger?.[String(asset.id)]);
          const availableToAssign = Math.max(0, totalStock - currentReq);

          if (availableToAssign <= 0) {
            showScanToast(`⚠️ No more units of "${asset.aliasName || asset.sku}" are available for this request.`, 'warning');
            setQuickAddInput('');
            return;
          }

          setQuantityAsset(asset);
          setSelectedQuantity(Math.min(1, availableToAssign));
          setShowQuantityModal(true);
          showScanToast(`📦 Scanned Consumable: "${asset.aliasName || asset.sku}" (${availableToAssign} remaining available)`, 'success');
          setQuickAddInput('');
          return;
        }
        const scanAction = (isAddingVal === true || user?.role === 'technician' || user?.role === 'godown_incharge') ? 'add' : 'remove';
        
        if (scanAction === 'add') {
          // ── GUARD 1 (J-119): Item already dispatched to Packup / on-site ──────
          // Must fire first: .assets holds fully dispatched items. An item promoted
          // from staged_assets to assets would NOT be caught by isDuplicate below
          // (which only checks staged_assets for the Incharge role).
          const isAlreadyOnSite = (conferenceFormData.assets || []).some((id: any) => String(id) === strId);
          if (isAlreadyOnSite) {
            showScanToast(`⚠️ Already On-Site: "${asset.aliasName || asset.sku}" is already submitted to Packup.`, 'warning');
            setQuickAddInput('');
            setQuickRemoveInput('');
            return;
          }

          // ── GUARD 2 (J-122): Item already in requirements / staged ────────────
          // Hoisted ABOVE Smart Swap so no state mutation can occur before this
          // check fires. Technician → checks requirements[]. Incharge/Admin → staged_assets[].
          const isDuplicate = user?.role === 'technician'
            ? (conferenceFormData.requirements || []).some((id: any) => String(id) === strId)
            : (conferenceFormData.staged_assets || []).some((id: any) => String(id) === strId);

          if (isDuplicate) {
            showScanToast(`⚠️ Already Scanned: "${asset.aliasName || asset.sku}" is already in the list.`, 'warning');
            setQuickAddInput('');
            setQuickRemoveInput('');
            return;
          }

          // ── SMART SWAP (only reached after both guards pass) ──────────────────
          // Safe to mutate state here — item is confirmed not on-site and not
          // already staged/in-requirements.
          if (user?.role !== 'technician') {
            const reqIds = (conferenceFormData.requirements || []).map(String);

            if (!reqIds.includes(strId)) {
               // Use allAssetsRef (complete DB) for Smart Swap alias matching
               const scanPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
               const matchingReqId = reqIds.find((reqId: string) => {
                  const reqAsset = scanPool.find((a: any) => String(a.id) === reqId);
                  return reqAsset && reqAsset.aliasName === asset.aliasName;
               });

               if (matchingReqId) {
                 setConferenceFormData((prev: any) => ({
                    ...prev,
                    requirements: (prev.requirements || []).filter((id: any) => String(id) !== matchingReqId)
                 }));
                 showScanToast(`🔄 Smart Swap: Substituted requested item with scanned SKU`, 'success');
               } else {
                 showScanToast(`📦 Free-Add: Packing unrequested item`, 'success');
                 setQuickAddInput('');
                 setQuickRemoveInput('');
               }
            }
          }
        } else if (scanAction === 'remove') {
          if ((conferenceFormData.crosscheck_assets || []).some((id: any) => String(id) === strId)) {
            alert("This specific item has already been scanned/added!");
            setQuickAddInput('');
            setQuickRemoveInput('');
            return;
          }
        }

        triggerAssetConferenceAction(asset, scanAction);
      } else if (assetTab === 'crosscheck') {
        if (canVerifyReturns(user)) {
          verifyCrosscheckAsset(asset);
        } else {
          showScanToast(`❌ Technicians cannot verify assets. Please wait for Godown Incharge.`, 'error');
        }
      } else {
        // Available tab / fallback
        const isDuplicate = user?.role === 'technician' 
          ? (conferenceFormData.requirements || []).some((id: any) => String(id) === strId)
          : (conferenceFormData.staged_assets || []).some((id: any) => String(id) === strId);
          
        if (isDuplicate) {
          alert("This specific item has already been scanned/added!");
          setQuickAddInput('');
          setQuickRemoveInput('');
          return;
        }
        triggerAssetConferenceAction(asset, 'add');
      }
    }
    // 3. INVENTORY SEARCH LOGIC
    else if (currentPage === 'Assets') {
      setSearchQuery(scanned);
      if (asset) {
        openAssetDetails(asset);
        setShowScanner(false);
        showScanToast(`[Inv] ✅ Found: ${asset.aliasName || asset.sku}`, 'success');
      } else {
        showScanToast(`[Inv] ❌ No asset found with ID "${scanned}"`, 'error');
      }
    }

    // Re-focus after tiny delay
    setTimeout(() => {
      if (currentPage === 'Assets') inventorySearchRef.current?.focus();
      if (currentPage === 'Conferences' && conferenceView === 'Form') {
        if (assetTab === 'available') quickAddRef.current?.focus();
        else if (assetTab === 'assigned') quickRemoveRef.current?.focus();
      }
    }, 150);
  };


  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>, companyId?: string) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadFeedback({ type: 'loading', text: 'Uploading and processing data...' });

    const formData = new FormData();
    formData.append('file', file);
    if (companyId) {
      formData.append('subrental_company_id', companyId);
    }

    apiFetch(`${API_BASE}/api/upload-assets/`, {
      method: 'POST',
      body: formData
    })
      .then(async res => {
        const data = await res.json();
        if (res.ok) {
          setUploadResult({ created: data.created ?? 0, skipped: data.skipped ?? 0, errors: data.errors ?? [] });
          setUploadFeedback({ type: 'success', text: `${data.created ?? 0} new inventory record(s) saved.` });
          setTimeout(() => setUploadFeedback(null), 5000);
          if (companyId) {
            fetchSubrentalAssets(companyId);
          } else {
            fetchAssets();
          }
        } else {
          setUploadResult({ created: 0, skipped: 0, errors: data.errors || (Array.isArray(data) ? data : [data.error || data.detail || data.message || 'Upload failed']) });
          setUploadFeedback({ type: 'error', text: 'Error: Failed to upload file.' });
        }
      })
      .catch(() => {
        setUploadResult({ created: 0, skipped: 0, errors: ['Could not connect to server'] });
        setUploadFeedback({ type: 'error', text: 'Error: Failed to upload file.' });
      });

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleExportInventory = (mode: 'template' | 'master' = 'template') => {
    const token = localStorage.getItem('token');
    const filename = mode === 'template' ? 'Asset_Inventory_Template.xlsx' : 'Master_Inventory_Log.xlsx';
    apiFetch(`${API_BASE}/api/export-inventory/?type=${mode}`)
      .then(res => { if (!res.ok) throw Error(`Inventory export failed (${res.status})`); return res.arrayBuffer(); })
      .then(buffer => {
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        }, 300);
        showScanToast(`📊 ${mode === 'template' ? 'Template' : 'Master Log'} exported successfully`, "success");
      })
      .catch(err => {
        console.error('Failed to export inventory', err);
        alert('Failed to export inventory. Please try again.');
      });
  };

  const handleExportSearchResults = () => {
    if (filteredInventoryAssets.length === 0) {
      showScanToast('⚠️ No items found to export', 'warning');
      return;
    }

    try {
      const dataToExport = filteredInventoryAssets.map((asset, idx) => ({
        'S.No': idx + 1,
        'SKU': asset.sku || '',
        'Alias Name': getLaptopSubGroup(asset, undefined, undefined, undefined, true) || asset.aliasName || asset.name || '',
        'Serial Number': asset.serialNumber || '',
        'Type': asset.type || '',
        'Quantity': asset.quantity ?? 1,
        'Status': asset.status || 'Available',
        'Current Venue / Event': asset.current_conference_name || asset.currentVenue || '',
        'Price (₹)': asset.itemPrice || 0,
        'Barcode': asset.barcode || '',
        'Condition': asset.condition || 'Good',
        'Description': asset.description || ''
      }));

      const worksheet = XLSX.utils.json_to_sheet(dataToExport);
      worksheet['!cols'] = [
        { wch: 6 },
        { wch: 18 },
        { wch: 32 },
        { wch: 20 },
        { wch: 18 },
        { wch: 10 },
        { wch: 14 },
        { wch: 28 },
        { wch: 12 },
        { wch: 18 },
        { wch: 12 },
        { wch: 35 }
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Search Results');

      const cleanQuery = searchQuery.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = cleanQuery 
        ? `Inventory_Search_${cleanQuery}_${new Date().toISOString().split('T')[0]}.xlsx`
        : `Inventory_Filtered_${new Date().toISOString().split('T')[0]}.xlsx`;

      XLSX.writeFile(workbook, filename);
      showScanToast(`📊 Exported ${filteredInventoryAssets.length} item(s) to Excel`, 'success');
    } catch (err) {
      console.error('Failed to export search results to Excel:', err);
      alert('Failed to export search results to Excel. Please try again.');
    }
  };

  const handleDownloadInventoryPDF = () => {
    // Grouping logic borrowed from ReportsView
    const grouped: Record<string, Record<string, number>> = {};
    for (const a of filteredInventoryAssets) {
      const cat = a.type || 'Other';
      const family = getSkuFamily(a.sku || a.name || '');
      if (!grouped[cat]) grouped[cat] = {};
      grouped[cat][family] = (grouped[cat][family] || 0) + 1;
    }

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 15;
    let y = margin;

    // Header
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, pageWidth, 30, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.text(inventoryCategoryFilter === 'All' ? 'Tech Trolley – Inventory Report' : `Tech Trolley – ${inventoryCategoryFilter} Report`, margin, 12);
    doc.setFontSize(9);
    doc.text(`Generated: ${new Date().toLocaleString('en-IN')} | ${filteredInventoryAssets.length} Items`, margin, 22);
    y = 40;

    const catOrder = Object.keys(grouped).sort();
    for (const cat of catOrder) {
      if (y > 250) { doc.addPage(); y = margin; }
      doc.setFillColor(30, 41, 59);
      doc.rect(margin - 2, y - 4, pageWidth - 2 * margin + 4, 9, 'F');
      doc.setTextColor(56, 189, 248);
      doc.setFontSize(11);
      doc.text(cat.toUpperCase(), margin, y + 1);
      y += 12;

      const items = Object.entries(grouped[cat]).sort((a, b) => b[1] - a[1]);
      for (const [name, count] of items) {
        if (y > 280) { doc.addPage(); y = margin; }
        doc.setTextColor(30, 30, 30);
        doc.setFontSize(9);
        doc.text(`${name}`, margin + 3, y);
        doc.setTextColor(100, 100, 100);
        doc.text(`${count} unit${count !== 1 ? 's' : ''}`, pageWidth - margin - 20, y, { align: 'right' });
        y += 6;
      }
      y += 6;
    }
    doc.save(`TechTrolley_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
  };


  const handleDownloadTemplate = () => {
    // Ultimate fallback for strict Windows PC browsers: fetch the raw bytes,
    // construct an explicit Excel Blob, encode it into a Base64 Data URI, 
    // and force the download attribute. This completely bypasses the browser's 
    // network router handling of file extensions.
    const token = localStorage.getItem('token');
    apiFetch(`${API_BASE}/api/download-template/`)
      .then(res => res.arrayBuffer())
      .then(buffer => {
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          const base64data = reader.result as string;
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = base64data;
          a.download = 'asset_inventory_template.xlsx';

          document.body.appendChild(a);
          a.click();

          setTimeout(() => {
            document.body.removeChild(a);
          }, 300);
        };
      })
      .catch(err => {
        console.error('Failed to download template', err);
        alert('Failed to download template. Please try again.');
      });
  };


  const getAssetsForBooking = (ids: string[]) => {
    const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
    return pool.filter(a => ids.includes(a.id));
  };
  const getClientById = (id?: string) => id ? clients.find(c => c.id === id) : undefined;

  const generateChallan = (booking: Booking) => {
    setSelectedBookingForChallan(booking);
  };

  // --- ASSET API ACTIONS ---

  const handleSaveAsset = (e: React.FormEvent) => {
    e.preventDefault();
    setFormErrors({});

    const isNew = !editingAsset;
    const isConsumable = assetFormData.type === AssetCategory.CONSUMABLES;
    const isSubrental = !!assetFormData.subrental_company;

    // Auto-generate SKU/Serial for consumables or subrentals if blank
    const finalSku = ( (isConsumable || isSubrental) && !assetFormData.sku)
      ? `${isSubrental ? 'SR' : 'CONS'}-${(assetFormData.aliasName || 'ITEM').toUpperCase().replace(/\s+/g, '-')}-${Date.now().toString().slice(-4)}`
      : assetFormData.sku;

    const finalSerial = ( (isConsumable || isSubrental) && !assetFormData.serialNumber)
      ? finalSku
      : assetFormData.serialNumber;

    const basePayload = {
      sku: finalSku,
      alias_name: assetFormData.aliasName,
      mac_address: assetFormData.macAddress,
      imei_number_1: assetFormData.imeiNumber1,
      imei_number_2: assetFormData.imeiNumber2,
      serial_number: finalSerial,
      description: assetFormData.description,
      is_barcode_added: assetFormData.isBarcodeAdded,
      type: assetFormData.type,
      purchased_date: assetFormData.purchasedDate || null,
      item_price: isNaN(Number(assetFormData.itemPrice)) ? 0 : Number(assetFormData.itemPrice),
      depreciation_percentage: isNaN(Number(assetFormData.depreciationPercentage)) ? 0 : Number(assetFormData.depreciationPercentage),
      available_from: assetFormData.availableFrom || null,
      available_till: assetFormData.availableTill || null,
      status: assetFormData.status,
      condition: assetFormData.condition || 'Good',
      barcode: assetFormData.barcode || finalSku,
      barcode_type: assetFormData.barcodeType || 'CODE128',
      qr_code: assetFormData.qrCode || finalSku,
      flag: assetFormData.flag || '',
      quantity: assetFormData.quantity ?? 1,
      assigned_to: assetFormData.assigned_to,
      subrental_company: assetFormData.subrental_company
    };

    const count = (!isConsumable && isNew && (assetFormData.quantity ?? 1) > 1)
      ? Number(assetFormData.quantity)
      : 1;

    let payload: any;
    if (count > 1) {
      const batchSkus = generateBatchSkus(finalSku, count);
      const existingInPool = allAssetsRef.current.map(a => a.sku?.toLowerCase());
      const conflict = batchSkus.find(s => existingInPool.includes(s.toLowerCase()));
      if (conflict) {
        alert(`Cannot create batch: SKU "${conflict}" already exists in inventory! Please choose a different starting number or prefix.`);
        return;
      }
      payload = batchSkus.map(sku => ({
        ...basePayload,
        sku: sku,
        serial_number: assetFormData.serialNumber ? `${assetFormData.serialNumber}-${sku}` : sku,
        barcode: sku,
        qr_code: sku,
        quantity: 1
      }));
    } else {
      payload = isConsumable 
        ? { ...basePayload, quantity: assetFormData.quantity ?? 1 }
        : basePayload;
    }

    const url = editingAsset
      ? `${API_BASE}/api/assets/${editingAsset.id}/`
      : `${API_BASE}/api/assets/`;

    const method = editingAsset ? 'PUT' : 'POST';

    apiFetch(url, {
      method: method,
      body: JSON.stringify(payload)
    })
      .then(async res => {
        if (res.ok) {
          const savedData = await res.json();
          const savedList: any[] = Array.isArray(savedData) ? savedData : [savedData];

          const mappedAssets: Asset[] = savedList.map(item => ({
            ...item,
            id: item.id.toString(),
            aliasName: item.alias_name,
            macAddress: item.mac_address,
            imeiNumber1: item.imei_number_1,
            imeiNumber2: item.imei_number_2,
            serialNumber: item.serial_number,
            isBarcodeAdded: item.is_barcode_added,
            quantity: parseInt(item.quantity, 10) || 1,
            itemPrice: parseFloat(item.item_price),
            depreciationPercentage: parseFloat(item.depreciation_percentage),
            purchasedDate: item.purchased_date,
            availableFrom: item.available_from,
            availableTill: item.available_till,
            createdAt: item.created_at,
            barcode: item.barcode,
            barcodeType: item.barcode_type,
            qrCode: item.qr_code,
            lastMaintained: item.last_maintained,
            isTemporary: item.is_temporary,
            returnDate: item.return_date,
            flag: item.flag || AssetFlag.NONE,
            currentVenue: item.current_venue,
            assigned_to: item.assigned_to,
            assigned_to_name: item.assigned_to_name,
            parent_asset: item.parent_asset,
            current_conference_name: item.current_conference_name,
            sub_assets: item.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
          }));

          if (isNew) {
            allAssetsRef.current = [...mappedAssets, ...allAssetsRef.current];
            setAssets(prev => [...mappedAssets, ...prev]);
            showScanToast(`✅ Successfully registered ${mappedAssets.length} asset(s)!`, 'success');
          } else {
            const updated = mappedAssets[0];
            allAssetsRef.current = allAssetsRef.current.map(a => a.id === updated.id ? updated : a);
            setAssets(prev => prev.map(a => a.id === updated.id ? updated : a));
            showScanToast('✅ Asset updated successfully', 'success');
          }

          // Background refetch keeps pagination counts accurate
          fetchAssets();
          handleViewChange('Assets', 'List');
          if ( (isNew || assetFormData.generateQR) && finalSku) {
            setQrTarget({ sku: finalSku as string, name: assetFormData.aliasName || finalSku as string, assetType: assetFormData.type });
          }
          setEditingAsset(null);
          setAssetFormData({ sku: '', aliasName: '', macAddress: '', imeiNumber1: '', imeiNumber2: '', serialNumber: '', description: '', isBarcodeAdded: false, type: AssetCategory.OTHER, purchasedDate: '', itemPrice: 0, depreciationPercentage: 15, availableFrom: '', availableTill: '', status: AssetStatus.AVAILABLE, flag: AssetFlag.NONE, condition: 'Good', barcode: '', barcodeType: '', qrCode: '', quantity: 1, assigned_to: undefined, subrental_company: undefined, generateQR: false });
          
          // If we were in a subrental inventory context, refresh its specific list
          if (selectedSubrentalCompany) {
             fetchSubrentalAssets(selectedSubrentalCompany.id);
             setCurrentPage('Subrentals');
          }
        } else {
          const errorData = await res.json();
          setFormErrors(errorData);
        }
      })
      .catch(() => alert('Failed to connect to server.'));
  };


  const handleDeleteAsset = (id: string) => {
    const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
    const targetAsset = pool.find(a => String(a.id) === String(id));
    if (targetAsset && (targetAsset.status === AssetStatus.IN_USE || targetAsset.status === AssetStatus.CROSSCHECK)) {
      alert(`🔒 Cannot delete "${targetAsset.aliasName || targetAsset.sku}" because it is currently IN USE by an active conference.`);
      return;
    }

    if (!confirm("Are you sure you want to delete this asset?")) return;

    setAssets(prev => prev.filter(a => String(a.id) !== String(id)));
    allAssetsRef.current = allAssetsRef.current.filter(a => String(a.id) !== String(id));

    const url = `${API_BASE}/api/assets/${id}/`;
    apiFetch(url, {
      method: 'DELETE'
    })
      .then(async res => {
        if (res.ok || res.status === 404) {
          fetchAssets();
        } else {
          let errText = res.statusText;
          try {
            const errData = await res.json();
            errText = JSON.stringify(errData);
          } catch (e) { }
          console.error("Delete failed:", res.status, errText);
          alert(`Failed to delete asset. Server responded with: ${res.status} ${errText}`);
        }
      })
      .catch(err => {
        console.error("Network error deleting asset:", err);
      });
  };

  const handleUpdateConsumableQuantity = async (assetId: string | number, newQuantity: number) => {
    if (newQuantity < 0) return;
    const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
    const targetAsset = pool.find(a => String(a.id) === String(assetId));
    if (targetAsset && (targetAsset.status === AssetStatus.IN_USE || targetAsset.status === AssetStatus.CROSSCHECK)) {
      showScanToast(`🔒 Cannot edit quantity of "${targetAsset.aliasName || targetAsset.sku}" while it is In Use`, 'warning');
      return;
    }

    try {
      const res = await apiFetch(`${API_BASE}/api/assets/${assetId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ quantity: newQuantity })
      });
      if (res.ok) {
        setAssets(prev => prev.map(a => String(a.id) === String(assetId) ? { ...a, quantity: newQuantity } : a));
        showScanToast(`✅ Stock updated to ${newQuantity}`, 'success');
      }
    } catch (err) {
      console.error('Failed to update consumable quantity:', err);
    }
  };

  const openEditAssetForm = (asset: Asset) => {
    if (asset.stock_kind === 'led_case') { showScanToast('This is the protected original box record. Open its registered panels to edit stock details.', 'warning'); return; }
    if (mainRef.current) inventoryScrollPos.current = mainRef.current.scrollTop;
    setEditingAsset(asset);
    setAssetFormData({
      sku: asset.sku,
      aliasName: asset.aliasName,
      macAddress: asset.macAddress,
      imeiNumber1: asset.imeiNumber1,
      imeiNumber2: asset.imeiNumber2,
      serialNumber: asset.serialNumber,
      description: asset.description,
      subrental_company: asset.subrental_company,
      isBarcodeAdded: asset.isBarcodeAdded,
      type: asset.type,
      purchasedDate: asset.purchasedDate,
      itemPrice: asset.itemPrice,
      depreciationPercentage: asset.depreciationPercentage,
      availableFrom: asset.availableFrom,
      availableTill: asset.availableTill,
      status: asset.status,
      condition: asset.condition,
      barcode: asset.barcode,
      barcodeType: asset.barcodeType || '',
      qrCode: asset.qrCode || '',
      flag: asset.flag || AssetFlag.NONE,
      quantity: asset.quantity,
      assigned_to: asset.assigned_to
    });
    setAssetView('Form');
    setCurrentPage('Assets');
    setFormErrors({});
  };

  const openNewAssetForm = () => {
    if (mainRef.current) inventoryScrollPos.current = mainRef.current.scrollTop;
    setEditingAsset(null);
    setAssetFormData({
      sku: '',
      aliasName: '',
      macAddress: '',
      imeiNumber1: '',
      imeiNumber2: '',
      serialNumber: '',
      description: '',
      purchasedDate: new Date().toISOString().split('T')[0],
      itemPrice: 0,
      depreciationPercentage: 15,
      availableFrom: '',
      availableTill: '',
      status: AssetStatus.AVAILABLE,
      condition: 'Good',
      type: AssetCategory.OTHER,
      isBarcodeAdded: false,
      quantity: 1,
      flag: AssetFlag.NONE
    });
    setAssetView('Form');
    setFormErrors({});
  };

  const openConsumableForm = () => {
    if (mainRef.current) inventoryScrollPos.current = mainRef.current.scrollTop;
    setEditingAsset(null);
    setAssetFormData({
      sku: '',
      aliasName: '',
      macAddress: '',
      imeiNumber1: '',
      imeiNumber2: '',
      serialNumber: '', // will be same as SKU or blank
      description: '',
      purchasedDate: new Date().toISOString().split('T')[0],
      itemPrice: 0,
      depreciationPercentage: 0,
      availableFrom: '',
      availableTill: '',
      status: AssetStatus.AVAILABLE,
      condition: 'Good',
      type: AssetCategory.CONSUMABLES,
      isBarcodeAdded: false,
      quantity: 1,
      flag: AssetFlag.NONE
    });
    setAssetView('Form');
    setFormErrors({});
  };

  const simulateScan = (val: string) => {
    alert(`Simulating scan for: ${val}`);
    handleScan(val);
  };

  const handleLinkQR = () => {
    if (!unrecognizedScan || !linkingAsset) return;

    apiFetch(`${API_BASE}/api/assets/${linkingAsset.id}/`, {
      method: 'PATCH',
      body: JSON.stringify({
        barcode: unrecognizedScan,
        is_barcode_added: true
      })
    })
      .then(res => {
        if (res.ok) {
          showScanToast(`✅ Linked QR to ${linkingAsset.aliasName || linkingAsset.sku}`, 'success');
          fetchAssets();
          setUnrecognizedScan(null);
          setLinkingAsset(null);
        } else if (res.status !== 401) {
          alert('Failed to link QR code.');
        }
      })
      .catch(() => alert('Network error while linking QR.'));
  };

  const handleLinkSubAsset = () => {
    if (!viewingAsset || !selectedSubAssetToLink) return;

    apiFetch(`${API_BASE}/api/assets/${viewingAsset.id}/sub-assets/`, {
      method: 'POST',
      body: JSON.stringify({
        child_id: selectedSubAssetToLink.id
      })
    })
      .then(res => {
        if (res.ok) {
          showScanToast(`✅ Added ${selectedSubAssetToLink.aliasName || selectedSubAssetToLink.sku} as component`, 'success');
          fetchAssets();
          setAddingSubAssetMode(false);
          setSelectedSubAssetToLink(null);
          setSubAssetSearchQuery('');

          // Re-fetch this specific asset to update the detailed view immediately
          apiFetch(`${API_BASE}/api/assets/${viewingAsset.id}/`)
            .then(aRes => aRes.json())
            .then(data => {
              const mapped = {
                ...data,
                id: data.id.toString(),
                aliasName: data.alias_name,
                macAddress: data.mac_address,
                imeiNumber1: data.imei_number_1,
                imeiNumber2: data.imei_number_2,
                serialNumber: data.serial_number,
                isBarcodeAdded: data.is_barcode_added,
                itemPrice: parseFloat(data.item_price),
                depreciationPercentage: parseFloat(data.depreciation_percentage),
                purchasedDate: data.purchased_date,
                availableFrom: data.available_from,
                availableTill: data.available_till,
                createdAt: data.created_at,
                barcode: data.barcode,
                barcodeType: data.barcode_type,
                qrCode: data.qr_code,
                lastMaintained: data.last_maintained,
                returnDate: data.return_date,
                currentVenue: data.current_venue,
                assigned_to: data.assigned_to,
                assigned_to_name: data.assigned_to_name,
                current_conference_name: data.current_conference_name,
                sub_assets: data.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
              };
              setViewingAsset(mapped);
            });
        } else if (res.status !== 401) {
          alert('Failed to add component.');
        }
      })
      .catch(() => alert('Network error while adding component.'));
  };

  const handleQuickCreateSubAsset = () => {
    if (!viewingAsset || !quickSubAssetData.sku) return;

    const payload = {
      sku: quickSubAssetData.sku,
      alias_name: quickSubAssetData.sku,
      serial_number: quickSubAssetData.serialNumber,
      type: quickSubAssetData.type,
      item_price: quickSubAssetData.itemPrice,
      status: AssetStatus.AVAILABLE,
      condition: 'Good',
      barcode: quickSubAssetData.sku,
      parent_asset: viewingAsset.id
    };

    apiFetch(`${API_BASE}/api/assets/`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
      .then(async res => {
        if (res.ok) {
          showScanToast(`✅ Successfully created and linked "${quickSubAssetData.sku}"`, 'success');
          fetchAssets();
          setCreatingSubAssetMode(false);
          setQuickSubAssetData({ sku: '', serialNumber: '', type: 'Other', itemPrice: 0, generateQR: false });

          // Show QR Modal if requested
          if (quickSubAssetData.generateQR) {
            setQrTarget({
              sku: payload.sku,
              name: payload.alias_name
            });
          }

          // Re-fetch to update details view
          apiFetch(`${API_BASE}/api/assets/${viewingAsset.id}/`)
            .then(aRes => aRes.json())
            .then(data => {
              const mapped = {
                ...data,
                id: data.id.toString(),
                aliasName: data.alias_name,
                macAddress: data.mac_address,
                imeiNumber1: data.imei_number_1,
                imeiNumber2: data.imei_number_2,
                serialNumber: data.serial_number,
                isBarcodeAdded: data.is_barcode_added,
                itemPrice: parseFloat(data.item_price),
                depreciationPercentage: parseFloat(data.depreciation_percentage),
                purchasedDate: data.purchased_date,
                availableFrom: data.available_from,
                availableTill: data.available_till,
                createdAt: data.created_at,
                barcode: data.barcode,
                barcodeType: data.barcode_type,
                qrCode: data.qr_code,
                lastMaintained: data.last_maintained,
                returnDate: data.return_date,
                currentVenue: data.current_venue,
                assigned_to: data.assigned_to,
                assigned_to_name: data.assigned_to_name,
                current_conference_name: data.current_conference_name,
                sub_assets: data.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
              };
              setViewingAsset(mapped);
            });
        } else {
          const errData = await res.json();
          alert(`Failed to create component: ${JSON.stringify(errData)}`);
        }
      })
      .catch(() => alert('Network error while creating component.'));
  };

  const handleUnlinkSubAsset = (childId: string) => {
    if (!viewingAsset) return;
    if (!confirm("Remove this component from the main asset?")) return;

    apiFetch(`${API_BASE}/api/assets/${viewingAsset.id}/sub-assets/${childId}/`, {
      method: 'DELETE'
    })
      .then(res => {
        if (res.ok) {
          showScanToast(`✅ Component removed`, 'success');
          fetchAssets();
          apiFetch(`${API_BASE}/api/assets/${viewingAsset.id}/`)
            .then(aRes => aRes.json())
            .then(data => {
              const mapped = {
                ...data,
                id: data.id.toString(),
                aliasName: data.alias_name,
                macAddress: data.mac_address,
                imeiNumber1: data.imei_number_1,
                imeiNumber2: data.imei_number_2,
                serialNumber: data.serial_number,
                isBarcodeAdded: data.is_barcode_added,
                itemPrice: parseFloat(data.item_price),
                depreciationPercentage: parseFloat(data.depreciation_percentage),
                purchasedDate: data.purchased_date,
                availableFrom: data.available_from,
                availableTill: data.available_till,
                createdAt: data.created_at,
                barcode: data.barcode,
                barcodeType: data.barcode_type,
                qrCode: data.qr_code,
                lastMaintained: data.last_maintained,
                returnDate: data.return_date,
                currentVenue: data.current_venue,
                assigned_to: data.assigned_to,
                assigned_to_name: data.assigned_to_name,
                current_conference_name: data.current_conference_name,
                sub_assets: data.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
              };
              setViewingAsset(mapped);
            });
        } else if (res.status !== 401) {
          alert('Failed to remove component.');
        }
      })
      .catch(() => alert('Network error while removing component.'));
  };


  // --- EMPLOYEE API ACTIONS ---

  const handleSaveEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    setFormErrors({});

    const url = editingEmployee
      ? `${API_BASE}/api/employees/${editingEmployee.id}/`
      : `${API_BASE}/api/employees/`;

    const method = editingEmployee ? 'PUT' : 'POST';

    apiFetch(url, {
      method: method,
      body: JSON.stringify({...employeeFormData, ...(!editingEmployee && employeeInitialPassword ? {password:employeeInitialPassword} : {})})
    })
      .then(async res => {
        if (res.ok) {
          const result = await res.json();
          if (!editingEmployee && result.login_password_set === false) showScanToast('Employee registered. Set a login password before they can sign in.', 'success');
          setEmployeeInitialPassword('');
          fetchEmployees();
          setEmployeeView('List');
          setEditingEmployee(null);
          setEmployeeFormData({ name: '', employee_id: '', department: '', email: '', phone: '' });
        } else if (res.status !== 401) {
          const errorData = await res.json();
          setFormErrors(errorData);
        }
      })
      .catch(err => alert("Failed to connect to server."));
  };

  const handleDeleteEmployee = (id: string) => {
    if (!confirm("Are you sure you want to delete this employee?")) return;
    apiFetch(`${API_BASE}/api/employees/${id}/`, {
      method: 'DELETE'
    })
      .then(res => {
        if (res.ok) fetchEmployees();
        else if (res.status !== 401) alert("Failed to delete employee.");
      });
  };

  const openEditEmployeeForm = (emp: Employee) => {
    setEditingEmployee(emp);
    setEmployeeFormData(emp);
    setEmployeeView('Form');
    setFormErrors({});
  };

  const openNewEmployeeForm = () => {
    setEditingEmployee(null);
    setEmployeeFormData({ name: '', employee_id: '', department: '', email: '', phone: '' });
    setEmployeeView('Form');
    setFormErrors({});
  };


  const renderAssetDetails = () => {
    if (!viewingAsset) return null;
    return (
      <div className="min-w-0 max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between sm:items-center">
          <h2 className="min-w-0 text-3xl sm:text-4xl lg:text-5xl leading-tight font-black text-white uppercase tracking-tighter">Asset Details</h2>
          <button onClick={() => { handleViewChange('Assets', 'List'); setSearchQuery(''); }} className="shrink-0 whitespace-nowrap px-6 py-3 bg-slate-800 text-white rounded-xl font-black uppercase text-xs hover:bg-slate-700 transition">Back to List</button>
        </div>
        <LedCaseRecord key={viewingAsset.id} asset={viewingAsset} canReview={['admin', 'boss'].includes(user?.role || '')} apiFetch={reportApiFetch} />
        <div className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50 space-y-8 shadow-2xl">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between border-b border-slate-800/50 pb-8">
            <div className="min-w-0 w-full sm:w-auto sm:flex-1">
              <h3 className="text-2xl sm:text-3xl leading-snug font-black text-white uppercase [overflow-wrap:anywhere]">{viewingAsset.aliasName || viewingAsset.sku}</h3>
              <p className="text-sky-400 font-mono text-sm mt-2">{viewingAsset.type}</p>
            </div>
            <div className="flex max-w-full shrink-0 flex-wrap gap-2 sm:gap-4">
              <div className={`px-6 py-2 rounded-full font-black uppercase text-xs ${viewingAsset.isBarcodeAdded ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                Barcode: {viewingAsset.isBarcodeAdded ? 'Yes' : 'No'}
              </div>
              <div className={`px-6 py-2 rounded-full font-black uppercase text-xs ${viewingAsset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' :
                viewingAsset.status === AssetStatus.IN_USE ? 'bg-orange-500/10 text-orange-400' :
                  viewingAsset.status === AssetStatus.CROSSCHECK ? 'bg-indigo-500/10 text-indigo-400' :
                    'bg-red-500/10 text-red-400'}`}>
                {viewingAsset.stock_kind === 'led_case' ? 'Container record' : viewingAsset.status}
              </div>
            </div>
          </div>
          {(viewingAsset.current_conference_name || getAssetConferenceName(viewingAsset)) && (
            <div className="bg-orange-500/5 border border-orange-500/10 px-6 py-3 rounded-2xl flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex items-center gap-3">
                <i aria-hidden="true" className="fa-solid fa-calendar-check shrink-0 text-orange-400 text-xs"></i>
                <p className="min-w-0 text-[10px] font-black text-orange-400 uppercase tracking-widest [overflow-wrap:anywhere]">Currently at: {viewingAsset.current_conference_name || getAssetConferenceName(viewingAsset)}</p>
              </div>
              {viewingAsset.flag && (
                <div className="flex items-center gap-2 px-3 py-1 bg-red-500/20 rounded-lg">
                  <i aria-hidden="true" className="fa-solid fa-flag text-red-500 text-[10px]"></i>
                  <span className="text-[9px] font-black text-red-400 uppercase tracking-widest">{viewingAsset.flag}</span>
                </div>
              )}
            </div>
          )}

          {/* Asset Flagging Section */}
          <div className="bg-slate-950/20 p-6 rounded-2xl border border-slate-800/50 space-y-4">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">Flag Asset Status</label>
            <div className="flex flex-wrap gap-2">
              {[AssetFlag.NONE, AssetFlag.EXPIRED, AssetFlag.REQUIRED_SERVICE, AssetFlag.ON_SERVICE, AssetFlag.MISSING].map(f => (
                <button
                  key={f}
                  onClick={() => {
                    const updatedAsset = { ...viewingAsset, flag: f };
                    apiFetch(`${API_BASE}/api/assets/${viewingAsset.id}/`, {
                      method: 'PATCH',
                      body: JSON.stringify({ flag: f })
                    }).then(res => {
                      if (res.ok) {
                        setViewingAsset(updatedAsset);
                        fetchAssets();
                        showScanToast(`✅ Asset flagged as ${f || 'None'}`, 'success');
                      }
                    });
                  }}
                  className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border ${(viewingAsset.flag || '') === f
                    ? 'bg-sky-500 border-sky-400 text-white shadow-lg shadow-sky-500/20'
                    : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600'
                    }`}
                >
                  {f || 'None'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 pb-8 border-b border-slate-800/50 [&>*]:min-w-0 [&_p]:[overflow-wrap:anywhere]">
            <div className="space-y-8">
              <div>
                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Description</label>
                <p className="text-lg text-white font-bold leading-relaxed">{viewingAsset.description || '-'}</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Serial Number</label>
                  <p className="text-base text-white font-mono font-bold">{viewingAsset.serialNumber}</p>
                </div>
                <div>
                  <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">MAC Address</label>
                  <p className="text-base text-white font-mono font-bold">{viewingAsset.macAddress || '-'}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">IMEI 1</label>
                  <p className="text-base text-white font-mono font-bold">{viewingAsset.imeiNumber1 || '-'}</p>
                </div>
                <div>
                  <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">IMEI 2</label>
                  <p className="text-base text-white font-mono font-bold">{viewingAsset.imeiNumber2 || '-'}</p>
                </div>
              </div>
            </div>

            <div className="space-y-8">
              <div className="bg-slate-950/40 p-6 rounded-2xl border border-slate-800/50 space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Item Price</label>
                    <p className="text-xl text-emerald-400 font-black">₹{viewingAsset.itemPrice.toLocaleString()}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Depreciation</label>
                    <p className="text-xl text-orange-400 font-black">{viewingAsset.depreciationPercentage}%</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Purchased Date</label>
                    <p className="text-base text-white font-bold">{viewingAsset.purchasedDate ? new Date(viewingAsset.purchasedDate).toLocaleDateString('en-GB') : '-'}</p>
                  </div>
                  <div className="bg-sky-500/10 p-3 rounded-xl border border-sky-500/20 text-center">
                    <label className="text-[8px] uppercase font-black text-sky-400 tracking-widest block mb-1">Total Programs</label>
                    <p className="text-2xl text-white font-black">{assetUsageHistory.timesUsed}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Available From</label>
                  <p className="text-sm text-slate-300 font-bold">{viewingAsset.availableFrom ? new Date(viewingAsset.availableFrom).toLocaleDateString('en-GB') : '-'}</p>
                </div>
                <div>
                  <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Available Till</label>
                  <p className="text-sm text-slate-300 font-bold">{viewingAsset.availableTill ? new Date(viewingAsset.availableTill).toLocaleDateString('en-GB') : '-'}</p>
                </div>
              </div>
            </div>
          </div>

          {/* New Section: Deployment History */}
          <div className="pb-8 border-b border-slate-800/50">
            <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-6">Program Deployment History</h4>
            {assetUsageHistory.history.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                {assetUsageHistory.history.map((h, i) => (
                  <div key={i} className="bg-slate-950/20 border border-slate-800/50 p-4 rounded-xl flex justify-between items-center group hover:border-sky-500/30 transition-all">
                    <p className="text-xs font-bold text-slate-200 uppercase group-hover:text-white truncate pr-4">{h.name}</p>
                    <p className="text-[10px] font-mono text-slate-500 group-hover:text-sky-400 whitespace-nowrap">{h.date}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 border border-dashed border-slate-800 rounded-2xl text-center">
                <i aria-hidden="true" className="fa-solid fa-clock-rotate-left text-slate-800 text-3xl mb-4"></i>
                <p className="text-xs text-slate-600 font-bold uppercase tracking-widest">No previous program history found</p>
              </div>
            )}
          </div>

          <div className="pt-8 border-t border-slate-800/50">
            <div className="flex justify-between items-center mb-4">
              <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest">Tracked Components</label>
              {!addingSubAssetMode && !creatingSubAssetMode && (
                <div className="flex gap-2">
                  <button onClick={() => setCreatingSubAssetMode(true)} className="text-[10px] bg-emerald-500/10 px-3 py-1.5 rounded-lg font-black uppercase tracking-wider text-emerald-400 hover:bg-emerald-500 hover:text-white transition flex items-center gap-1">
                    <i aria-hidden="true" className="fa-solid fa-plus" /> New
                  </button>
                  <button onClick={() => setAddingSubAssetMode(true)} className="text-[10px] bg-sky-500/10 px-3 py-1.5 rounded-lg font-black uppercase tracking-wider text-sky-400 hover:bg-sky-500 hover:text-white transition flex items-center gap-1">
                    <i aria-hidden="true" className="fa-solid fa-link" /> Link
                  </button>
                </div>
              )}
            </div>

            {creatingSubAssetMode && (
              <div className="bg-slate-950/50 p-6 rounded-2xl border border-emerald-500/30 mb-6 animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="flex justify-between items-center mb-4">
                  <p className="text-xs text-emerald-400 font-bold uppercase tracking-wider">Create & Link New Component</p>
                  <button onClick={() => setCreatingSubAssetMode(false)} className="text-slate-500 hover:text-white transition">
                    <i aria-hidden="true" className="fa-solid fa-xmark text-lg" />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-2">Name / SKU *</label>
                    <input
                      type="text"
                      placeholder="e.g. Charger For Laptop 1"
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-white font-bold text-sm focus:border-emerald-500 outline-none transition"
                      value={quickSubAssetData.sku}
                      onChange={(e) => setQuickSubAssetData({ ...quickSubAssetData, sku: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-2">Serial Number</label>
                    <input
                      type="text"
                      placeholder="e.g. CHG88921"
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-white font-mono text-sm focus:border-emerald-500 outline-none transition"
                      value={quickSubAssetData.serialNumber}
                      onChange={(e) => setQuickSubAssetData({ ...quickSubAssetData, serialNumber: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-2">Type</label>
                    <select
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-white font-bold text-sm focus:border-emerald-500 outline-none transition appearance-none"
                      value={quickSubAssetData.type}
                      onChange={(e) => setQuickSubAssetData({ ...quickSubAssetData, type: e.target.value })}
                    >
                      <option value="Laptop">Laptop</option>
                      <option value="Mobile">Mobile</option>
                      <option value="Tablet">Tablet</option>
                      <option value="Monitor">Monitor</option>
                      <option value="Printer">Printer</option>
                      <option value="Scanner">Scanner</option>
                      <option value="Network">Network</option>
                      <option value="Audio">Audio</option>
                      <option value="Video">Video</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-2">Est. Price (₹)</label>
                    <input
                      type="number"
                      placeholder="0"
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-white font-bold text-sm focus:border-emerald-500 outline-none transition flex-1"
                      value={quickSubAssetData.itemPrice}
                      onChange={(e) => setQuickSubAssetData({ ...quickSubAssetData, itemPrice: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-1">Generate QR Label?</label>
                    <button
                      type="button"
                      onClick={() => setQuickSubAssetData({ ...quickSubAssetData, generateQR: !quickSubAssetData.generateQR })}
                      className={`w-full py-3 rounded-xl border font-black text-[10px] uppercase tracking-widest transition ${quickSubAssetData.generateQR ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}
                    >
                      {quickSubAssetData.generateQR ? <><i aria-hidden="true" className="fa-solid fa-check-circle mr-2"></i> Yes, Generate</> : <><i aria-hidden="true" className="fa-solid fa-circle mr-2"></i> No, Skip</>}
                    </button>
                  </div>
                </div>

                <button
                  disabled={!quickSubAssetData.sku}
                  onClick={handleQuickCreateSubAsset}
                  className="w-full py-4 bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl font-black uppercase text-xs hover:bg-emerald-400 transition"
                >
                  Create & Link Component
                </button>
              </div>
            )}

            {addingSubAssetMode && (
              <div className="bg-slate-950/50 p-6 rounded-2xl border border-sky-500/30 mb-6 animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="flex justify-between items-center mb-4">
                  <p className="text-xs text-slate-400 font-bold uppercase">Search & Assign Component</p>
                  <button onClick={() => { setAddingSubAssetMode(false); setSelectedSubAssetToLink(null); }} className="text-slate-500 hover:text-white transition">
                    <i aria-hidden="true" className="fa-solid fa-xmark text-lg" />
                  </button>
                </div>

                <div className="relative mb-4">
                  <i aria-hidden="true" className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                  <input
                    type="text"
                    placeholder="SEARCH FOR ASSET TO LINK..."
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-12 pr-4 py-3 text-white uppercase font-black text-xs tracking-wider focus:border-sky-500 outline-none transition"
                    onChange={(e) => setSubAssetSearchQuery(e.target.value)}
                  />
                </div>

                <div className="space-y-2 max-h-48 overflow-y-auto pr-2 mb-4">
                  {assets
                    .filter(a => a.id !== viewingAsset.id && !viewingAsset.sub_assets?.some(sub => sub.id === a.id))
                    .filter(a => {
                      const q = normalizeSearch(subAssetSearchQuery);
                      return !q ||
                        normalizeSearch(a.aliasName || '').includes(q) ||
                        normalizeSearch(a.sku || '').includes(q) ||
                        normalizeSearch(a.serialNumber || '').includes(q);
                    })
                    .slice(0, 5)
                    .map(a => (
                      <button
                        key={a.id}
                        onClick={() => setSelectedSubAssetToLink(a)}
                        className={`w-full p-3 rounded-xl border text-left transition flex items-center justify-between ${selectedSubAssetToLink?.id === a.id
                          ? 'bg-sky-500/10 border-sky-500'
                          : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                          }`}
                      >
                        <div>
                          <p className="text-xs font-black text-white uppercase">{a.aliasName || a.sku}</p>
                          <p className="text-[10px] text-slate-500">SN: {a.serialNumber}</p>
                        </div>
                        {selectedSubAssetToLink?.id === a.id && <i aria-hidden="true" className="fa-solid fa-circle-check text-sky-500"></i>}
                      </button>
                    ))}
                </div>

                <button
                  disabled={!selectedSubAssetToLink}
                  onClick={handleLinkSubAsset}
                  className="w-full py-4 bg-sky-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl font-black uppercase text-xs hover:bg-sky-400 transition"
                >
                  Confirm Linkage
                </button>
              </div>
            )}

            {viewingAsset.sub_assets && viewingAsset.sub_assets.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {viewingAsset.sub_assets.map(sub => (
                  <div key={sub.id} className="bg-slate-950/40 p-5 rounded-2xl border border-emerald-500/20 flex justify-between items-center group transition hover:border-emerald-500/50 shadow-lg shadow-emerald-500/5 max-w-full">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex shrink-0 items-center justify-center text-emerald-400">
                        <i aria-hidden="true" className="fa-solid fa-microchip text-xs" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Component</p>
                        <p className="text-sm font-black text-white uppercase truncate">{sub.alias_name || sub.sku}</p>
                        <p className="text-[10px] text-slate-400 font-mono mt-1 truncate">SN: {sub.serial_number}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleUnlinkSubAsset(sub.id)}
                      className="w-10 h-10 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:bg-red-500 hover:text-white"
                      title="Unlink Component"
                    >
                      <i aria-hidden="true" className="fa-solid fa-link-slash" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-slate-950/20 p-6 rounded-2xl border border-dashed border-slate-800 text-center">
                <p className="text-[10px] text-slate-600 font-black uppercase tracking-widest">No Components Linked</p>
              </div>
            )}
          </div>

          <div className="pt-8 border-t border-slate-800/50">
            <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block mb-4">Current Assignment</label>
            {viewingAsset.assigned_to_name ? (
              <div className="bg-slate-950/50 p-6 rounded-2xl flex items-center gap-6 border border-slate-800">
                <div className="w-12 h-12 rounded-full bg-indigo-500 flex items-center justify-center text-white font-black text-lg">
                  {viewingAsset.assigned_to_name.charAt(0)}
                </div>
                <div>
                  <p className="text-white font-bold uppercase">{viewingAsset.assigned_to_name}</p>
                  <p className="text-slate-400 text-xs uppercase tracking-wider">Assigned User</p>
                </div>
              </div>
            ) : (
              <div className="bg-slate-950/20 p-6 rounded-2xl border border-dashed border-slate-800 text-center">
                <p className="text-[10px] text-slate-600 font-black uppercase tracking-widest">Currently Unassigned</p>
              </div>
            )}
            <div className="pt-8 flex flex-col sm:flex-row gap-4 border-t border-slate-800/50">
              <button
                onClick={() => viewingAsset.sku && setQrTarget({ sku: viewingAsset.sku, name: viewingAsset.aliasName || viewingAsset.sku, assetType: viewingAsset.type })}
                className="flex-1 py-5 bg-violet-500/10 text-violet-400 border border-violet-500/20 rounded-xl font-black uppercase text-xs hover:bg-violet-500 hover:text-white transition flex items-center justify-center gap-2"
              >
                <i aria-hidden="true" className="fa-solid fa-qrcode" /> Print QR
              </button>
              <button onClick={() => openEditAssetForm(viewingAsset)} className="flex-1 py-5 bg-sky-500 text-white rounded-xl font-black uppercase text-xs hover:bg-sky-400 transition">Edit Asset</button>
              <button
                onClick={() => { if (confirm('Delete this asset?')) { handleDeleteAsset(viewingAsset.id); handleViewChange('Assets', 'List'); setSearchQuery(''); } }}
                className="flex-1 py-5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl font-black uppercase text-xs hover:bg-red-500 hover:text-white transition">Delete Asset</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // --- RENDERERS ---

  const filteredConferences = useMemo(() => {
    let list = [...backendConferences];
    if (!user?.is_staff && user?.role !== 'godown_incharge' && user?.role !== 'accounts') {
      list = list.filter(conf =>
        conf.assigned_employees?.includes(Number(user?.employee_id))
      );
    }

    if (conferenceSearchTerm) {
      const lowerSearch = conferenceSearchTerm.toLowerCase();
      list = list.filter(c => 
        (c.name || '').toLowerCase().includes(lowerSearch) ||
        (c.conferenceName || '').toLowerCase().includes(lowerSearch) ||
        (c.association || '').toLowerCase().includes(lowerSearch) ||
        (c.venue || '').toLowerCase().includes(lowerSearch)
      );
    }

    if (conferenceStatusFilter !== 'ALL') list = list.filter(c => matchesLifecycleFilter(c, conferenceStatusFilter));

    if (conferenceTypeFilter !== 'ALL') {
      list = list.filter(c => (c.conferenceType || c.type) === conferenceTypeFilter);
    }

    return list.sort((a, b) => Number(b.id) - Number(a.id));
  }, [backendConferences, user, conferenceSearchTerm, conferenceStatusFilter, conferenceTypeFilter]);

  const handleDashboardStatClick = (key: string) => {
    if (isEditingDashboard) return;
    if (key === 'total_assets') {
      setInventoryStatusFilter('All');
      setInventoryCategoryFilter('All');
      setSelectedAlias('All');
      setSearchQuery('');
      setPurchaseDateFrom('');
      setPurchaseDateTo('');
      setInventoryPage(1);
      setCurrentPage('Assets');
    } else if (key === 'in_use') {
      setInventoryStatusFilter('In Use');
      setInventoryCategoryFilter('All');
      setSelectedAlias('All');
      setSearchQuery('');
      setPurchaseDateFrom('');
      setPurchaseDateTo('');
      setInventoryPage(1);
      setCurrentPage('Assets');
    } else if (key === 'available') {
      setInventoryStatusFilter('Available');
      setInventoryCategoryFilter('All');
      setSelectedAlias('All');
      setSearchQuery('');
      setPurchaseDateFrom('');
      setPurchaseDateTo('');
      setInventoryPage(1);
      setCurrentPage('Assets');
    } else if (key === 'active_conferences') {
      setConferenceStatusFilter('ONGOING');
      setConferenceSearchTerm('');
      setCurrentPage('Conferences');
    }
  };

  const renderDashboard = () => (
    <div className="space-y-12 animate-in fade-in duration-500">
      <InventoryOwnershipSummary key={`dashboard-owners:${user?.user_id || user?.email || ''}`} account={String(user?.user_id || user?.email || '')} apiFetch={reportApiFetch} />
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          {user?.role === 'boss' ? (
            <div className="inline-flex items-center gap-2.5 bg-gradient-to-r from-amber-500/20 to-amber-600/10 border border-amber-500/30 px-4 py-2 rounded-full mb-4 w-fit shadow-lg shadow-amber-500/10">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
              </span>
              <p className="text-[10px] font-black text-amber-300 uppercase tracking-widest flex items-center gap-2">
                <i aria-hidden="true" className="fa-solid fa-crown text-amber-400 text-xs" />
                Executive Command Center • Boss Overview & Direct Control
              </p>
            </div>
          ) : !user?.is_staff && (
            <div className={`inline-flex items-center gap-2 ${user?.role === 'accounts' ? 'bg-purple-500/10 border-purple-500/20' : 'bg-orange-500/10 border-orange-500/20'} px-4 py-2 rounded-full mb-4 w-fit border`}>
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${user?.role === 'accounts' ? 'bg-purple-400' : 'bg-orange-400'} opacity-75`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${user?.role === 'accounts' ? 'bg-purple-500' : 'bg-orange-500'}`}></span>
              </span>
              <p className={`text-[9px] font-black ${user?.role === 'accounts' ? 'text-purple-400' : 'text-orange-400'} uppercase tracking-widest`}>
                {user?.role === 'accounts' ? 'Accounts Portal • System Monitor' : 'Employee Portal • Assigned Views'}
              </p>
            </div>
          )}
          <h2 className="text-6xl font-black text-orange-500 uppercase tracking-tighter shrink-0 mb-6">
            Dashboard
          </h2>
          {user?.is_staff && (
            <div className="flex flex-wrap items-center gap-4 mb-8 bg-sky-500/10 border border-sky-500/20 p-6 rounded-[1.5rem] backdrop-blur-md">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-sky-500/20 flex items-center justify-center text-sky-400">
                  <i aria-hidden="true" className="fa-solid fa-database" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">System Audit Log</p>
                  <p className="text-xs font-bold text-sky-400 uppercase">
                    {backendConferences.length} Total Conferences • {dashboardStats?.total ?? '—'} Permanent Inventory Records
                  </p>
                </div>
              </div>
              <div className="ml-auto">
                <button
                  onClick={handleSystemRecovery}
                  className="px-6 py-3 bg-orange-500 text-white rounded-xl font-black uppercase text-[10px] hover:bg-orange-400 transition shadow-lg shadow-orange-500/20 flex items-center gap-2"
                >
                  <i aria-hidden="true" className="fa-solid fa-wrench" /> Repair & Recover Assets
                </button>
              </div>
            </div>
          )}
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.5em] flex items-center gap-4 mt-2">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500"></span>
            </span>
            Terminal Operational • {assets.length} Assets Loaded
          </p>
        </div>
        <div className="flex gap-3">
          {isEditingDashboard ? (
            <>
              <select
                value={companySettings?.theme_template || 'blue'}
                onChange={(e) => setCompanySettings({ ...companySettings, theme_template: e.target.value })}
                className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-xs font-black uppercase text-slate-800 outline-none focus:border-sky-500 transition"
                style={{ color: 'inherit' }}
              >
                <option value="blue">Blue Theme</option>
                <option value="green">Green Theme</option>
              </select>
              <button onClick={handleSaveDashboardConfig} className="px-6 py-3 bg-emerald-500 text-white rounded-xl font-black uppercase text-xs hover:bg-emerald-400 transition">Save Changes</button>
            </>
          ) : (
            <button onClick={() => setIsEditingDashboard(true)} className="px-6 py-3 bg-slate-800 text-white rounded-xl font-black uppercase text-xs hover:bg-slate-700 transition">Edit Dashboard</button>
          )}
        </div>
      </div>

      {/* Boss Executive Direct Navigation Suite */}
      {user?.role === 'boss' && (
        <div className="bg-slate-900/40 border border-amber-500/20 rounded-[2rem] p-6 backdrop-blur-xl space-y-4 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
                <i aria-hidden="true" className="fa-solid fa-bolt-lightning text-sm" />
              </div>
              <div>
                <h4 className="text-xs font-black text-white uppercase tracking-wider">Executive Direct Actions</h4>
                <p className="text-[10px] text-slate-400">Monitor and jump directly into any department to modify details instantly</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-black text-amber-400/90 uppercase tracking-widest bg-amber-500/10 border border-amber-500/20 px-3 py-1 rounded-full">
                {backendConferences.filter(c => (c.lifecycle_state || 'open') === 'open').length} Active Conferences • {assets.filter(a => a.status === AssetStatus.IN_USE).length} Gear In Field
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <button
              onClick={() => setCurrentPage('Assets')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 hover:border-sky-500/40 rounded-2xl text-left transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <i aria-hidden="true" className="fa-solid fa-boxes-stacked text-sky-400 text-lg group-hover:scale-110 transition-transform" />
                <i aria-hidden="true" className="fa-solid fa-arrow-right text-[10px] text-slate-600 group-hover:text-sky-400 group-hover:translate-x-0.5 transition-all" />
              </div>
              <p className="text-xs font-black text-white uppercase">Inventory</p>
              <p className="text-[9px] text-slate-400 uppercase tracking-tight">Edit Gear & Pricing</p>
            </button>

            <button
              onClick={() => setCurrentPage('Conferences')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 hover:border-violet-500/40 rounded-2xl text-left transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <i aria-hidden="true" className="fa-solid fa-calendar-check text-violet-400 text-lg group-hover:scale-110 transition-transform" />
                <i aria-hidden="true" className="fa-solid fa-arrow-right text-[10px] text-slate-600 group-hover:text-violet-400 group-hover:translate-x-0.5 transition-all" />
              </div>
              <p className="text-xs font-black text-white uppercase">Conferences</p>
              <p className="text-[9px] text-slate-400 uppercase tracking-tight">Modify Events & GST</p>
            </button>

            <button
              onClick={() => setCurrentPage('Billing')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 hover:border-emerald-500/40 rounded-2xl text-left transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <i aria-hidden="true" className="fa-solid fa-receipt text-emerald-400 text-lg group-hover:scale-110 transition-transform" />
                <i aria-hidden="true" className="fa-solid fa-arrow-right text-[10px] text-slate-600 group-hover:text-emerald-400 group-hover:translate-x-0.5 transition-all" />
              </div>
              <p className="text-xs font-black text-white uppercase">Challans</p>
              <p className="text-[9px] text-slate-400 uppercase tracking-tight">Delivery & Invoicing</p>
            </button>

            <button
              onClick={() => setCurrentPage('Subrentals')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 hover:border-orange-500/40 rounded-2xl text-left transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <i aria-hidden="true" className="fa-solid fa-building-shield text-orange-400 text-lg group-hover:scale-110 transition-transform" />
                <i aria-hidden="true" className="fa-solid fa-arrow-right text-[10px] text-slate-600 group-hover:text-orange-400 group-hover:translate-x-0.5 transition-all" />
              </div>
              <p className="text-xs font-black text-white uppercase">Subrentals</p>
              <p className="text-[9px] text-slate-400 uppercase tracking-tight">Vendors & Rentals</p>
            </button>

            <button
              onClick={() => setCurrentPage('Settings')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 hover:border-amber-500/40 rounded-2xl text-left transition-all group col-span-2 sm:col-span-1"
            >
              <div className="flex items-center justify-between mb-2">
                <i aria-hidden="true" className="fa-solid fa-users-gear text-amber-400 text-lg group-hover:scale-110 transition-transform" />
                <i aria-hidden="true" className="fa-solid fa-arrow-right text-[10px] text-slate-600 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all" />
              </div>
              <p className="text-xs font-black text-white uppercase">Staff & Roles</p>
              <p className="text-[9px] text-slate-400 uppercase tracking-tight">Security & Team</p>
            </button>
          </div>
        </div>
      )}


      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { key: 'total_assets', label: companySettings?.dashboard_config?.total_assets_label || 'All Permanent Records', val: stats.total, icon: 'fa-boxes-stacked', color: 'text-sky-400' },
          { key: 'in_use', label: companySettings?.dashboard_config?.in_use_label || 'Currently In Use', val: stats.inUse, icon: 'fa-truck-fast', color: 'text-orange-400' },
          { key: 'available', label: companySettings?.dashboard_config?.available_label || 'Ready / Available', val: stats.available, icon: 'fa-warehouse', color: 'text-emerald-400' },
          { key: 'active_conferences', label: companySettings?.dashboard_config?.active_conferences_label || 'Active Conferences', val: activeConferencesCount, icon: 'fa-calendar-check', color: 'text-violet-400' }
        ].filter(item => isEditingDashboard || companySettings?.dashboard_config?.[item.key] !== false).map((item, i) => (
          <div
            key={i}
            onClick={() => handleDashboardStatClick(item.key)}
            className={`bg-slate-900/40 backdrop-blur-xl p-8 rounded-[2rem] border border-slate-800/60 shadow-xl relative group ${
              !isEditingDashboard ? 'cursor-pointer hover:border-sky-500/50 hover:bg-slate-900/70 hover:shadow-sky-500/10 hover:-translate-y-1 active:translate-y-0 transition-all duration-200' : ''
            } ${isEditingDashboard && companySettings?.dashboard_config?.[item.key] === false ? 'opacity-40 grayscale' : ''}`}
            title={!isEditingDashboard ? `Click to view ${item.label}` : undefined}
          >
            {isEditingDashboard ? (
              <div className="absolute top-4 right-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => {
                    const nl = prompt("Enter new label for " + item.label, item.label);
                    if (nl) handleUpdateLabel(item.key, nl);
                  }}
                  className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
                  title="Edit Label"
                >
                  <i aria-hidden="true" className="fa-solid fa-pen text-[10px]" />
                </button>
                <button
                  onClick={() => toggleCardVisibility(item.key)}
                  className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
                >
                  <i aria-hidden="true" className={`fa-solid ${companySettings?.dashboard_config?.[item.key] === false ? 'fa-eye-slash' : 'fa-eye'} text-xs`} />
                </button>
              </div>
            ) : (
              <div className="absolute top-6 right-6 w-8 h-8 rounded-full bg-slate-800/50 group-hover:bg-sky-500/20 group-hover:text-sky-400 flex items-center justify-center text-slate-500 transition-all duration-200">
                <i aria-hidden="true" className="fa-solid fa-arrow-right text-[11px] group-hover:translate-x-0.5 transition-transform" />
              </div>
            )}
            <i aria-hidden="true" className={`fa-solid ${item.icon} ${item.color} text-2xl mb-6`}></i>
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1">{item.label}</p>
            <h3 className="text-4xl font-black text-white">{item.val ?? '—'}</h3>
          </div>
        ))}
      </div>



      {/* Active Conferences Table */}
      {(isEditingDashboard || companySettings?.dashboard_config?.active_conferences_table !== false) && (
        <div className={`bg-slate-900/30 backdrop-blur-xl p-6 md:p-10 rounded-[1.5rem] md:rounded-[2.5rem] border border-slate-800/50 shadow-xl relative ${isEditingDashboard && companySettings?.dashboard_config?.active_conferences_table === false ? 'opacity-40 grayscale' : ''}`}>
          {isEditingDashboard && (
            <div className="absolute top-4 right-4 flex gap-2">
              <button
                onClick={() => {
                  const nl = prompt("Enter new title for this table", companySettings?.dashboard_config?.active_conferences_table_label || "Active Conferences");
                  if (nl) handleUpdateLabel('active_conferences_table', nl);
                }}
                className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
              >
                <i aria-hidden="true" className="fa-solid fa-pen text-[10px]" />
              </button>
              <button
                onClick={() => toggleCardVisibility('active_conferences_table')}
                className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
              >
                <i aria-hidden="true" className={`fa-solid ${companySettings?.dashboard_config?.active_conferences_table === false ? 'fa-eye-slash' : 'fa-eye'} text-xs`} />
              </button>
            </div>
          )}
          <h3 className="text-xl md:text-2xl font-black text-white uppercase mb-8">{companySettings?.dashboard_config?.active_conferences_table_label || "Active Conferences"}</h3>
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left min-w-[700px]">
              <thead className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                <tr>
                  <th className="pb-6">Conference</th>
                  <th className="pb-6">Association</th>
                  <th className="pb-6">Duration</th>
                  <th className="pb-6">Status</th>
                  <th className="pb-6 text-right">Direct Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/20">
                {filteredConferences.filter(conf => {
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const start = new Date(conf.startDate);
                  const end = new Date(conf.endDate);
                  return today >= start && today <= end;
                }).map(conf => (
                  <tr
                    key={conf.id}
                    onClick={() => openEditConferenceForm(conf)}
                    className="text-xs font-bold text-slate-300 hover:bg-slate-800/40 cursor-pointer transition-colors group/row"
                    title="Click to directly open and edit conference details"
                  >
                    <td className="py-4 text-white uppercase font-black">
                      <div className="flex items-center gap-2">
                        <span>{conf.name}</span>
                        <i aria-hidden="true" className="fa-solid fa-arrow-up-right text-[8px] text-slate-500 group-hover/row:text-sky-400 opacity-0 group-hover/row:opacity-100 transition-all" />
                      </div>
                    </td>
                    <td className="py-4 opacity-70 uppercase">{conf.association}</td>
                    <td className="py-4 font-mono text-sky-400">{new Date(conf.startDate).toLocaleDateString()} - {new Date(conf.endDate).toLocaleDateString()}</td>
                    <td className="py-4">
                      <span className="px-3 py-1 rounded-full text-[9px] font-black uppercase bg-violet-500/10 text-violet-400">Live</span>
                    </td>
                    <td className="py-4 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditConferenceForm(conf);
                        }}
                        className="px-3 py-1.5 bg-sky-500/10 text-sky-400 hover:bg-sky-500 hover:text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all inline-flex items-center gap-1.5 shadow-sm"
                        title="Directly edit conference details"
                      >
                        <i aria-hidden="true" className="fa-solid fa-pen text-[8px]" /> Direct Edit
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredConferences.filter(conf => {
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const start = new Date(conf.startDate);
                  const end = new Date(conf.endDate);
                  return today >= start && today <= end;
                }).length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-600 uppercase tracking-widest text-[10px]">No active conferences</td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Active Allocations Table */}
      {(isEditingDashboard || companySettings?.dashboard_config?.active_allocations_table !== false) && (
        <div className={`bg-slate-900/30 backdrop-blur-xl p-6 md:p-10 rounded-[1.5rem] md:rounded-[2.5rem] border border-slate-800/50 shadow-xl relative mt-8 ${isEditingDashboard && companySettings?.dashboard_config?.active_allocations_table === false ? 'opacity-40 grayscale' : ''}`}>
          {isEditingDashboard && (
            <div className="absolute top-4 right-4 flex gap-2">
              <button
                onClick={() => {
                  const nl = prompt("Enter new title for this table", companySettings?.dashboard_config?.active_allocations_table_label || "Active Allocations");
                  if (nl) handleUpdateLabel('active_allocations_table', nl);
                }}
                className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
              >
                <i aria-hidden="true" className="fa-solid fa-pen text-[10px]" />
              </button>
              <button
                onClick={() => toggleCardVisibility('active_allocations_table')}
                className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
              >
                <i aria-hidden="true" className={`fa-solid ${companySettings?.dashboard_config?.active_allocations_table === false ? 'fa-eye-slash' : 'fa-eye'} text-xs`} />
              </button>
            </div>
          )}
          <h3 className="text-xl md:text-2xl font-black text-white uppercase mb-8">{companySettings?.dashboard_config?.active_allocations_table_label || "Active Allocations"}</h3>
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left min-w-[600px]">
              <thead className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                <tr>
                  <th className="pb-6">Asset</th>
                  <th className="pb-6">Assigned To</th>
                  <th className="pb-6">Department</th>
                  <th className="pb-6">Status</th>
                  <th className="pb-6 text-right">Direct Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/20">
                {(allocationAssets || []).map(asset => {
                  const emp = employees.find(e => e.id.toString() === asset.assigned_to?.toString());
                  return (
                    <tr
                      key={asset.id}
                      onClick={() => openEditAssetForm(asset)}
                      className="text-xs font-bold text-slate-300 hover:bg-slate-800/40 cursor-pointer transition-colors group/row"
                      title="Click to directly view/edit this asset"
                    >
                      <td className="py-4 font-mono text-sky-400 font-black">
                        <div className="flex items-center gap-2">
                          <span>{asset.aliasName || asset.sku}</span>
                          <span className="opacity-50 font-normal">({asset.serialNumber || 'No S/N'})</span>
                          <i aria-hidden="true" className="fa-solid fa-arrow-up-right text-[8px] text-slate-500 group-hover/row:text-sky-400 opacity-0 group-hover/row:opacity-100 transition-all" />
                        </div>
                      </td>
                      <td className="py-4 text-white uppercase">{emp?.name || asset.assigned_to_name || 'Unknown'}</td>
                      <td className="py-4 opacity-70 uppercase">{emp?.department || '-'}</td>
                      <td className="py-4">
                        <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase ${asset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' :
                          asset.status === AssetStatus.IN_USE ? 'bg-orange-500/10 text-orange-400' : 'bg-red-500/10 text-red-400'
                          }`}>{asset.status}</span>
                      </td>
                      <td className="py-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditAssetForm(asset);
                          }}
                          className="px-3 py-1.5 bg-sky-500/10 text-sky-400 hover:bg-sky-500 hover:text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all inline-flex items-center gap-1.5 shadow-sm"
                          title="Directly edit asset details"
                        >
                          <i aria-hidden="true" className="fa-solid fa-pen text-[8px]" /> Direct Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {allocationLoadError && <tr><td colSpan={5} role="alert">{allocationLoadError} Displayed records may be out of date. <button type="button" onClick={fetchDashboardStats}>Retry allocations</button></td></tr>}
                {!allocationLoadError && (allocationAssets === null || allocationAssets.length === 0) && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-600 uppercase tracking-widest text-[10px]">{allocationAssets === null ? 'Allocation summary not loaded' : 'No active allocations'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>

  );

  const renderInventory = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
        <h2 className="text-4xl md:text-5xl font-black text-orange-500 tracking-tighter uppercase">Inventory</h2>
        <div className="flex flex-wrap gap-2 md:gap-3">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            accept=".xlsx, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          />
          <button
            onClick={handleDownloadTemplate}
            className="flex-1 md:flex-none px-4 md:px-6 py-3 md:py-4 bg-slate-800/60 text-slate-300 border border-slate-700 rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-slate-700 transition flex items-center justify-center gap-2"
          >
            <i aria-hidden="true" className="fa-solid fa-file-arrow-down" /> Template
          </button>
          {(user?.is_staff || user?.role === 'admin' || user?.role === 'boss') && (
            <button
              onClick={() => { setUploadResult(null); fileInputRef.current?.click(); }}
              className="flex-1 md:flex-none px-4 md:px-6 py-3 md:py-4 bg-slate-800 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-slate-700 transition flex items-center justify-center gap-2"
            >
              <i aria-hidden="true" className="fa-solid fa-file-csv" /> Import
            </button>
          )}
          <button
            onClick={() => handleExportInventory('master')}
            className="flex-1 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 hover:from-emerald-500/30 hover:to-teal-500/30 text-emerald-400 font-bold py-3 px-4 rounded-xl border border-emerald-500/20 hover:border-emerald-500/50 transition-all text-xs shadow-lg shadow-emerald-500/10 flex items-center justify-center gap-2 group whitespace-nowrap"
            title="Export full inventory master database"
          >
            <i aria-hidden="true" className="fa-solid fa-file-excel" /> Export Stocks
          </button>

          <button
            onClick={handleExportSearchResults}
            disabled={filteredInventoryAssets.length === 0}
            className="flex-1 bg-gradient-to-r from-sky-500/10 to-indigo-500/10 hover:from-sky-500/30 hover:to-indigo-500/30 text-sky-400 font-bold py-3 px-4 rounded-xl border border-sky-500/20 hover:border-sky-500/50 transition-all text-xs shadow-lg shadow-sky-500/10 flex items-center justify-center gap-2 group whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
            title="Export current search/filtered results to Excel"
          >
            <i aria-hidden="true" className="fa-solid fa-file-excel" /> Export Search ({filteredInventoryAssets.length})
          </button>

          <button
            onClick={handleDownloadInventoryPDF}
            className="flex-1 md:flex-none px-4 md:px-6 py-3 md:py-4 bg-orange-600 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-orange-500 transition flex items-center justify-center gap-2 shadow-lg shadow-orange-500/20"
          >
            <i aria-hidden="true" className="fa-solid fa-file-pdf" /> PDF
          </button>

          <button
            onClick={() => {
              setInventoryCategoryFilter(prev => prev === 'Consumables' ? 'All' : 'Consumables');
              setSelectedAlias('All');
              setInventoryPage(1);
            }}
            className={`flex-1 md:flex-none px-4 md:px-6 py-3 md:py-4 rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs transition flex items-center justify-center gap-2 shadow-lg ${
              inventoryCategoryFilter === 'Consumables'
                ? 'bg-amber-500 text-white shadow-amber-500/30 ring-2 ring-amber-400'
                : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}
          >
            <i aria-hidden="true" className="fa-solid fa-cubes" /> Consumables
          </button>
          {user?.role !== 'accounts' && (
            <div className="flex gap-2">
              <div className="relative" ref={registerDropdownRef}>
                <button
                  onClick={() => setIsRegisterDropdownOpen(!isRegisterDropdownOpen)}
                  className="px-4 md:px-6 py-3 md:py-4 bg-emerald-500 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-emerald-400 transition flex items-center gap-2"
                >
                  Register New <i aria-hidden="true" className={`fa-solid fa-chevron-${isRegisterDropdownOpen ? 'up' : 'down'} text-[8px]`} />
                </button>

              {isRegisterDropdownOpen && (
                <div className="absolute top-full right-0 mt-2 w-48 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                  <button
                    onClick={() => { openNewAssetForm(); setIsRegisterDropdownOpen(false); }}
                    className="w-full text-left px-6 py-4 text-xs font-black text-white uppercase hover:bg-slate-800 transition flex items-center gap-3"
                  >
                    <i aria-hidden="true" className="fa-solid fa-plus-circle text-emerald-500" /> Standard Asset
                  </button>
                  <div className="h-[1px] bg-slate-800" />
                  <button
                    onClick={() => { openConsumableForm(); setIsRegisterDropdownOpen(false); }}
                    className="w-full text-left px-6 py-4 text-xs font-black text-white uppercase hover:bg-slate-800 transition flex items-center gap-3"
                  >
                    <i aria-hidden="true" className="fa-solid fa-cubes text-amber-500" /> Consumable
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      </div>

      {uploadFeedback && (
        <div className="w-full text-right text-xs">
          {uploadFeedback.type === 'loading' && <div className="text-blue-600 animate-pulse font-medium">{uploadFeedback.text}</div>}
          {uploadFeedback.type === 'success' && <div className="p-3 bg-green-50 text-green-700 border border-green-200 rounded font-semibold">{uploadFeedback.text}</div>}
          {uploadFeedback.type === 'error' && <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded font-semibold">{uploadFeedback.text}</div>}
        </div>
      )}

      {/* Upload Result Banner */}
      {uploadResult && (
        <div className={`rounded-2xl border p-5 flex items-start gap-4 ${uploadResult.errors.length > 0 && uploadResult.created === 0
          ? 'bg-red-500/10 border-red-500/20'
          : 'bg-slate-900/60 border-slate-800'
          }`}>
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-4 flex-wrap">
              {uploadResult.created > 0 && (
                <span className="text-xs font-black text-emerald-400">✅ {uploadResult.created} asset{uploadResult.created !== 1 ? 's' : ''} created</span>
              )}
              {uploadResult.skipped > 0 && (
                <span className="text-xs font-black text-amber-400">⏭️ {uploadResult.skipped} skipped (already exist)</span>
              )}
              {uploadResult.errors.length > 0 && (
                <span className="text-xs font-black text-red-400">❌ {uploadResult.errors.length} error{uploadResult.errors.length !== 1 ? 's' : ''}</span>
              )}
            </div>
            {uploadResult.errors.length > 0 && (
              <ul className="mt-2 space-y-1">
                {uploadResult.errors.map((err, i) => (
                  <li key={i} className="text-[10px] text-red-400 font-mono">{err}</li>
                ))}
              </ul>
            )}
          </div>
          <button onClick={() => setUploadResult(null)} className="text-slate-500 hover:text-white transition">
            <i aria-hidden="true" className="fa-solid fa-xmark" />
          </button>
        </div>
      )}


      <div className="bg-slate-900/30 rounded-[1.5rem] md:rounded-[2rem] border border-slate-800/50 overflow-hidden">
        <div className="p-4 md:p-6 border-b border-slate-800/40 space-y-4">
          {/* Row 1: Primary Search Bar (Full Width, Crisp & Highly Visible) */}
          <div className="relative group w-full">
            <i aria-hidden="true" className="fa-solid fa-magnifying-glass absolute left-3.5 sm:left-4 md:left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors text-xs md:text-sm pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                const val = e.target.value;
                setSearchQuery(val);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const code = searchQuery.trim();
                  if (!code) return;
                  handleScan(code);
                }
              }}
              placeholder="Search equipment, SKU, serial, MAC..."
              ref={inventorySearchRef}
              style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
              className="w-full pl-9 sm:pl-11 md:pl-12 pr-20 sm:pr-24 md:pr-36 py-3 sm:py-3.5 md:py-4 rounded-2xl border border-slate-300 bg-white text-slate-900 font-bold text-xs md:text-sm uppercase tracking-wide focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10 outline-none transition-all placeholder:text-slate-400 placeholder:normal-case shadow-sm"
            />
            {/* Right side controls: Item count badge & Clear button & Camera Scanner */}
            <div className="absolute right-2.5 sm:right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 sm:gap-2">
              {searchQuery.trim() && (
                <>
                  <span className="hidden sm:inline-block bg-sky-50 text-sky-600 border border-sky-200 text-[10px] md:text-xs font-black px-2.5 py-1 rounded-lg uppercase tracking-wider whitespace-nowrap shadow-sm">
                    {filteredInventoryAssets.length} {filteredInventoryAssets.length === 1 ? 'item' : 'items'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      inventorySearchRef.current?.focus();
                    }}
                    className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-400 hover:text-slate-600 flex items-center justify-center transition active:scale-95"
                    title="Clear search"
                  >
                    <i aria-hidden="true" className="fa-solid fa-xmark text-xs" />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 bg-sky-500/10 text-sky-600 hover:bg-sky-500 hover:text-white rounded-xl flex items-center justify-center transition active:scale-95 shadow-sm group/btn"
                title="Scan with Camera"
              >
                <i aria-hidden="true" className="fa-solid fa-camera text-xs sm:text-sm group-hover/btn:scale-110 transition-transform" />
              </button>
            </div>
          </div>

          {/* Row 2: Secondary Filter Bar (Status, Sort, Category, Alias, Purchase Date) */}
          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3">
            {/* Status Filter */}
            <div className="flex-1 sm:flex-initial sm:w-48 min-w-[160px]">
              <select
                value={inventoryStatusFilter}
                onChange={(e) => {
                  setInventoryStatusFilter(e.target.value);
                  setInventoryPage(1);
                }}
                className={`w-full bg-white border ${inventoryStatusFilter !== 'All' ? 'border-sky-500 ring-2 ring-sky-500/20' : 'border-slate-300'} rounded-xl px-4 py-2.5 md:py-3 text-slate-800 font-bold text-xs uppercase outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 transition-all cursor-pointer appearance-none shadow-sm`}
                style={{
                  color: '#0f172a',
                  backgroundColor: '#ffffff',
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%2364748b\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'%3E%3C/path%3E%3C/svg%3E")',
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 1rem center',
                  backgroundSize: '1rem'
                }}
              >
                <option value="All">All Statuses</option>
                <option value="Available">Ready / Available</option>
                <option value="In Use">Currently In Use</option>
                <option value="Crosscheck">Crosscheck</option>
                <option value="Damaged">Damaged</option>
                <option value="On Service">On Service</option>
                <option value="Missing">Missing</option>
                <option value="Expired">Expired</option>
              </select>
            </div>

            {/* Sort Order */}
            <div className="flex-1 sm:flex-initial sm:w-48 min-w-[160px]">
              <select
                value={inventorySortOption}
                onChange={(e) => {
                  setInventorySortOption(e.target.value);
                  setInventoryPage(1);
                }}
                className={`w-full bg-white border ${inventorySortOption !== 'newest' ? 'border-sky-500 ring-2 ring-sky-500/20' : 'border-slate-300'} rounded-xl px-4 py-2.5 md:py-3 text-slate-800 font-bold text-xs uppercase outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 transition-all cursor-pointer appearance-none shadow-sm`}
                style={{
                  color: '#0f172a',
                  backgroundColor: '#ffffff',
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%2364748b\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'%3E%3C/path%3E%3C/svg%3E")',
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 1rem center',
                  backgroundSize: '1rem'
                }}
              >
                <option value="newest">Sort: Newest First</option>
                <option value="oldest">Sort: Oldest First</option>
                <option value="name-asc">Sort: Name (A-Z)</option>
                <option value="sku-asc">Sort: SKU (A-Z)</option>
                <option value="qty-desc">Sort: Quantity (High-Low)</option>
                <option value="price-desc">Sort: Price (High-Low)</option>
              </select>
            </div>

            {/* Category Filter */}
            <div className="flex-1 sm:flex-initial sm:w-52 min-w-[160px]">
              <select
                value={inventoryCategoryFilter}
                onChange={(e) => {
                  setInventoryCategoryFilter(e.target.value);
                  setInventoryPage(1);
                }}
                className="w-full bg-white border border-slate-300 rounded-xl px-4 py-2.5 md:py-3 text-slate-800 font-bold text-xs uppercase outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 transition-all cursor-pointer appearance-none shadow-sm"
                style={{
                  color: '#0f172a',
                  backgroundColor: '#ffffff',
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%2364748b\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'%3E%3C/path%3E%3C/svg%3E")',
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 1rem center',
                  backgroundSize: '1rem'
                }}
              >
                {derivedCategories.map(cat => (
                  <option key={cat} value={cat}>{cat === 'All' ? 'All Categories' : cat}</option>
                ))}
              </select>
            </div>

            {/* Alias Filter */}
            <div className="flex-1 sm:flex-initial sm:w-52 min-w-[160px]">
              <select
                value={selectedAlias}
                onChange={(e) => {
                  setSelectedAlias(e.target.value);
                  setInventoryPage(1);
                }}
                className="w-full bg-white border border-slate-300 rounded-xl px-4 py-2.5 md:py-3 text-slate-800 font-bold text-xs uppercase outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 transition-all cursor-pointer appearance-none shadow-sm"
                style={{
                  color: '#0f172a',
                  backgroundColor: '#ffffff',
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%2364748b\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'%3E%3C/path%3E%3C/svg%3E")',
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 1rem center',
                  backgroundSize: '1rem'
                }}
              >
                {uniqueAliases.map(({ label, value, count }) => (
                  <option key={value} value={value}>
                    {value === 'All' ? 'All Aliases' : `${label} (${count})`}
                  </option>
                ))}
              </select>
            </div>

            {/* Purchase Date Range Filter */}
            <div className="flex items-center gap-2 bg-white border border-slate-300 rounded-xl px-4 py-2.5 md:py-3 text-slate-800 shadow-sm shrink-0">
              <i aria-hidden="true" className="fa-regular fa-calendar text-sky-500 text-xs" />
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider whitespace-nowrap">Purchased:</span>
              <input
                type="date"
                value={purchaseDateFrom}
                onChange={(e) => {
                  setPurchaseDateFrom(e.target.value);
                  setInventoryPage(1);
                }}
                style={{ color: '#0f172a', backgroundColor: 'transparent' }}
                className="bg-transparent text-slate-800 text-xs font-bold outline-none cursor-pointer"
                title="Purchase Date From"
              />
              <span className="text-slate-400 text-xs font-bold">to</span>
              <input
                type="date"
                value={purchaseDateTo}
                onChange={(e) => {
                  setPurchaseDateTo(e.target.value);
                  setInventoryPage(1);
                }}
                style={{ color: '#0f172a', backgroundColor: 'transparent' }}
                className="bg-transparent text-slate-800 text-xs font-bold outline-none cursor-pointer"
                title="Purchase Date To"
              />
              {(purchaseDateFrom || purchaseDateTo) && (
                <button
                  type="button"
                  onClick={() => {
                    setPurchaseDateFrom('');
                    setPurchaseDateTo('');
                    setInventoryPage(1);
                  }}
                  className="text-slate-400 hover:text-red-500 p-1 transition ml-1"
                  title="Clear Date Range"
                >
                  <i aria-hidden="true" className="fa-solid fa-xmark text-xs" />
                </button>
              )}
            </div>

            {/* Active Status Filter Chip */}
            {inventoryStatusFilter !== 'All' && (
              <div className="flex items-center gap-1.5 px-3 py-2 bg-sky-500/10 border border-sky-500/30 rounded-xl text-sky-400 text-[10px] font-black uppercase tracking-wider">
                <i aria-hidden="true" className="fa-solid fa-filter text-[9px]" />
                <span>Status: {inventoryStatusFilter}</span>
                <button
                  type="button"
                  onClick={() => {
                    setInventoryStatusFilter('All');
                    setInventoryPage(1);
                  }}
                  className="w-4 h-4 ml-1 rounded-full bg-sky-500/20 hover:bg-sky-500/40 text-sky-300 flex items-center justify-center transition"
                  title="Clear status filter"
                >
                  <i aria-hidden="true" className="fa-solid fa-xmark text-[8px]" />
                </button>
              </div>
            )}

            {/* Active Filters Reset Pill */}
            {(inventoryStatusFilter !== 'All' || inventorySortOption !== 'newest' || inventoryCategoryFilter !== 'All' || selectedAlias !== 'All' || purchaseDateFrom || purchaseDateTo || searchQuery) && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setInventoryStatusFilter('All');
                  setInventorySortOption('newest');
                  setInventoryCategoryFilter('All');
                  setSelectedAlias('All');
                  setPurchaseDateFrom('');
                  setPurchaseDateTo('');
                  setInventoryPage(1);
                }}
                className="px-3 py-2 text-[10px] font-black uppercase tracking-wider text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-xl transition flex items-center gap-1.5 self-center"
                title="Reset all search and filter conditions"
              >
                <i aria-hidden="true" className="fa-solid fa-rotate-left text-[9px]" /> Reset Filters
              </button>
            )}
          </div>
        </div>

        {/* Mobile View: Cards (Visible only on mobile/PDA) */}
        <div className="md:hidden divide-y divide-slate-800/40">
          {paginatedInventoryAssets.length > 0 ? (
            paginatedInventoryAssets.map((asset) => (
              <div key={asset.id} onClick={() => openAssetDetails(asset)} className="p-4 space-y-3 active:bg-slate-800/20 transition-colors">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-black text-sky-400 font-mono uppercase truncate">{asset.sku}</p>
                    <div className="flex items-center gap-2 mt-1 min-w-0">
                      <h4 className="text-base font-black text-white uppercase truncate flex-1">{getLaptopSubGroup(asset, undefined, undefined, undefined, true) || asset.aliasName || 'Untitled Asset'}</h4>
                      {asset.sub_assets && asset.sub_assets.length > 0 && (
                        <span className="w-5 h-5 bg-sky-500/20 text-sky-400 rounded-lg flex items-center justify-center text-[8px]" title="Main Asset with Components">
                          <i aria-hidden="true" className="fa-solid fa-boxes-stacked" />
                        </span>
                      )}
                      {asset.parent_asset && (
                        <span className="w-5 h-5 bg-emerald-500/20 text-emerald-400 rounded-lg flex items-center justify-center text-[8px]" title="Component / Sub-Asset">
                          <i aria-hidden="true" className="fa-solid fa-link" />
                        </span>
                      )}
                      {asset.flag && asset.flag !== '' && (
                        <span className="w-5 h-5 bg-red-500/20 text-red-500 rounded-lg flex items-center justify-center text-[8px]" title={`Flagged: ${asset.flag}`}>
                          <i aria-hidden="true" className="fa-solid fa-flag" />
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`px-3 py-1 rounded-full text-[8px] font-black uppercase ${asset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' :
                      asset.status === AssetStatus.IN_USE ? 'bg-orange-500/10 text-orange-400' :
                        asset.status === AssetStatus.CROSSCHECK ? 'bg-indigo-500/10 text-indigo-400' :
                          'bg-red-500/10 text-red-400'
                      }`}>{asset.status}</span>
                    {getAssetConferenceName(asset) && (
                      <span className="text-[8px] font-black text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded uppercase tracking-tight flex items-center gap-1 max-w-[110px] truncate" title={`Deployed to: ${getAssetConferenceName(asset)}`}>
                        <i aria-hidden="true" className="fa-solid fa-location-dot text-[7px] shrink-0" />
                        <span className="truncate">{getAssetConferenceName(asset)}</span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex justify-between items-center text-[10px]">
                  <p className="text-slate-500 font-bold uppercase">{asset.type}</p>
                  {(asset.type === AssetCategory.CONSUMABLES || inventoryCategoryFilter === 'Consumables') ? (
                    asset.status === AssetStatus.AVAILABLE ? (
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <span className="text-[9px] font-black text-slate-400 uppercase mr-1">Qty:</span>
                        <button
                          type="button"
                          onClick={() => handleUpdateConsumableQuantity(asset.id, Math.max(0, (asset.quantity || 0) - 1))}
                          className="w-6 h-6 bg-slate-800 text-slate-300 rounded flex items-center justify-center font-bold text-xs"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          min="0"
                          value={asset.quantity ?? 0}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            if (!isNaN(val) && val >= 0) {
                              handleUpdateConsumableQuantity(asset.id, val);
                            }
                          }}
                          className="w-12 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-center text-xs font-black text-amber-400"
                        />
                        <button
                          type="button"
                          onClick={() => handleUpdateConsumableQuantity(asset.id, (asset.quantity || 0) + 1)}
                          className="w-6 h-6 bg-slate-800 text-slate-300 rounded flex items-center justify-center font-bold text-xs"
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-black text-slate-400 uppercase">Qty:</span>
                        <span className="text-xs font-black text-amber-400">{asset.quantity ?? 1}</span>
                        <span className="text-[8px] font-bold text-orange-400 uppercase tracking-tighter">(In Use)</span>
                      </div>
                    )
                  ) : (
                    user?.role !== 'accounts' ? (
                      <div className="flex gap-4">
                        <button onClick={(e) => { e.stopPropagation(); openEditAssetForm(asset); }} className="text-sky-400"><i aria-hidden="true" className="fa-solid fa-pen"></i></button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (asset.status !== AssetStatus.AVAILABLE) {
                              alert(`🔒 Cannot delete "${asset.aliasName || asset.sku}" while it is In Use by an active event.`);
                              return;
                            }
                            handleDeleteAsset(asset.id);
                          }}
                          className={asset.status !== AssetStatus.AVAILABLE ? "text-slate-600 cursor-not-allowed" : "text-red-400"}
                          title={asset.status !== AssetStatus.AVAILABLE ? "Cannot delete asset while In Use" : "Delete Asset"}
                        >
                          <i aria-hidden="true" className="fa-solid fa-trash"></i>
                        </button>
                      </div>
                    ) : (
                      <span className="text-[9px] text-slate-600 font-black uppercase">View Only</span>
                    )
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="py-20 text-center w-full">
              <i aria-hidden="true" className="fa-solid fa-magnifying-glass text-4xl text-slate-800 mb-4 scale-x-[-1]"></i>
              <p className="text-xs font-black text-slate-600 uppercase tracking-widest">No assets found</p>
            </div>
          )}
        </div>
        <div className="hidden md:block overflow-x-auto custom-scrollbar">
          <table className="w-full text-left min-w-[1000px]">
            <thead className="bg-slate-950/40 text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
              <tr>
                <th className="px-6 py-6">SKU</th>
                <th className="px-6 py-6 min-w-[300px]">Alias Name</th>
                <th className="px-6 py-6">Serial Number</th>
                <th className="px-6 py-6">Description</th>
                <th className="px-6 py-6">Type</th>
                <th className="px-6 py-6 text-center">Qty</th>
                <th className="px-6 py-6 text-center">Status</th>
                <th className="px-6 py-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/20">
              {paginatedInventoryAssets.length > 0 ? (
                paginatedInventoryAssets.map((asset) => (
                  <tr key={asset.id} onClick={() => openAssetDetails(asset)} className="hover:bg-slate-800/10 transition cursor-pointer group">
                    <td className="px-6 py-6">
                      <p className="text-xs font-black text-sky-400 font-mono">{asset.sku}</p>
                    </td>
                    <td className="px-6 py-6">
                      <div className="flex items-center gap-3">
                        <div>
                          <p className="font-black text-white text-base uppercase max-w-[500px] leading-snug break-words">{getLaptopSubGroup(asset, undefined, undefined, undefined, true) || asset.aliasName || '-'}</p>
                          <p className="text-[9px] text-slate-500 font-black mt-1 uppercase truncate">MAC: {asset.macAddress || 'N/A'}</p>
                        </div>
                        {asset.sub_assets && asset.sub_assets.length > 0 && (
                          <div className="px-2 py-1 bg-sky-500/10 border border-sky-500/20 rounded-md flex items-center gap-1.5" title="Main Asset">
                            <i aria-hidden="true" className="fa-solid fa-boxes-stacked text-[8px] text-sky-400" />
                            <span className="text-[8px] font-black text-sky-400 uppercase tracking-tighter">{asset.sub_assets.length}</span>
                          </div>
                        )}
                        {asset.parent_asset && (
                          <div className="px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-md flex items-center gap-1" title="Sub-Asset / Component">
                            <i aria-hidden="true" className="fa-solid fa-link text-[8px] text-emerald-400" />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-6">
                      <p className="text-xs text-slate-300 font-mono">{asset.serialNumber}</p>
                    </td>
                    <td className="px-6 py-6">
                      <p className="text-[10px] text-slate-400 uppercase line-clamp-1">{asset.description || '-'}</p>
                    </td>
                    <td className="px-6 py-6">
                      <p className="text-[10px] text-slate-500 font-black uppercase">{asset.type}</p>
                    </td>
                    <td className="px-6 py-6 text-center">
                      {(asset.type === AssetCategory.CONSUMABLES || inventoryCategoryFilter === 'Consumables') ? (
                        asset.status === AssetStatus.AVAILABLE && user?.role !== 'accounts' ? (
                          <div className="flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => handleUpdateConsumableQuantity(asset.id, Math.max(0, (asset.quantity || 0) - 1))}
                              className="w-7 h-7 bg-slate-800 hover:bg-amber-500 hover:text-white text-slate-300 rounded-lg flex items-center justify-center font-bold text-xs transition"
                              title="Decrease stock"
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min="0"
                              value={asset.quantity ?? 0}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10);
                                if (!isNaN(val) && val >= 0) {
                                  handleUpdateConsumableQuantity(asset.id, val);
                                }
                              }}
                              className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-center text-xs font-black text-amber-400 outline-none focus:border-amber-500"
                            />
                            <button
                              type="button"
                              onClick={() => handleUpdateConsumableQuantity(asset.id, (asset.quantity || 0) + 1)}
                              className="w-7 h-7 bg-slate-800 hover:bg-amber-500 hover:text-white text-slate-300 rounded-lg flex items-center justify-center font-bold text-xs transition"
                              title="Increase stock"
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center">
                            <span className="text-xs font-black text-amber-400">{asset.quantity ?? 1}</span>
                            <span className="text-[8px] font-bold text-orange-400 uppercase tracking-tighter">(In Use)</span>
                          </div>
                        )
                      ) : (
                        <p className="text-xs font-black text-white">{asset.quantity ?? 1}</p>
                      )}
                    </td>
                    <td className="px-6 py-6 text-center">
                      <div className="flex flex-col items-center gap-1.5">
                        <span className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase ${asset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' :
                          asset.status === AssetStatus.IN_USE ? 'bg-orange-500/10 text-orange-400' :
                            asset.status === AssetStatus.CROSSCHECK ? 'bg-indigo-500/10 text-indigo-400' :
                              'bg-red-500/10 text-red-400'
                          }`}>{asset.status}</span>
                        {getAssetConferenceName(asset) && (
                          <span className="text-[9px] font-black text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2.5 py-0.5 rounded-md uppercase tracking-tight flex items-center gap-1 max-w-[180px] truncate" title={`In Conference: ${getAssetConferenceName(asset)}`}>
                            <i aria-hidden="true" className="fa-solid fa-location-dot text-[8px] shrink-0" />
                            <span className="truncate">{getAssetConferenceName(asset)}</span>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-6 text-right space-x-4">
                      {user?.role !== 'accounts' ? (
                        <>
                          <button onClick={(e) => { e.stopPropagation(); openEditAssetForm(asset); }} className="text-sky-400 hover:text-white"><i aria-hidden="true" className="fa-solid fa-pen"></i></button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (asset.status !== AssetStatus.AVAILABLE) {
                                alert(`🔒 Cannot delete "${asset.aliasName || asset.sku}" while it is In Use by an active event.`);
                                return;
                              }
                              handleDeleteAsset(asset.id);
                            }}
                            className={asset.status !== AssetStatus.AVAILABLE ? "text-slate-600 cursor-not-allowed" : "text-red-400 hover:text-white"}
                            title={asset.status !== AssetStatus.AVAILABLE ? "Cannot delete asset while In Use" : "Delete Asset"}
                          >
                            <i aria-hidden="true" className="fa-solid fa-trash"></i>
                          </button>
                        </>
                      ) : (
                        <span className="text-[10px] text-slate-600 font-black uppercase tracking-wider">View Only</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={10} className="px-6 py-20 text-center">
                    <ScanPrompt title="No Results Found" subtitle="Try a different SKU or category" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filteredInventoryAssets.length > 0 && (
          <div className="p-6 border-t border-slate-800 bg-slate-950/20 flex items-center justify-between">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
              Showing {(inventoryPage - 1) * itemsPerPage + 1} to {Math.min(inventoryPage * itemsPerPage, filteredInventoryAssets.length)} of {filteredInventoryAssets.length} {filteredInventoryAssets.length === 1 ? 'item' : 'items'}
            </p>
            {totalInventoryPages > 1 && (
              <div className="flex gap-2">
                <button disabled={inventoryPage === 1} onClick={() => setInventoryPage(p => p - 1)} className="w-10 h-10 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 disabled:opacity-30 hover:text-white transition"><i aria-hidden="true" className="fa-solid fa-chevron-left"></i></button>
                <button disabled={inventoryPage === totalInventoryPages} onClick={() => setInventoryPage(p => p + 1)} className="w-10 h-10 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 disabled:opacity-30 hover:text-white transition"><i aria-hidden="true" className="fa-solid fa-chevron-right"></i></button>
              </div>
            )}
          </div>
        )}
        
        {isBackgroundSyncing && (
          <div className="p-4 border-t border-slate-800 flex items-center justify-center gap-3 text-slate-500">
            <i aria-hidden="true" className="fa-solid fa-circle-notch fa-spin text-sky-500 text-lg" />
            <span className="text-[10px] font-black uppercase tracking-widest">Syncing remaining database in background...</span>
          </div>
        )}

      </div>
    </div>
  );

  const renderSubrentals = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
        <h2 className="text-4xl md:text-5xl font-black text-sky-500 tracking-tighter uppercase">Subrentals</h2>
        {user?.role !== 'accounts' && (
          <button 
            onClick={() => {
              setEditingSubrentalId(null);
              setSubrentalFormData({ name: '', address: '', gst_number: '' });
              setIsSubrentalFormOpen(true);
            }}
            className="w-full lg:w-auto px-8 py-4 bg-sky-500 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-sky-400 transition"
          >
            Add Company
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {subrentalCompanies.map(company => (
          <div key={company.id} className="bg-slate-900/40 backdrop-blur-xl p-8 rounded-[2rem] border border-slate-800/60 shadow-xl group hover:border-sky-500/30 transition-all cursor-pointer"
            onClick={() => {
              setSelectedSubrentalCompany(company);
              fetchSubrentalTickets(company.id);
              setShowSubrentalInventory(false);
            }}
          >
            <div className="flex justify-between items-start mb-6">
              <div className="w-12 h-12 bg-sky-500/10 rounded-2xl flex items-center justify-center text-sky-400 text-xl border border-sky-500/20">
                <i aria-hidden="true" className="fa-solid fa-building"></i>
              </div>
              {user?.role !== 'accounts' && (
                <div className="flex gap-2">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSubrentalId(company.id);
                      setSubrentalFormData({ name: company.name, address: company.address, gst_number: company.gst_number });
                      setIsSubrentalFormOpen(true);
                    }}
                    className="w-8 h-8 bg-slate-800 text-slate-400 rounded-lg flex items-center justify-center hover:text-sky-400 transition"
                  >
                    <i aria-hidden="true" className="fa-solid fa-pencil text-[10px]"></i>
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSubrentalCompany(company.id);
                    }}
                    className="w-8 h-8 bg-slate-800 text-slate-400 rounded-lg flex items-center justify-center hover:text-red-400 transition"
                  >
                    <i aria-hidden="true" className="fa-solid fa-trash text-[10px]"></i>
                  </button>
                </div>
              )}
            </div>
            <h3 className="text-xl font-black text-white uppercase mb-2 group-hover:text-sky-400 transition-colors">{company.name}</h3>
            <p className="text-xs text-slate-400 mb-2">{company.inventory_mode === 'shared_warehouse' ? 'Shared godown stock' : company.inventory_mode === 'external_supplier' ? 'External supplier catalogue' : 'Inventory classification pending review'}</p>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-4 line-clamp-1">{company.address || 'No Address'}</p>
            <div className="pt-4 border-t border-slate-800/60 flex items-center justify-between">
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">GST: {company.gst_number || 'N/A'}</span>
              <div className="flex items-center gap-1 text-sky-400">
                <span className="text-[9px] font-black uppercase tracking-tighter">View Inventory</span>
                <i aria-hidden="true" className="fa-solid fa-chevron-right text-[8px]"></i>
              </div>
            </div>
          </div>
        ))}
        {subrentalCompanies.length === 0 && (
          <div className="col-span-full py-20 text-center border-2 border-dashed border-slate-800 rounded-[2rem]">
            <i aria-hidden="true" className="fa-solid fa-building-circle-exclamation text-4xl text-slate-800 mb-4"></i>
            <p className="text-xs font-black text-slate-600 uppercase tracking-widest">No Subrental Companies Found</p>
          </div>
        )}
      </div>

      {isSubrentalFormOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 md:p-10">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setIsSubrentalFormOpen(false)}></div>
          <div className="relative w-full max-w-xl bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-10">
              <h3 className="text-3xl font-black text-white uppercase tracking-tighter mb-8">{editingSubrentalId ? 'Edit' : 'Add'} Subrental Company</h3>
              <div className="space-y-6">
                <div>
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Company Name</label>
                  <input 
                    type="text" 
                    value={subrentalFormData.name}
                    onChange={(e) => setSubrentalFormData({...subrentalFormData, name: e.target.value})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Address</label>
                  <textarea 
                    value={subrentalFormData.address}
                    onChange={(e) => setSubrentalFormData({...subrentalFormData, address: e.target.value})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all h-32"
                  ></textarea>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">GST Number</label>
                  <input 
                    type="text" 
                    value={subrentalFormData.gst_number}
                    onChange={(e) => setSubrentalFormData({...subrentalFormData, gst_number: e.target.value})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                  />
                </div>
              </div>
              <div className="flex gap-4 mt-10">
                <button onClick={() => setIsSubrentalFormOpen(false)} className="flex-1 py-4 bg-slate-800 text-slate-300 rounded-2xl font-black uppercase text-xs hover:bg-slate-700 transition">Cancel</button>
                <button onClick={handleSaveSubrentalCompany} className="flex-1 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition">Save Company</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const renderSubrentalTickets = () => {
    if (!selectedSubrentalCompany) return null;

    if (selectedTicket) return renderTicketItems(selectedTicket);

    return (
      <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
          <div className="flex items-center gap-6">
            <button 
              onClick={() => setSelectedSubrentalCompany(null)}
              className="w-12 h-12 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center text-slate-400 hover:text-white transition"
            >
              <i aria-hidden="true" className="fa-solid fa-arrow-left"></i>
            </button>
            <div>
              <h2 className="text-4xl md:text-5xl font-black text-sky-500 tracking-tighter uppercase">{selectedSubrentalCompany.name}</h2>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em] mt-1">Rental Tickets & Assignments</p>
            </div>
          </div>
          <div className="flex gap-3">
            <button 
              onClick={() => {
                setShowSubrentalInventory(true);
                fetchSubrentalAssets(selectedSubrentalCompany.id);
              }}
              className="px-8 py-4 bg-slate-800 text-slate-300 rounded-2xl font-black uppercase text-xs hover:bg-slate-700 transition flex items-center gap-2"
            >
              <i aria-hidden="true" className="fa-solid fa-boxes-stacked"></i> View Inventory
            </button>
            {user?.role !== 'accounts' && (
              <button 
                onClick={() => setIsTicketFormOpen(true)}
                className="px-8 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition"
              >
                Create Ticket
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {subrentalTickets.map(ticket => (
            <div key={ticket.id} onClick={() => setSelectedTicket(ticket)} className="bg-slate-900/40 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-800/60 shadow-xl group hover:border-sky-500/30 transition-all cursor-pointer">
              <div className="flex justify-between items-start mb-6">
                <div className="w-14 h-14 bg-sky-500/10 rounded-2xl flex items-center justify-center text-sky-400 text-2xl border border-sky-500/20">
                  <i aria-hidden="true" className="fa-solid fa-ticket"></i>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1">Items</p>
                  <p className="text-xl font-black text-white">{ticket.items?.length || 0}</p>
                </div>
              </div>
              <h3 className="text-lg font-black text-white uppercase mb-1 group-hover:text-sky-400 transition-colors">{ticket.conference_name}</h3>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-6">Rented for this event</p>
              
              <div className="space-y-3 pt-6 border-t border-slate-800/60">
                <div className="flex justify-between items-center">
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">From</span>
                  <span className="text-[10px] font-mono text-slate-300">{ticket.available_from || 'N/A'}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">To</span>
                  <span className="text-[10px] font-mono text-slate-300">{ticket.available_till || 'N/A'}</span>
                </div>
              </div>
            </div>
          ))}
          {subrentalTickets.length === 0 && (
            <div className="col-span-full py-20 text-center border-2 border-dashed border-slate-800 rounded-[2.5rem]">
              <i aria-hidden="true" className="fa-solid fa-ticket-simple text-4xl text-slate-800 mb-4"></i>
              <p className="text-xs font-black text-slate-600 uppercase tracking-widest">No tickets created for this company</p>
            </div>
          )}
        </div>

        {isTicketFormOpen && renderTicketForm()}
      </div>
    );
  };

  const renderTicketForm = () => (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10">
      <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md" onClick={() => setIsTicketFormOpen(false)}></div>
      <div className="relative w-full max-w-xl bg-slate-900 rounded-[3rem] border border-slate-800 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 p-10">
        <button aria-label="Close supplier ticket form" disabled={supplierSaving.busy} onClick={() => setIsTicketFormOpen(false)}>Close</button>
        <fieldset disabled={supplierSaving.busy || Boolean(supplierSaving.pending)}><h3 className="text-3xl font-black text-white uppercase tracking-tighter mb-10">Create Rental Ticket</h3>
        <div className="space-y-6">
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">Assign to Conference</label>
              <button 
                onClick={() => setTicketFormData({...ticketFormData, is_custom: !ticketFormData.is_custom, conference_id: '', custom_conference_name: ''})}
                className={`text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-lg transition ${ticketFormData.is_custom ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-400'}`}
              >
                {ticketFormData.is_custom ? 'Use Existing' : 'Add Custom'}
              </button>
            </div>
            {ticketFormData.is_custom ? (
              <input 
                type="text"
                placeholder="Enter Custom Event/Conference Name..."
                aria-label="Custom supplier event name" value={ticketFormData.custom_conference_name}
                onChange={(e) => setTicketFormData({...ticketFormData, custom_conference_name: e.target.value})}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
              />
            ) : (
              <select 
                aria-label="Supplier ticket event" value={ticketFormData.conference_id}
                onChange={(e) => setTicketFormData({...ticketFormData, conference_id: e.target.value})}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all appearance-none"
              >
                <option value="">Select Conference</option>
                {backendConferences.filter(c => (c.lifecycle_state || 'open') === 'open').map(c => (
                  <option key={c.id} value={c.id}>{c.conferenceName}</option>
                ))}
              </select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Rented From</label>
              <input 
                type="date" 
                value={ticketFormData.available_from}
                onChange={(e) => setTicketFormData({...ticketFormData, available_from: e.target.value})}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
              />
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Rented Till</label>
              <input 
                type="date" 
                value={ticketFormData.available_till}
                onChange={(e) => setTicketFormData({...ticketFormData, available_till: e.target.value})}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
              />
            </div>
          </div>
        </div>
        <div className="flex gap-4 mt-10">
          <button onClick={() => setIsTicketFormOpen(false)} className="flex-1 py-4 bg-slate-800 text-slate-300 rounded-2xl font-black uppercase text-xs hover:bg-slate-700 transition">Cancel</button>
          <label className="block text-sm">Save reason<textarea aria-label="Supplier save reason" value={supplierSaveReason} onChange={event => setSupplierSaveReason(event.target.value)} maxLength={1000} className="block w-full bg-slate-800 rounded p-2" /></label>
          <button disabled={supplierSaving.busy || Boolean(supplierSaving.pending) || Boolean(supplierSaving.error) || !supplierSaveReason.trim()} onClick={handleCreateSubrentalTicket} className="flex-1 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition">Create Ticket</button>
        </div>
        </fieldset>
      </div>
    </div>
  );

  const renderTicketItems = (ticket: SubrentalTicket) => {
    return (
      <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
          <div className="flex items-center gap-6">
            <button 
              aria-label="Back to supplier tickets" onClick={() => setSelectedTicket(null)}
              className="w-12 h-12 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center text-slate-400 hover:text-white transition"
            >
              <i aria-hidden="true" className="fa-solid fa-arrow-left"></i>
            </button>
            <div>
              <h2 className="text-4xl md:text-5xl font-black text-white tracking-tighter uppercase">{ticket.conference_name}</h2>
              <p className="text-[10px] text-sky-400 font-bold uppercase tracking-[0.2em] mt-1">Ticket #{ticket.id} • {selectedSubrentalCompany?.name}</p>
            </div>
          </div>
            {user?.role !== 'accounts' && (
              <button 
                onClick={() => setIsAddingTicketItem(true)}
                className="px-8 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition"
              >
                Add Items
              </button>
            )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-4">
            <SupplierBalancePanel key={`rental:${user?.user_id || user?.email}:${ticket.id}`} account={String(user?.user_id || user?.email || '')} role={user?.role || ''} ticket={ticket} save={supplierSaving.save} busy={supplierSaving.busy} pending={Boolean(supplierSaving.pending || supplierSaving.error)} />
            <h3 className="text-sm font-black text-slate-500 uppercase tracking-widest">Rented Items</h3>
            {ticket.items?.map(item => (
              <div key={item.id} className="bg-slate-900/40 p-6 rounded-3xl border border-slate-800/60 flex justify-between items-center">
                <div>
                  <h4 className="text-sm font-black text-white uppercase">{item.asset_details?.aliasName || item.asset_details?.alias_name || item.asset_details?.sku || item.asset_details?.name}</h4>
                  <p className="text-[10px] text-slate-500 font-mono uppercase mt-1">{item.asset_details?.sku}</p>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1">Total Price</p>
                    <p className="text-lg font-black text-emerald-400">₹{(Number(item.rental_price) * item.quantity).toLocaleString()}</p>
                    <p className="text-[9px] text-slate-600 font-bold uppercase">Qty: {item.quantity}</p>
                  </div>
                  {user?.role !== 'accounts' && (
                    <div className="flex flex-col gap-2 ml-6 pl-6 border-l border-slate-800/60">
                      <button 
                        onClick={() => handleEditTicketItem(item)}
                        className="w-8 h-8 bg-slate-800 rounded-lg flex items-center justify-center text-slate-400 hover:text-sky-400 transition"
                        title="Edit Item"
                      >
                        <i aria-hidden="true" className="fa-solid fa-pen-to-square text-[10px]"></i>
                      </button>
                      <button 
                        onClick={() => handleDeleteTicketItem(item.id)}
                        className="w-8 h-8 bg-slate-800 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-400 transition"
                        title="Remove Item"
                      >
                        <i aria-hidden="true" className="fa-solid fa-trash text-[10px]"></i>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {!ticket.items?.length && (
              <div className="p-10 text-center border border-dashed border-slate-800 rounded-3xl">
                <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest">No items added to this ticket yet</p>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <h3 className="text-sm font-black text-slate-500 uppercase tracking-widest">Ticket Details</h3>
            <div className="bg-slate-900/40 p-10 rounded-[2.5rem] border border-slate-800/60 space-y-8">
              <div className="grid grid-cols-2 gap-8">
                <div>
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Availability From</p>
                  <p className="text-lg font-black text-white uppercase">{ticket.available_from || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Availability Till</p>
                  <p className="text-lg font-black text-white uppercase">{ticket.available_till || 'N/A'}</p>
                </div>
              </div>
              <div className="pt-8 border-t border-slate-800/60">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Assigned Conference</p>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-sky-500/10 rounded-xl flex items-center justify-center text-sky-400 text-xl border border-sky-500/20">
                    <i aria-hidden="true" className="fa-solid fa-calendar-check"></i>
                  </div>
                  <div>
                    <p className="text-lg font-black text-white uppercase">{ticket.conference_name}</p>
                    <p className="text-[10px] text-slate-600 font-bold uppercase">Active Assignment</p>
                  </div>
                </div>
              </div>
              <div className="pt-8 border-t border-slate-800/60 flex justify-between items-end">
                <div>
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Grand Total Value</p>
                  <p className="text-3xl font-black text-emerald-400">₹{
                    ticket.items?.reduce((sum, item) => sum + (Number(item.rental_price) * item.quantity), 0).toLocaleString()
                  }</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Total Items</p>
                  <p className="text-lg font-black text-white">{ticket.items?.length || 0}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {isAddingTicketItem && (
          <div className="fixed inset-0 z-[999] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { setIsAddingTicketItem(false); setEditingTicketItem(null); }}></div>
            <div className="relative w-full max-w-2xl bg-white rounded-[2.5rem] shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">
              <button aria-label="Close supplier item form" disabled={supplierSaving.busy} onClick={() => { setIsAddingTicketItem(false); setEditingTicketItem(null); }}>Close</button>
              <fieldset disabled={supplierSaving.busy || Boolean(supplierSaving.pending)} className="p-10 overflow-y-auto custom-scrollbar">
                <div className="flex justify-between items-center mb-8">
                  <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tighter">{editingTicketItem ? 'Edit Item' : 'Add Items to Ticket'}</h3>
                  {!editingTicketItem && (
                    <div className="flex gap-2">
                      <button 
                        onClick={() => setTicketItemForm({...ticketItemForm, asset_id: ''})} 
                        className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition ${!ticketItemForm.asset_id ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                      >New Item</button>
                      <button 
                        onClick={() => setTicketItemForm({...ticketItemForm, asset_id: 'SELECT'})} 
                        className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition ${ticketItemForm.asset_id === 'SELECT' ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                      >From Inventory</button>
                    </div>
                  )}
                </div>

                <div className="space-y-6">
                  {(!editingTicketItem && ticketItemForm.asset_id === 'SELECT') ? (
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Search/Scan Inventory</label>
                      <input 
                        autoFocus
                        type="text"
                        value={ticketItemSearch}
                        onChange={(e) => setTicketItemSearch(e.target.value)}
                        placeholder="Scan QR or Type Name..."
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all mb-6 shadow-sm"
                      />
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[40vh] overflow-y-auto custom-scrollbar pr-2">
                        {!normalizeSearch(ticketItemSearch) ? (
                          <ScanPrompt />
                        ) : (
                          subrentalAssets.filter(a => {
                             const q = normalizeSearch(ticketItemSearch);
                             return normalizeSearch(a.sku).includes(q) || 
                                    normalizeSearch(a.aliasName).includes(q) ||
                                    normalizeSearch(a.barcode || '').includes(q);
                          }).map(a => (
                            <div 
                              key={a.id} 
                              onClick={() => {
                                setTicketItemForm({...ticketItemForm, asset_id: a.id, name: a.aliasName || a.sku});
                                setTicketItemSearch(''); // Clear search on select
                              }} 
                              className={`p-4 rounded-2xl border transition cursor-pointer flex justify-between items-center ${ticketItemForm.asset_id === a.id ? 'bg-sky-500/10 border-sky-500 text-sky-600' : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-slate-300'}`}
                            >
                              <div>
                                <p className="text-[11px] font-black uppercase">{a.aliasName || a.sku}</p>
                                <p className="text-[9px] font-mono">{a.sku}</p>
                              </div>
                              {ticketItemForm.asset_id === a.id && <i aria-hidden="true" className="fa-solid fa-check-circle"></i>}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="col-span-full">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Item Name</label>
                        <input 
                          type="text" 
                          placeholder="e.g. JBL PRX 815 SPEAKER"
                          aria-label="Supplier item name" value={ticketItemForm.name}
                          onChange={(e) => setTicketItemForm({...ticketItemForm, name: e.target.value})}
                          className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Cost Price (Optional)</label>
                        <input 
                          type="number" 
                          aria-label="Supplier item value" value={ticketItemForm.price}
                          onChange={(e) => setTicketItemForm({...ticketItemForm, price: parseFloat(e.target.value)})}
                          className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Depreciation %</label>
                        <input 
                          type="number" 
                          aria-label="Supplier item depreciation" value={ticketItemForm.depreciation}
                          onChange={(e) => setTicketItemForm({...ticketItemForm, depreciation: parseFloat(e.target.value)})}
                          className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-6 pt-6 border-t border-slate-100">
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Rental Price (for this ticket)</label>
                      <input 
                        type="number" 
                        aria-label="Supplier rental price" value={ticketItemForm.rental_price}
                        onChange={(e) => setTicketItemForm({...ticketItemForm, rental_price: parseFloat(e.target.value)})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Quantity</label>
                      <input 
                        type="number" 
                        aria-label="Supplier item quantity" value={ticketItemForm.quantity}
                        onChange={(e) => setTicketItemForm({...ticketItemForm, quantity: Number(e.target.value)})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                      />
                    </div>
                  </div>

                  <div className="flex justify-between items-center mt-4 px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Calculated Total</p>
                    <p className="text-xl font-black text-emerald-600">₹{(ticketItemForm.rental_price * ticketItemForm.quantity).toLocaleString()}</p>
                  </div>
                </div>

                <div className="flex gap-4 mt-12">
                  <button onClick={() => setIsAddingTicketItem(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black uppercase text-xs hover:bg-slate-200 transition">Cancel</button>
                  <label className="block text-sm">Save reason<textarea aria-label="Supplier item save reason" value={supplierSaveReason} onChange={event => setSupplierSaveReason(event.target.value)} maxLength={1000} className="block w-full bg-slate-100 rounded p-2" /></label>
                  <button disabled={supplierSaving.busy || Boolean(supplierSaving.pending) || Boolean(supplierSaving.error) || !supplierSaveReason.trim()} onClick={handleAddTicketItem} className="flex-1 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition">Add Item to Ticket</button>
                </div>
              </fieldset>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSubrentalInventory = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <button onClick={() => fetchSubrentalAssets(String(selectedSubrentalCompany!.id))}>Reload supplier inventory</button>
      {subrentalInventoryStatus.status === 'error' && <p role="alert">{subrentalInventoryStatus.error}<button onClick={() => fetchSubrentalAssets(String(selectedSubrentalCompany!.id))}>Retry supplier inventory</button></p>}
      {subrentalInventoryStatus.status === 'loading' && <p role="status">Loading supplier inventory…</p>}
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
        <div className="flex items-center gap-6">
          <button 
            onClick={() => {
              if (showSubrentalInventory) setShowSubrentalInventory(false);
              else setSelectedSubrentalCompany(null);
            }}
            className="w-12 h-12 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <i aria-hidden="true" className="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <h2 className="text-4xl md:text-5xl font-black text-sky-500 tracking-tighter uppercase">{selectedSubrentalCompany?.name}</h2>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em] mt-1">External Inventory Management</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={() => handleExportInventory('template')}
            className="px-6 py-4 bg-slate-800 text-slate-300 rounded-2xl font-black uppercase text-[10px] hover:bg-slate-700 transition flex items-center gap-2"
          >
            <i aria-hidden="true" className="fa-solid fa-download"></i> Template
          </button>
          {user?.role !== 'accounts' && (
            <>
              {(user?.is_staff || user?.role === 'admin' || user?.role === 'boss') && <>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="px-6 py-4 bg-amber-500 text-white rounded-2xl font-black uppercase text-[10px] hover:bg-amber-400 transition flex items-center gap-2"
              >
                <i aria-hidden="true" className="fa-solid fa-file-import"></i> Bulk Import
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={(e) => handleFileUpload(e, selectedSubrentalCompany.id)} 
                className="hidden" 
                accept=".xlsx"
              />
              </>}
              <button 
                onClick={() => {
                  setAssetFormData({ ...assetFormData, subrental_company: selectedSubrentalCompany.id });
                  setAssetView('Form');
                  setCurrentPage('Assets');
                }}
                className="px-8 py-4 bg-emerald-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-emerald-400 transition"
              >
                Add Item
              </button>
            </>
          )}
        </div>
      </div>

      {uploadFeedback && (
        <div className="w-full text-right text-xs">
          {uploadFeedback.type === 'loading' && <div className="text-blue-600 animate-pulse font-medium">{uploadFeedback.text}</div>}
          {uploadFeedback.type === 'success' && <div className="p-3 bg-green-50 text-green-700 border border-green-200 rounded font-semibold">{uploadFeedback.text}</div>}
          {uploadFeedback.type === 'error' && <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded font-semibold">{uploadFeedback.text}</div>}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 items-center mb-8">
        <div className="relative group flex-1 w-full">
          <i aria-hidden="true" className="fa-solid fa-magnifying-glass absolute left-3.5 sm:left-4 md:left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors text-xs md:text-sm pointer-events-none" />
          <input 
            type="text"
            placeholder="Search subrental gear, SKU..."
            value={subrentalSearchQuery}
            onChange={(e) => setSubrentalSearchQuery(e.target.value)}
            style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
            className="w-full bg-white border border-slate-300 rounded-2xl pl-9 sm:pl-11 md:pl-12 pr-20 sm:pr-24 md:pr-28 py-3 sm:py-3.5 md:py-4 text-slate-900 font-bold text-xs md:text-sm uppercase placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10 outline-none transition-all shadow-sm"
          />
          <div className="absolute right-2.5 sm:right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 sm:gap-2">
            {subrentalSearchQuery.trim() && (
              <button
                type="button"
                onClick={() => setSubrentalSearchQuery('')}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-400 hover:text-slate-600 flex items-center justify-center transition active:scale-95"
                title="Clear search"
              >
                <i aria-hidden="true" className="fa-solid fa-xmark text-xs" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowScanner(true)}
              className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 bg-sky-500/10 text-sky-600 hover:bg-sky-500 hover:text-white rounded-xl flex items-center justify-center transition active:scale-95 shadow-sm group/btn"
              title="Scan with Camera"
            >
              <i aria-hidden="true" className="fa-solid fa-camera text-xs sm:text-sm group-hover/btn:scale-110 transition-transform" />
            </button>
          </div>
        </div>
      </div>

      <div className="bg-slate-900/30 rounded-[2rem] border border-slate-800/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[1000px]">
            <thead className="bg-slate-950/40 text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
              <tr>
                <th className="px-6 py-6">SKU</th>
                <th className="px-6 py-6">Alias Name</th>
                <th className="px-6 py-6">Serial Number</th>
                <th className="px-6 py-6">Type</th>
                <th className="px-6 py-6 text-center">Qty</th>
                <th className="px-6 py-6 text-center">Status</th>
                <th className="px-6 py-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/20">
              {(() => {
                const filtered = subrentalAssets.filter(asset => {
                  const q = subrentalSearchQuery.toLowerCase();
                  return (asset.sku || '').toLowerCase().includes(q) ||
                         (asset.aliasName || '').toLowerCase().includes(q) ||
                         (asset.serialNumber || '').toLowerCase().includes(q);
                });
                if (filtered.length > 0) {
                  return filtered.map((asset) => (
                    <tr key={asset.id} className="hover:bg-slate-800/10 transition group">
                      <td className="px-6 py-6">
                        <p className="text-xs font-black text-sky-400 font-mono">{asset.sku}</p>
                      </td>
                      <td className="px-6 py-6">
                        <p className="font-black text-white text-base uppercase">{asset.aliasName || '-'}</p>
                      </td>
                      <td className="px-6 py-6">
                        <p className="text-xs text-slate-300 font-mono">{asset.serialNumber}</p>
                      </td>
                      <td className="px-6 py-6">
                        <p className="text-[10px] text-slate-500 font-black uppercase">{asset.type}</p>
                      </td>
                      <td className="px-6 py-6 text-center">
                        <p className="text-xs font-black text-white">{asset.quantity}</p>
                      </td>
                      <td className="px-6 py-6 text-center">
                        <span className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase ${
                          asset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' : 'bg-orange-500/10 text-orange-400'
                        }`}>{asset.status}</span>
                      </td>
                      <td className="px-6 py-6 text-right space-x-4">
                         {user?.role !== 'accounts' && (
                           <button onClick={() => {
                             setEditingAsset(asset);
                             setAssetFormData({ ...asset, subrental_company: selectedSubrentalCompany.id });
                             setAssetView('Form');
                             setCurrentPage('Assets');
                           }} className="text-sky-400"><i aria-hidden="true" className="fa-solid fa-pen"></i></button>
                         )}
                         <button onClick={() => setQrTarget({ sku: asset.sku, name: asset.aliasName || asset.sku, assetType: asset.type })} className="text-emerald-400">
                           <i aria-hidden="true" className="fa-solid fa-qrcode"></i>
                         </button>
                      </td>
                    </tr>
                  ));
                }
                return (
                  <tr>
                    <td colSpan={7} className="px-6 py-20 text-center">
                      <p className="text-xs font-black text-slate-600 uppercase tracking-widest">
                        {subrentalSearchQuery ? 'No results matching search' : 'Inventory is empty'}
                      </p>
                    </td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const renderEmployees = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
        <h2 className="text-4xl md:text-5xl font-black text-orange-500 tracking-tighter uppercase">Employees</h2>
        <button onClick={openNewEmployeeForm} className="w-full lg:w-auto px-8 py-4 bg-indigo-500 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-indigo-400 transition">Add Employee</button>
      </div>
      <div className="bg-slate-900/30 rounded-[1.5rem] md:rounded-[2rem] border border-slate-800/50 overflow-hidden">
        <div className="p-4 md:p-8 border-b border-slate-800/40">
          <input
            type="text" value={employeeSearchQuery} onChange={(e) => setEmployeeSearchQuery(e.target.value)}
            placeholder="Search employees..."
            style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
            className="w-full px-4 md:px-6 py-3 md:py-4 rounded-xl border border-slate-300 bg-white text-slate-900 font-bold text-xs uppercase placeholder:text-slate-400 outline-none focus:border-indigo-500 shadow-sm"
          />
        </div>
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left min-w-[800px]">
            <thead className="bg-slate-950/40 text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
              <tr>
                <th className="px-6 py-6">Name</th>
                <th className="px-6 py-6">Department</th>
                <th className="px-6 py-6">Contact</th>
                <th className="px-6 py-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/20">
              {employees.filter(emp => !employeeSearchQuery ||
                (emp.name && emp.name.toLowerCase().includes(employeeSearchQuery.toLowerCase())) ||
                (emp.department && emp.department.toLowerCase().includes(employeeSearchQuery.toLowerCase())) ||
                (emp.employee_id && emp.employee_id.toLowerCase().includes(employeeSearchQuery.toLowerCase()))
              ).map((emp) => (
                <tr key={emp.id} className="hover:bg-slate-800/10 transition">
                  <td className="px-6 py-6">
                    <p className="font-black text-white text-base uppercase">{emp.name}</p>
                    <p className="text-[9px] text-slate-500 font-black mt-1 uppercase">ID: {emp.employee_id}</p>
                  </td>
                  <td className="px-6 py-6 text-xs text-slate-400 uppercase font-bold">{emp.department}</td>
                  <td className="px-6 py-6">
                    <p className="text-xs text-slate-300">{emp.email}</p>
                    <p className="text-[10px] text-slate-500 mt-1">{emp.phone}</p>
                  </td>
                  <td className="px-6 py-6 text-right space-x-4">
                    <button onClick={() => openEditEmployeeForm(emp)} className="text-sky-400 hover:text-white"><i aria-hidden="true" className="fa-solid fa-pen"></i></button>
                    <button onClick={() => handleDeleteEmployee(emp.id)} className="text-red-400 hover:text-white"><i aria-hidden="true" className="fa-solid fa-trash"></i></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const handlePrintChallan = (
    conf: Booking | null,
    mode: 'dispatch' | 'return' = 'dispatch',
    forceChoice = false,
    truckChallan?: TruckChallan | null
  ) => {
    // BUG J-1: Guard against null conference (e.g. unsaved editing state)
    if (!conf) {
      alert('Please save the conference first before printing the challan.');
      return;
    }

    const hasTransfers = hasRecordedQuantities(conf) || (conf.transfer_log && conf.transfer_log.length > 0) ||
      (conf.challanAssets && conf.challanAssets.length > 0 &&
       (conf.challanAssets.length !== (conf.assets?.length || 0) ||
        JSON.stringify([...conf.challanAssets].sort()) !== JSON.stringify([...(conf.assets || [])].sort())));

    if (hasTransfers && forceChoice && !truckChallan) {
      setPrintSelectConf(conf);
      return;
    }

    const hasTrucks = (conf.truckChallans || []).length > 0;
    // Prepare conf object for printing:
    // If a specific truck is selected, print with that truck's vehicle and driver.
    // If master challan is selected and trucks exist, vehicle/driver is blank per user specification.
    const printConfObj: Booking = truckChallan
      ? {
          ...conf,
          challanNumber: truckChallan.challan_number || (truckChallan.truck_number === 1 ? conf.challanNumber : ''),
          vehicleNumber: truckChallan.vehicle_number || '',
          driverPhone: truckChallan.driver_phone || '',
        }
      : (hasTrucks ? { ...conf, vehicleNumber: '', driverPhone: '' } : conf);

    // Store locally to persist exact current state across the new tab boundary. Always DELIVERY CHALLAN.
    localStorage.setItem('print_conf_data', JSON.stringify(printConfObj));
    localStorage.setItem('print_document_kind', mode);
    localStorage.setItem('print_challan_title', 'DELIVERY CHALLAN');
    localStorage.setItem('print_truck_suffix', truckChallan ? `__truckId${truckChallan.id}` : '');

    const challanPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
    const targetAssetIds = challanAssetIds(conf, mode, truckChallan);

    const relevantAssets = challanPool
      .filter(a => targetAssetIds.includes(String(a.id)))
      .map(a => {
        if (truckChallan?.asset_quantities) {
          const tQty = truckChallan.asset_quantities[String(a.id)] ?? truckChallan.asset_quantities[Number(a.id)];
          if (tQty !== undefined && tQty !== null) {
            return { ...a, quantity: Number(tQty) };
          }
        }
        return a;
      });
    localStorage.setItem('print_assets_data', JSON.stringify(relevantAssets));

    // Open in new tab
    const url = `${window.location.protocol}//${window.location.host}${window.location.pathname}?print=true&confId=${conf.id}`;
    window.open(url, '_blank');
  };

  const renderChallanList = () => {
    // Formats date string to DD/MM/YYYY matching ChallanView
    const formatChallanDate = (rawDate?: string, fallbackDate?: string): string => {
      const d = rawDate || fallbackDate;
      if (!d) return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d;
      const parts = d.split('-');
      if (parts.length === 3) {
        const year = parts[0];
        const month = parts[1];
        const day = parts[2].split('T')[0];
        if (day && month && year) {
          return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
        }
      }
      const parsed = new Date(d);
      if (!isNaN(parsed.getTime())) {
        return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      }
      return d;
    };

    // Sort challans by ID descending (newest created = top)
    const sortedChallans = [...filteredConferences]
      .filter(conf => !challanSearchQuery ||
        (conf.challanNumber && conf.challanNumber.toString().toLowerCase().includes(challanSearchQuery.toLowerCase())) ||
        (conf.conferenceName && conf.conferenceName.toLowerCase().includes(challanSearchQuery.toLowerCase())) ||
        (conf.associationName && conf.associationName.toLowerCase().includes(challanSearchQuery.toLowerCase()))
      )
      .sort((a, b) => parseInt(b.id) - parseInt(a.id));

    return (
      <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
          <h2 className="text-4xl md:text-5xl font-black text-orange-500 tracking-tighter uppercase">Delivery Challans</h2>
          {user?.role === 'accounts' && (
            <div className="flex items-center gap-3.5 px-5 py-3 rounded-2xl bg-amber-500/10 border border-amber-500/25 shadow-lg shadow-amber-500/5">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400">
                <i aria-hidden="true" className="fa-solid fa-file-invoice text-lg"></i>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Invoice Overview</p>
                <p className="text-sm font-black uppercase tracking-wider text-amber-400">
                  Invoice Pending : <span className="text-white text-base font-black ml-1">{backendConferences.filter(c => !c.is_invoiced && !c.isInvoiced).length}</span>
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="bg-slate-900/30 rounded-[1.5rem] md:rounded-[2rem] border border-slate-800/50 overflow-hidden">
          <div className="p-3 sm:p-4 md:p-6 border-b border-slate-800/40">
            <div className="relative group w-full">
              <i aria-hidden="true" className="fa-solid fa-magnifying-glass absolute left-3.5 sm:left-4 md:left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-orange-500 transition-colors text-xs md:text-sm pointer-events-none" />
              <input
                type="text"
                value={challanSearchQuery}
                onChange={(e) => setChallanSearchQuery(e.target.value)}
                placeholder="Search challans by number, venue, vehicle..."
                style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
                className="w-full pl-9 sm:pl-11 md:pl-12 pr-12 sm:pr-14 py-3 sm:py-3.5 md:py-4 rounded-xl border border-slate-300 bg-white text-slate-900 font-bold text-xs md:text-sm uppercase placeholder:text-slate-400 outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 transition-all shadow-sm"
              />
              {challanSearchQuery.trim() && (
                <button
                  type="button"
                  onClick={() => setChallanSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-400 hover:text-slate-600 flex items-center justify-center transition active:scale-95"
                  title="Clear search"
                >
                  <i aria-hidden="true" className="fa-solid fa-xmark text-xs" />
                </button>
              )}
            </div>
          </div>
          {/* Desktop Table View */}
          <div className="hidden md:block overflow-x-auto custom-scrollbar">
            <table className="w-full text-left min-w-[1000px]">
              <thead className="bg-slate-950/40 text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
                <tr>
                  <th className="px-6 py-6">Challan #</th>
                  <th className="px-6 py-6">Date</th>
                  <th className="px-6 py-6">Conference</th>
                  <th className="px-6 py-6">Assets</th>
                  <th className="px-6 py-6 text-center">Status</th>
                  {user?.role === 'accounts' && (
                    <th className="px-6 py-6 text-center">Invoice Status</th>
                  )}
                  <th className="px-6 py-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/20">
                {sortedChallans.map((conf) => {
                  const historicalCount = getChallanTotalItemsCount(conf);
                  const hasAssets = historicalCount > 0;
                  const challanDateDisplay = formatChallanDate(conf.challanDate || conf.challan_date, conf.startDate || (conf as any).start_date);
                  
                  return (
                    <tr key={conf.id} className="hover:bg-slate-800/10 transition">
                      <td className="px-10 py-6">
                        <p className="font-black text-white text-base uppercase">{conf.challanNumber}</p>
                      </td>
                      <td className="px-10 py-6">
                        <p className="text-xs text-slate-300 font-bold uppercase">{challanDateDisplay}</p>
                      </td>
                      <td className="px-10 py-6">
                        <p className="font-bold text-white text-xs uppercase">{conf.conferenceName}</p>
                        <p className="text-[10px] text-slate-500 uppercase mt-1">{conf.associationName}</p>
                        {(conf.truckChallans || []).length > 0 && (
                          <div className="flex gap-1.5 mt-2 flex-wrap">
                            <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[9px] font-black uppercase rounded-md">
                              <i aria-hidden="true" className="fa-solid fa-truck text-[8px] mr-1"></i>
                              {(conf.truckChallans || []).length} Trucks
                            </span>
                            {(conf.truckChallans || []).map(t => (
                              <button
                                key={t.id}
                                onClick={() => {
                                  setSelectedBookingForChallan(conf);
                                  setActiveTruckChallanId(t.id);
                                  setChallanViewMode('Detail');
                                }}
                                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-[8px] font-bold uppercase rounded-md transition"
                                title={`View ${t.label} (${t.assets.length} items)`}
                              >
                                {t.label} ({t.assets.length})
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-10 py-6">
                        <p className={`text-[10px] font-black uppercase ${hasAssets ? 'text-emerald-400' : 'text-slate-600'}`}>
                          {historicalCount} Items
                        </p>
                      </td>
                      <td className="px-10 py-6 text-center">
                        <span className={`px-3 py-1 rounded-md text-[9px] font-black uppercase tracking-widest ${hasAssets ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                          {hasAssets ? 'Generated' : 'Draft'}
                        </span>
                      </td>
                      {user?.role === 'accounts' && (
                        <td className="px-6 py-6 text-center">
                          <button
                            disabled={invoicingId === conf.id}
                            onClick={() => handleToggleInvoiced(conf.id, !!(conf.is_invoiced || conf.isInvoiced))}
                            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all border ${
                              (conf.is_invoiced || conf.isInvoiced)
                                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25 shadow-sm shadow-emerald-500/10'
                                : 'bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25 shadow-sm shadow-amber-500/10'
                            } ${invoicingId === conf.id ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer active:scale-95'}`}
                            title={(conf.is_invoiced || conf.isInvoiced) ? 'Click to mark as Pending Invoice' : 'Click to mark as Invoiced'}
                          >
                            {invoicingId === conf.id ? (
                              <i aria-hidden="true" className="fa-solid fa-spinner fa-spin text-xs"></i>
                            ) : (
                              <i aria-hidden="true" className={`fa-solid ${(conf.is_invoiced || conf.isInvoiced) ? 'fa-circle-check text-emerald-400' : 'fa-clock text-amber-400'}`}></i>
                            )}
                            {(conf.is_invoiced || conf.isInvoiced) ? 'Invoiced' : 'Pending Invoice'}
                          </button>
                        </td>
                      )}
                      <td className="px-10 py-6 text-right space-x-4">
                        <button
                          onClick={() => { setSelectedBookingForChallan(conf); setChallanViewMode('Detail'); }}
                          className="text-sky-400 hover:text-white text-[10px] font-black uppercase tracking-widest"
                        >
                          <i aria-hidden="true" className="fa-solid fa-eye mr-2"></i> View
                        </button>
                        <button
                          onClick={() => handlePrintChallan(conf)}
                          className="text-violet-400 hover:text-white text-[10px] font-black uppercase tracking-widest"
                        >
                          <i aria-hidden="true" className="fa-solid fa-print mr-2"></i> Print
                        </button>
                        {(user?.is_staff || user?.role === 'admin') && (
                          <button
                            onClick={() => handleDeleteChallan(conf.id)}
                            className="text-red-400 hover:text-white text-[10px] font-black uppercase tracking-widest"
                            title="Delete Challan"
                          >
                            <i aria-hidden="true" className="fa-solid fa-trash mr-2"></i> Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card View */}
          <div className="md:hidden space-y-4 p-4">
            {sortedChallans.map((conf) => {
              const historicalCount = getChallanTotalItemsCount(conf);
              const hasAssets = historicalCount > 0;
              const challanDateDisplay = formatChallanDate(conf.challanDate || conf.challan_date, conf.startDate || (conf as any).start_date);

              return (
                <div key={conf.id} className="bg-slate-900/60 border border-slate-800/60 p-5 rounded-2xl space-y-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-widest font-black">Challan #</p>
                      <p className="font-black text-white text-lg">{conf.challanNumber}</p>
                      <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
                        <i aria-hidden="true" className="fa-regular fa-calendar text-[9px] mr-1 text-sky-400"></i>
                        {challanDateDisplay}
                      </p>
                    </div>
                    <span className={`px-3 py-1 rounded-md text-[9px] font-black uppercase tracking-widest ${hasAssets ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                      {hasAssets ? 'Generated' : 'Draft'}
                    </span>
                  </div>

                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest font-black">Conference</p>
                    <p className="font-bold text-white text-xs uppercase break-words">{conf.conferenceName}</p>
                    <p className="text-[10px] text-slate-400 uppercase mt-0.5">{conf.associationName}</p>
                    {(conf.truckChallans || []).length > 0 && (
                      <div className="flex gap-1.5 mt-2 flex-wrap">
                        <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[9px] font-black uppercase rounded-md">
                          <i aria-hidden="true" className="fa-solid fa-truck text-[8px] mr-1"></i>
                          {(conf.truckChallans || []).length} Trucks
                        </span>
                        {(conf.truckChallans || []).map(t => (
                          <button
                            key={t.id}
                            onClick={() => {
                              setSelectedBookingForChallan(conf);
                              setActiveTruckChallanId(t.id);
                              setChallanViewMode('Detail');
                            }}
                            className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-[8px] font-bold uppercase rounded-md transition"
                          >
                            {t.label} ({t.assets.length})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {user?.role === 'accounts' && (
                    <div className="flex justify-between items-center pt-3 border-t border-slate-800/40">
                      <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Invoice Status</span>
                      <button
                        disabled={invoicingId === conf.id}
                        onClick={() => handleToggleInvoiced(conf.id, !!(conf.is_invoiced || conf.isInvoiced))}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all border ${
                          (conf.is_invoiced || conf.isInvoiced)
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25'
                            : 'bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25'
                        } ${invoicingId === conf.id ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer active:scale-95'}`}
                      >
                        {invoicingId === conf.id ? (
                          <i aria-hidden="true" className="fa-solid fa-spinner fa-spin text-xs"></i>
                        ) : (
                          <i aria-hidden="true" className={`fa-solid ${(conf.is_invoiced || conf.isInvoiced) ? 'fa-circle-check text-emerald-400' : 'fa-clock text-amber-400'}`}></i>
                        )}
                        {(conf.is_invoiced || conf.isInvoiced) ? 'Invoiced' : 'Pending Invoice'}
                      </button>
                    </div>
                  )}

                  <div className="flex justify-between items-center pt-3 border-t border-slate-800/40">
                    <div>
                      <p className="text-[9px] text-slate-500 uppercase tracking-widest font-black">Items</p>
                      <p className="text-[11px] font-black text-emerald-400 uppercase">{historicalCount} Items</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setSelectedBookingForChallan(conf); setChallanViewMode('Detail'); }}
                        className="px-3 py-2 bg-sky-500/10 text-sky-400 hover:bg-sky-50 hover:text-white rounded-lg text-[9px] font-black uppercase tracking-wider transition-all"
                      >
                        <i aria-hidden="true" className="fa-solid fa-eye"></i>
                      </button>
                      <button
                        onClick={() => handlePrintChallan(conf)}
                        className="px-3 py-2 bg-violet-500/10 text-violet-400 hover:bg-violet-50 hover:text-white rounded-lg text-[9px] font-black uppercase tracking-wider transition-all"
                      >
                        <i aria-hidden="true" className="fa-solid fa-print"></i>
                      </button>
                      {(user?.is_staff || user?.role === 'admin') && (
                        <button
                          onClick={() => handleDeleteChallan(conf.id)}
                          className="px-3 py-2 bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white rounded-lg text-[9px] font-black uppercase tracking-wider transition-all"
                          title="Delete Challan"
                        >
                          <i aria-hidden="true" className="fa-solid fa-trash"></i>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {sortedChallans.length === 0 && (
              <p className="text-center py-6 text-slate-500 text-xs uppercase font-black tracking-widest">No challans found</p>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderConferences = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <div className="flex justify-between items-center">
        <h2 className="text-5xl font-black text-orange-500 tracking-tighter uppercase">Conferences</h2>
        {(user?.is_staff || user?.role === 'accounts') && (
          <button onClick={openNewConferenceForm} className="w-full md:w-auto px-8 py-4 bg-violet-600 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-lg shadow-violet-500/20">Add Conference</button>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-3 sm:gap-4 bg-slate-900/30 p-3 sm:p-4 rounded-3xl border border-slate-800/50">
        <div className="relative group flex-1 w-full">
          <i aria-hidden="true" className="fa-solid fa-magnifying-glass absolute left-3.5 sm:left-4 md:left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-orange-500 transition-colors text-xs md:text-sm pointer-events-none" />
          <input
            type="text"
            value={conferenceSearchTerm}
            onChange={(e) => setConferenceSearchTerm(e.target.value)}
            placeholder="Search conference name or venue..."
            style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
            className="w-full bg-white border border-slate-300 rounded-2xl pl-9 sm:pl-11 md:pl-12 pr-12 sm:pr-14 py-3 sm:py-3.5 md:py-4 text-slate-900 font-bold text-xs md:text-sm placeholder-slate-400 focus:outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 transition-all shadow-sm"
          />
          {conferenceSearchTerm.trim() && (
            <button
              type="button"
              onClick={() => setConferenceSearchTerm('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-400 hover:text-slate-600 flex items-center justify-center transition active:scale-95"
              title="Clear search"
            >
              <i aria-hidden="true" className="fa-solid fa-xmark text-xs" />
            </button>
          )}
        </div>
         <select
            value={conferenceStatusFilter}
            onChange={(e) => setConferenceStatusFilter(e.target.value)}
            style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
            className="md:w-64 bg-white border border-slate-300 rounded-2xl px-6 py-4 text-slate-800 font-bold focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/10 shadow-sm"
         >
            <option value="ALL">All Statuses</option>
            <option value="UPCOMING">Upcoming</option>
            <option value="ONGOING">Ongoing</option>
            <option value="ENDED">Ended · returns unverified</option>
            <option value="OPEN">All open events</option>
            <option value="COMPLETED">Verified complete</option>
            <option value="ARCHIVED">Archived</option>
         </select>
         <select
            value={conferenceTypeFilter}
            onChange={(e) => setConferenceTypeFilter(e.target.value)}
            style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
            className="md:w-64 bg-white border border-slate-300 rounded-2xl px-6 py-4 text-slate-800 font-bold focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/10 shadow-sm"
         >
            <option value="ALL">All Event Types</option>
            <option value="Medical Conference">Medical Conference</option>
            <option value="Personal Rental">Personal Rental</option>
         </select>
      </div>

      {/* Mobile Card View for Conferences */}
      <div className="md:hidden space-y-4">
        {filteredConferences.map((conf) => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const start = new Date(conf.startDate);
          const end = new Date(conf.endDate);
          const statusLabel = eventLifecycleLabel(conf);
          let statusStyle = 'bg-emerald-500/10 text-emerald-400';
          if (today < start) statusStyle = 'bg-blue-500/10 text-blue-400';
          else if (today > end) statusStyle = 'bg-slate-800/50 text-slate-500';

          return (
            <div key={conf.id} onClick={() => openEditConferenceForm(conf)} className="bg-slate-900/30 border border-slate-800/50 rounded-2xl p-5 space-y-4 active:bg-slate-800/20 transition-colors">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="text-lg font-black text-white uppercase leading-tight">{conf.conferenceName || conf.name}</h4>
                  {conf.isAudit && (
                    <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-amber-500/15 text-amber-400 border border-amber-500/20">
                      <i aria-hidden="true" className="fa-solid fa-eye text-[7px]" /> Audit Mode
                    </span>
                  )}
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <p className="text-[10px] text-slate-500 font-black uppercase">{conf.association}</p>
                    <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700/60">
                      {conf.conferenceType || conf.type || 'Medical Conference'}
                    </span>
                  </div>
                  {conf.pdf_document && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); handleDownloadPdf(conf.id); }}
                      className="inline-flex items-center gap-2 mt-3 px-3 py-1.5 bg-sky-500/10 text-sky-400 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-sky-500/20 transition-all border border-sky-500/10"
                    >
                      <i aria-hidden="true" className="fa-solid fa-file-pdf"></i>
                      Download PDF
                    </button>
                  )}
                </div>
                <span className={`px-3 py-1 rounded-full text-[8px] font-black uppercase ${statusStyle}`}>{statusLabel}</span>
              </div>
              <div className="flex items-center justify-between border-t border-slate-800/40 pt-4">
                <div className="flex gap-4">
                  <div className="text-center">
                    <p className="text-[8px] text-slate-500 font-black uppercase">Assets</p>
                    <p className="text-sky-400 font-black text-sm">{(conf.assets || []).length}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[8px] text-slate-500 font-black uppercase">Type</p>
                    <p className="text-slate-300 font-black text-xs mt-0.5 uppercase">{conf.type}</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  {['admin', 'boss', 'godown_incharge'].includes(user?.role) && <button aria-label={`Review completion for ${conf.conferenceName || conf.name}`} onClick={event => { event.stopPropagation(); setLifecycleReviewEventId(Number(conf.id)); }} className="text-amber-300 text-xs">Completion</button>}
                  {['admin', 'boss', 'godown_incharge'].includes(user?.role) && <button aria-label={`Review reconciliation for ${conf.conferenceName || conf.name}`} onClick={event => { event.stopPropagation(); setReconciliationEventId(Number(conf.id)); }} className="text-amber-300 text-xs">Reconcile</button>}
                  {user?.role !== 'godown_incharge' && (
                    <button onClick={(e) => { e.stopPropagation(); handlePrintChallan(conf, 'dispatch', true); }} className="w-10 h-10 bg-emerald-500/10 text-emerald-400 rounded-xl flex items-center justify-center"><i aria-hidden="true" className="fa-solid fa-print"></i></button>
                  )}
                  {user?.is_staff && (
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteConference(conf.id); }} className="w-10 h-10 bg-red-500/10 text-red-500 rounded-xl flex items-center justify-center"><i aria-hidden="true" className="fa-solid fa-trash"></i></button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {backendConferences.length === 0 && <div className="p-10 bg-slate-900/20 rounded-2xl border border-dashed border-slate-800 text-center text-slate-500 font-black uppercase text-[10px]">No Conferences found</div>}
      </div>

      <div className="hidden md:block bg-slate-900/30 rounded-[2rem] border border-slate-800/50 overflow-hidden overflow-x-auto custom-scrollbar">
        <table className="w-full text-left">
          <thead className="bg-slate-950/40 text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
            <tr>
              <th className="px-10 py-6">Conference Name</th>
              <th className="px-10 py-6">Association</th>
              <th className="px-10 py-6">Duration</th>
              <th className="px-10 py-6">Type</th>
              <th className="px-10 py-6 text-center">Status</th>
              {user?.is_staff && <th className="px-10 py-6 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/20">
            {filteredConferences.map((conf) => {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              const start = new Date(conf.startDate);
              const end = new Date(conf.endDate);

              const status = eventLifecycleLabel(conf);
              let statusColor = 'bg-emerald-500/10 text-emerald-400 animate-pulse';

              if (today < start) {
                statusColor = 'bg-blue-500/10 text-blue-400';
              } else if (today > end) {
                statusColor = 'bg-slate-800/50 text-slate-500';
              }

              return (
                <tr key={conf.id} className="hover:bg-slate-800/10 transition">
                  <td className="px-10 py-6 min-w-0">
                    <p className="font-black text-white text-base uppercase truncate max-w-xs">{conf.conferenceName || conf.name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      {conf.isAudit && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-amber-500/15 text-amber-400 border border-amber-500/20">
                          <i aria-hidden="true" className="fa-solid fa-eye text-[7px]" /> Audit Mode
                        </span>
                      )}
                      <p className="text-[9px] text-slate-500 font-black uppercase">ID: {conf.id}</p>
                      {conf.pdf_document && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); handleDownloadPdf(conf.id); }}
                          className="flex items-center gap-1.5 px-2 py-1 bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-md hover:bg-sky-500 hover:text-white transition-all group/pdf"
                          title="Download Logistics PDF"
                        >
                          <i aria-hidden="true" className="fa-solid fa-file-pdf text-[10px] group-hover/pdf:scale-110"></i>
                          <span className="text-[9px] font-black uppercase tracking-widest">Download PDF</span>
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-10 py-6 text-xs text-slate-400 uppercase font-bold truncate max-w-[150px]">{conf.association}</td>
                  <td className="px-10 py-6">
                    <p className="text-xs text-slate-300 font-mono">{new Date(conf.startDate).toLocaleDateString()}</p>
                    <p className="text-[10px] text-slate-500 mt-1 font-mono">to {new Date(conf.endDate).toLocaleDateString()}</p>
                  </td>
                  <td className="px-10 py-6 text-xs text-slate-400 uppercase font-bold">{conf.type}</td>
                  <td className="px-10 py-6 text-center">
                    <span className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase ${statusColor}`}>{status}</span>
                  </td>
                  <td className="px-10 py-6 text-right space-x-4">
                    {['admin', 'boss', 'godown_incharge'].includes(user?.role) && <button aria-label={`Review completion for ${conf.conferenceName || conf.name}`} onClick={() => setLifecycleReviewEventId(Number(conf.id))} className="text-amber-300 text-xs">Completion</button>}
                    {['admin', 'boss', 'godown_incharge'].includes(user?.role) && <button aria-label={`Review reconciliation for ${conf.conferenceName || conf.name}`} onClick={event => { event.stopPropagation(); setReconciliationEventId(Number(conf.id)); }} className="text-amber-300 text-xs">Reconcile</button>}
                    <span className="inline-flex items-center gap-2 mr-2 text-[10px] font-black text-violet-400">
                      <i aria-hidden="true" className="fa-solid fa-box"></i> {(conf.assets || []).length}
                    </span>
                    {(conf.crosscheckAssets || []).length > 0 && (
                      <span className="inline-flex items-center gap-1.5 mr-2 text-[10px] font-black text-indigo-400" title="Awaiting Godown Crosscheck">
                        <i aria-hidden="true" className="fa-solid fa-arrows-to-dot"></i> {(conf.crosscheckAssets || []).length}
                      </span>
                    )}
                    {user?.role !== 'godown_incharge' && (
                      <button onClick={() => handlePrintChallan(conf)} className="text-emerald-400 hover:text-white" title="Print Challan"><i aria-hidden="true" className="fa-solid fa-print"></i></button>
                    )}
                    {(['admin', 'boss', 'godown_incharge'].includes(user?.role) || user?.is_staff) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setCustodyReviewEventId(Number(conf.id));
                        }}
                        className="text-amber-400 hover:text-white text-[10px] font-black uppercase"
                        title="Review current custody without changing inventory"
                      >
                        <i aria-hidden="true" className="fa-solid fa-magnifying-glass"></i>
                      </button>
                    )}
                    {(user?.is_staff || user?.role === 'accounts') ? (
                      <>
                        <button onClick={() => openEditConferenceForm(conf)} className="text-sky-400 hover:text-white" title="Edit Conference Details">
                          <i aria-hidden="true" className="fa-solid fa-pen"></i>
                        </button>
                        {user?.is_staff && (
                          <button onClick={() => handleDeleteConference(conf.id)} className="text-red-400 hover:text-white" title="Delete Conference">
                            <i aria-hidden="true" className="fa-solid fa-trash"></i>
                          </button>
                        )}
                      </>
                    ) : (
                      <button onClick={() => openEditConferenceForm(conf)} className="text-sky-400 hover:text-white text-[10px] font-black uppercase tracking-widest pl-4">
                        View Execution <i aria-hidden="true" className="fa-solid fa-arrow-right ml-1"></i>
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {filteredConferences.length === 0 && (
              <tr>
                <td colSpan={5} className="px-10 py-8 text-center text-slate-500 font-bold uppercase text-xs tracking-widest">No conferences found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (isLoading) return <div className="min-h-screen bg-[#020617] flex items-center justify-center text-sky-500 font-black uppercase">Initializing System...</div>;
  if (!isLoggedIn) return <Login onLogin={handleLogin} />;

  // STANDALONE PRINT VIEW
  if (isPrintMode) {
    let printConf = selectedBookingForChallan;
    let printAssets = assets.filter(a => (printConf?.assets || []).map(String).includes(a.id.toString()));

    try {
      const storedConf = localStorage.getItem('print_conf_data');
      if (storedConf) {
        const parsedConf = JSON.parse(storedConf);
        if (parsedConf && String(parsedConf.id) === printConfId) {
          printConf = parsedConf;
        }
      }
      
      const storedAssets = localStorage.getItem('print_assets_data');
      if (storedAssets && printConf) {
        if (String(printConf.id) === printConfId) {
           printAssets = JSON.parse(storedAssets);
        }
      }
    } catch(err) {
      console.error("Local storage error for print data", err);
    }

    if (!printConf) {
      return <div className="min-h-screen bg-white flex items-center justify-center text-black font-bold uppercase">Generating Challan Preview...</div>;
    }
    const printTitle = localStorage.getItem('print_challan_title') || 'DELIVERY CHALLAN';
    const printTruckSuffix = localStorage.getItem('print_truck_suffix') || '';

    return (
      <div className="min-h-screen bg-white p-8 print:p-0 print:m-0 print:min-h-0 relative">
        <button
          onClick={() => window.print()}
          disabled={localStorage.getItem('print_document_kind') !== 'return' && !challanSourcesReady(printConf, printTruckSuffix)}
          className="no-print fixed bottom-8 right-8 z-[100] w-16 h-16 bg-sky-500 text-white rounded-full shadow-2xl flex items-center justify-center hover:bg-sky-400 active:scale-95 transition-all"
          title="Print / Save PDF"
        >
          <i aria-hidden="true" className="fa-solid fa-print text-2xl"></i>
        </button>

        <ChallanView
          draftAccountId={String(user?.user_id || user?.email || "")}
          booking={printConf}
          client={MOCK_CLIENTS[0]}
          assets={printAssets}
          sourcesReady={localStorage.getItem('print_document_kind') === 'return' || challanSourcesReady(printConf, printTruckSuffix)}
          onRetrySources={() => fetchConferenceSubrentalTickets(printConf!.id)}
          useSavedDocument={localStorage.getItem('print_document_kind') !== 'return'}
          companySettings={companySettings}
          subrentalTickets={localStorage.getItem('print_document_kind') === 'return' ? [] : confSubrentalTickets}
          challanTitle={printTitle}


          showScanToast={showScanToast}



          readOnly={true}
          localStorageSuffix={printTruckSuffix || undefined}
        />
        <style>{`
            @media print {
              @page { size: A4 portrait; margin: 0; }
              html, body { 
                margin: 0; 
                padding: 0; 
                width: 210mm; 
                height: 297mm;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
              body { 
                background: white !important; 
              }
              table { 
                page-break-inside: auto;
              }
              thead { 
                display: table-header-group !important; 
              }
              tr { 
                page-break-inside: avoid; 
                page-break-after: auto; 
              }
            }
        `}</style>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-950">
      <SavedWorkRecovery key={`saved-work:${user?.user_id || ''}`} account={String(user?.user_id || '')} apiFetch={reportApiFetch} onCopied={() => { try { setPendingMovementCount(getMovementOutbox().pending().length); } catch { setPendingMovementCount(1); } }} />
      <StaffPendingNotice key={String(user?.user_id || user?.email || '')} user={user} apiFetch={reportApiFetch} onChanged={allocationsChanged} />
      <EventLifecycle key={`lifecycle:${String(user?.user_id || user?.email || '')}`} user={user} eventId={lifecycleReviewEventId} apiFetch={reportApiFetch} onClose={() => setLifecycleReviewEventId(null)} refreshEvent={refreshLifecycleEvent} />
      <SupplierSaveNotice saving={supplierSaving} />
      <ReconciliationReview key={`repair:${String(user?.user_id || user?.email || '')}`} user={user} eventId={reconciliationEventId} apiFetch={reportApiFetch} refresh={refreshReconciliationState} onClose={() => setReconciliationEventId(null)} />
      {custodyReviewEventId !== null && <CustodyReview key={`${user?.id}:${custodyReviewEventId}`} conferenceId={custodyReviewEventId} loadReview={loadCustodyReview} onClose={() => setCustodyReviewEventId(null)} />}
      <aside className={`no-print fixed inset-y-0 left-0 z-50 w-72 bg-[var(--sidebar-bg)] border-r border-slate-900 transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-8 relative">
          <Logo size="sm" companySettings={companySettings} className="mb-12" />
          <div className="absolute top-2 right-4 text-[10px] text-white/20 font-black tracking-widest uppercase no-print">v1.5-RBAC</div>
          <nav className="space-y-4">
            {/* ... nav items ... */}
            {[
              ...((user?.is_staff || user?.role !== 'technician') ? [
                { id: 'Dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
              ] : []),
              ...((user?.is_staff || user?.role === 'godown_incharge' || user?.role === 'accounts') ? [
                { id: 'Assets', icon: 'fa-boxes-stacked', label: 'Inventory' },
              ] : []),
              { id: 'Conferences', icon: 'fa-user-md', label: 'Conference' },
              { id: 'Billing', icon: 'fa-receipt', label: 'Challans' },
              ...(user?.is_staff || user?.role !== 'technician' ? [
                { id: 'Reports', icon: 'fa-chart-pie', label: 'Reports' }
              ] : []),
              ...(user?.is_staff || user?.role !== 'technician' ? [
                { id: 'Subrentals', icon: 'fa-building-shield', label: 'Subrentals' }
              ] : []),
              { id: 'Settings', icon: 'fa-cog', label: 'Settings' }
            ].map(item => (
              <button key={item.id} onClick={() => handleViewChange(item.id as Page)}
                className={`w-full flex items-center px-6 py-4 rounded-2xl font-black transition-all ${currentPage === item.id ? 'bg-sky-500 text-white' : 'text-white/40 hover:text-white'}`}>
                <i aria-hidden="true" className={`fa-solid ${item.icon} w-8 text-xl`}></i>
                <span className="uppercase tracking-widest text-[10px] ml-2">{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="mt-auto p-10">
          <button onClick={handleServerLogout} className="w-full py-4 bg-slate-900/50 text-white/30 rounded-2xl font-black uppercase text-xs hover:text-white hover:bg-slate-800 transition flex items-center justify-center gap-3 border border-white/5">
            <i aria-hidden="true" className="fa-solid fa-power-off"></i>
            Sign out shared login
          </button>
        </div>
      </aside>

      <main ref={mainRef} className="flex-1 overflow-y-auto no-print scroll-smooth">
        <header className="bg-slate-950/60 backdrop-blur-3xl border-b border-slate-900 px-4 md:px-12 py-4 md:py-8 sticky top-0 z-40 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 md:gap-0">
          <div className="flex items-center gap-4 flex-wrap w-full md:w-auto">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden w-10 h-10 bg-slate-900 rounded-lg border border-slate-800 flex items-center justify-center text-slate-400"
            >
              <i aria-hidden="true" className={`fa-solid ${isMobileMenuOpen ? 'fa-xmark' : 'fa-bars'}`}></i>
            </button>
            <div className="px-5 py-2 bg-slate-900/80 rounded-full border border-slate-800">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">
                {companySettings?.name || 'TECH TROLLEY'}
              </span>
            </div>

            {/* PWA Update Notifications */}
            {offlineReady && (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-xl animate-in fade-in zoom-in duration-300">
                <i aria-hidden="true" className="fa-solid fa-cloud-arrow-down text-emerald-400 text-xs"></i>
                <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest">Offline Ready</span>
                <button onClick={closeUpdatePrompt} className="ml-2 text-emerald-400/50 hover:text-emerald-400 transition">
                  <i aria-hidden="true" className="fa-solid fa-xmark text-[10px]"></i>
                </button>
              </div>
            )}

            {pendingMovementCount > 0 && <button type="button" onClick={() => { void retryPendingMovements(); }} className="rounded-xl bg-amber-500 px-3 py-2 text-xs font-bold text-slate-950">
              {pendingMovementCount} movement(s) pending — retry
            </button>}
            {needRefresh && (
              <div className="flex items-center gap-3 bg-orange-500/10 border border-orange-500/20 px-4 py-2 rounded-xl animate-in slide-in-from-left-4 duration-500">
                <div className="flex flex-col">
                  <span className="text-[9px] font-black text-orange-400 uppercase tracking-widest leading-none mb-1">Update Available</span>
                  <span className="text-[8px] font-bold text-slate-500 uppercase leading-none">{updateBlocked ? 'Save work and close other or older tabs, then retry' : 'Save your work, then restart to update'}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (hasPendingWork() || showScanner || pendingParentAsset || conferenceView === 'Form') {
                        showScanToast('Save or close your editing/scanning session before updating.', 'warning');
                        return;
                      }
                      void updateServiceWorker(true);
                    }}
                    className="px-3 py-1.5 bg-orange-500 text-white rounded-lg text-[9px] font-black uppercase hover:bg-orange-400 transition shadow-lg shadow-orange-500/20"
                  >
                    Restart to Update
                  </button>
                  <button onClick={closeUpdatePrompt} className="w-7 h-7 flex items-center justify-center text-slate-500 hover:text-white transition">
                    <i aria-hidden="true" className="fa-solid fa-xmark text-xs"></i>
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-slate-500 uppercase hidden lg:block">{user.email}</span>
                {user.role === 'boss' && (
                  <span className="px-2.5 py-1 bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded-full text-[9px] font-black uppercase tracking-wider flex items-center gap-1.5 shadow-sm">
                    <i aria-hidden="true" className="fa-solid fa-crown text-[9px]" /> Boss
                  </span>
                )}
              </div>
            )}
            <div className={`w-10 h-10 md:w-12 md:h-12 bg-slate-900 rounded-xl border-2 ${user?.role === 'boss' ? 'border-amber-500/40 text-amber-400 shadow-lg shadow-amber-500/10' : 'border-slate-800 text-sky-500'} flex items-center justify-center`}>
              <i aria-hidden="true" className={`fa-solid ${user?.role === 'boss' ? 'fa-crown' : 'fa-user-shield'}`}></i>
            </div>
            <button onClick={handleServerLogout} className="w-10 h-10 md:w-12 md:h-12 bg-slate-900 rounded-xl border-2 border-slate-800 flex items-center justify-center text-red-400 hover:bg-slate-800 hover:text-red-300 transition" title="Sign out devices sharing this login">
              <i aria-hidden="true" className="fa-solid fa-power-off"></i>
            </button>
          </div>
        </header>
        {user?.user_id && ['admin', 'boss', 'godown_incharge'].includes(user.role) && <OfflineScanning
          key={`offline:${user.user_id}:${user.role}`} accountId={Number(user.user_id)} role={user.role}
          events={backendConferences} loadEvents={fetchConferences} prepare={prepareOfflineEvent} queue={queueOfflineAsset} />}
        <div className="p-3.5 sm:p-6 md:p-12 max-w-7xl mx-auto">
          {currentPage === 'Dashboard' && renderDashboard()}
          {currentPage === 'Settings' && <SettingsView apiFetch={apiFetch} user={user} onCredentialsChanged={handleLogout} />}
          {currentPage === 'Subrentals' && (
            selectedSubrentalCompany 
              ? (showSubrentalInventory ? renderSubrentalInventory() : renderSubrentalTickets()) 
              : renderSubrentals()
          )}
          {currentPage === 'Reports' && <ReportsView apiFetch={reportApiFetch} user={user} onEditAsset={openEditAssetForm} allocationRefreshKey={allocationRefreshKey} onAllocationsChanged={allocationsChanged} />}
          {currentPage === 'Assets' && assetView === 'List' && renderInventory()}
          {currentPage === 'Assets' && assetView === 'Details' && renderAssetDetails()}
          {currentPage === 'Employees' && employeeView === 'List' && renderEmployees()}
          {currentPage === 'Conferences' && conferenceView === 'List' && renderConferences()}


          {currentPage === 'Assets' && assetView === 'Form' && (() => {
            // J-95: Use the full shadow DB for alias suggestions — avoids pagination blindness.
            // Falls back to `assets` only if the ref hasn't loaded yet (app just mounted).
            const aliasPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
            const uniqueAliasNames = Array.from(new Set(aliasPool.map(a => a.aliasName).filter(Boolean)));
            
            const handleAliasChange = (e: React.ChangeEvent<HTMLInputElement>) => {
              const selectedAlias = e.target.value;
              const isLaptop = /laptop|imac|macbook/i.test(selectedAlias);
              const autoDepreciation = isLaptop ? 40 : 15;

              // J-96: Search the full shadow DB first so newly registered aliases
              // get their type auto-filled without requiring a page refresh.
              const searchPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
              const matchedAsset = searchPool.find(a => a.aliasName === selectedAlias);

              if (matchedAsset) {
                setAssetFormData(prev => ({
                  ...prev,
                  aliasName: selectedAlias,
                  type: matchedAsset.type,
                  depreciationPercentage: isEditing ? (prev.depreciationPercentage ?? 15) : autoDepreciation
                }));
              } else {
                // Secondary fallback: curated aliasDictionary (e.g. for pre-seeded type mappings)
                const matchedItem = aliasDictionary.find(a => a.alias_name === selectedAlias);
                if (matchedItem) {
                  setAssetFormData(prev => ({
                    ...prev,
                    aliasName: selectedAlias,
                    type: matchedItem.type,
                    depreciationPercentage: isEditing ? (prev.depreciationPercentage ?? 15) : autoDepreciation
                  }));
                } else {
                  setAssetFormData(prev => ({
                    ...prev,
                    aliasName: selectedAlias,
                    depreciationPercentage: isEditing ? (prev.depreciationPercentage ?? 15) : autoDepreciation
                  }));
                }
              }
            };


            const isEditing = !!editingAsset;

            // J-93: Use the full shadow DB for SKU checks — avoids stale paginated buffer.
            // Falls back to `assets` only if the ref hasn't loaded yet (app just mounted).
            const skuPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;

            // True while the shadow DB is still populating — prevents premature submit
            // with a stale suggestion. Once allAssetsRef is loaded, this is always false.
            const skuCalculating = assets.length > 0 && allAssetsRef.current.length === 0;

            const skuExists = !!(assetFormData.sku && skuPool.some(
              a => a.sku?.toLowerCase() === assetFormData.sku.toLowerCase() &&
                   (!isEditing || a.id !== editingAsset.id)
            ));

            let suggestedSku = '';
            if (!isEditing && assetFormData.aliasName) {
              const base = assetFormData.aliasName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
              const matches = skuPool.filter(a => a.sku?.toLowerCase().startsWith(`${base}_`));
              let max = 0;
              matches.forEach(m => {
                const numPart = m.sku?.toLowerCase().replace(`${base}_`, '');
                const num = parseInt(numPart || '0');
                if (!isNaN(num) && num > max) max = num;
              });
              if (matches.length > 0 || skuPool.some(a => a.sku?.toLowerCase() === base)) {
                suggestedSku = `${base}_${max + 1}`;
              } else {
                suggestedSku = `${base}_1`;
              }
            }

            return (
            <div className="max-w-4xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <h2 className="text-5xl font-black text-white uppercase">
                {editingAsset ? 'Edit' : (assetFormData.type === AssetCategory.CONSUMABLES ? 'Register Consumable' : 'Register Asset')}
              </h2>
              <form onSubmit={handleSaveAsset} className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50 space-y-8">
                <datalist id="alias-dictionary-list">
                  {uniqueAliasNames.map((name, index) => (
                    <option key={index} value={name} />
                  ))}
                </datalist>
                {formErrors.non_field_errors && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl text-xs font-bold uppercase">
                    {formErrors.non_field_errors.join(', ')}
                  </div>
                )}

                {assetFormData.type === AssetCategory.CONSUMABLES ? (
                  /* Simplified Consumables Form */
                  <div className="space-y-8 animate-in fade-in zoom-in-95 duration-300">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
                      <div className="md:col-span-2">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Item Name (Alias)</label>
                        <input list="alias-dictionary-list" autoComplete="off" value={assetFormData.aliasName} onChange={handleAliasChange} className="form-input-night" placeholder="e.g. Yellow & Black Tape" required />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Unit Rate / Price</label>
                        <input type="number" value={assetFormData.itemPrice} onChange={e => setAssetFormData({ ...assetFormData, itemPrice: parseFloat(e.target.value) || 0 })} className="form-input-night" required />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Initial Stock Quantity</label>
                        <input type="number" min="1" value={assetFormData.quantity} onChange={e => setAssetFormData({ ...assetFormData, quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })} className="form-input-night" placeholder="e.g. 20" required />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Short Description</label>
                        <input value={assetFormData.description} onChange={e => setAssetFormData({ ...assetFormData, description: e.target.value })} className="form-input-night" placeholder="Optional notes..." />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Asset Flag</label>
                        <select value={assetFormData.flag} onChange={e => setAssetFormData({ ...assetFormData, flag: e.target.value as AssetFlag })} className="form-input-night">
                          {Object.values(AssetFlag).map(f => <option key={f} value={f}>{f || 'None'}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="bg-sky-500/10 border border-sky-500/20 p-6 rounded-3xl flex items-center gap-6 animate-in fade-in slide-in-from-top-2 duration-500">
                      <div className="shrink-0 p-2 bg-white rounded-2xl">
                        <GlobalQRPreview value={editingAsset?.qrCode || assetFormData.sku || 'CNS-AUTO'} />
                      </div>
                      <div className="flex-1 space-y-3">
                        <div>
                          <p className="text-[11px] font-black text-white uppercase tracking-wider">Item Unique QR Identity</p>
                          <p className="text-[10px] font-bold text-sky-400/80 uppercase tracking-widest leading-relaxed">
                            All units of <span className="text-amber-400 font-bold">{assetFormData.aliasName || 'this consumable'}</span> share this unique item QR code: <span className="text-white font-mono bg-white/10 px-2 py-0.5 rounded">{editingAsset?.qrCode || editingAsset?.sku || assetFormData.sku || 'Auto-Generated'}</span>.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setQrTarget({ sku: editingAsset?.qrCode || assetFormData.sku || 'CNS-AUTO', name: assetFormData.aliasName || 'Consumable Item QR' })}
                          className="px-4 py-2.5 bg-sky-500/10 border border-sky-500/20 text-sky-400 rounded-xl text-[10px] font-black uppercase hover:bg-sky-500 hover:text-white transition flex items-center gap-2"
                        >
                          <i aria-hidden="true" className="fa-solid fa-print"></i> Print Item QR Label
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Standard Asset Form */
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">SKU / Tag</label>
                        <input value={assetFormData.sku} onChange={e => setAssetFormData({ ...assetFormData, sku: e.target.value })} className="form-input-night" required={!assetFormData.subrental_company} />
                        {skuExists && <p className="text-red-500 font-bold text-xs mt-1 uppercase tracking-widest animate-pulse">Warning: This SKU already exists!</p>}
                        {skuCalculating && !skuExists && (
                          <p className="text-amber-400 font-bold text-[10px] mt-1 uppercase tracking-widest flex items-center gap-1">
                            <i aria-hidden="true" className="fa-solid fa-spinner fa-spin text-[9px]"></i> Verifying availability…
                          </p>
                        )}
                        {suggestedSku && !skuExists && !skuCalculating && (
                          <p
                            className="text-sky-400 font-bold text-[10px] mt-1 uppercase tracking-widest cursor-pointer hover:text-sky-300 transition"
                            onClick={() => setAssetFormData({ ...assetFormData, sku: suggestedSku })}
                          >
                            Suggested: {suggestedSku}
                          </p>
                        )}
                        {formErrors.sku && (
                          <div className="mt-2 flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                            <i aria-hidden="true" className="fa-solid fa-circle-exclamation text-red-400 text-xs mt-0.5 shrink-0"></i>
                            <p className="text-red-400 font-bold text-[10px] uppercase tracking-widest">
                              {Array.isArray(formErrors.sku) ? formErrors.sku.join(' ') : formErrors.sku}
                            </p>
                          </div>
                        )}
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Alias Name</label>
                        <input list="alias-dictionary-list" autoComplete="off" value={assetFormData.aliasName} onChange={handleAliasChange} className="form-input-night" />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">MAC Address</label>
                        <input value={assetFormData.macAddress} onChange={e => setAssetFormData({ ...assetFormData, macAddress: e.target.value })} className="form-input-night" placeholder="e.g. 00:1A:2B..." />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">IMEI Number 1</label>
                        <input value={assetFormData.imeiNumber1} onChange={e => setAssetFormData({ ...assetFormData, imeiNumber1: e.target.value })} className="form-input-night" />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">IMEI Number 2</label>
                        <input value={assetFormData.imeiNumber2} onChange={e => setAssetFormData({ ...assetFormData, imeiNumber2: e.target.value })} className="form-input-night" />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Serial Number</label>
                        <input value={assetFormData.serialNumber} onChange={e => setAssetFormData({ ...assetFormData, serialNumber: e.target.value })} className="form-input-night" />
                        {formErrors.serial_number && <p className="text-red-500 text-xs mt-1">{formErrors.serial_number}</p>}
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Type / Category</label>
                        <select
                          value={getUICategory(assetFormData.type)}
                          onChange={(e) => {
                            const newType = mapUIToDBType(e.target.value);
                            setAssetFormData({ ...assetFormData, type: newType });
                          }}
                          className="w-full bg-slate-900 border border-slate-800 p-5 rounded-2xl text-white font-bold outline-none focus:border-sky-500"
                        >
                          {Object.values(UICategory).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                        </select>
                        {formErrors.type && <p className="text-red-500 text-xs mt-1">{formErrors.type}</p>}
                      </div>
                    </div>



                    <div>
                      <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Description</label>
                      <textarea value={assetFormData.description} onChange={e => setAssetFormData({ ...assetFormData, description: e.target.value })} className="form-input-night h-24 resize-none" placeholder="Brand, Model, and other details..." />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Purchased Date</label>
                        <input type="date" value={assetFormData.purchasedDate} onChange={e => setAssetFormData({ ...assetFormData, purchasedDate: e.target.value })} className="form-input-night" />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Item Price</label>
                        <input type="number" value={assetFormData.itemPrice} onChange={e => setAssetFormData({ ...assetFormData, itemPrice: parseFloat(e.target.value) })} className="form-input-night" />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Depreciation %</label>
                        <input type="number" value={assetFormData.depreciationPercentage} onChange={e => setAssetFormData({ ...assetFormData, depreciationPercentage: parseFloat(e.target.value) })} className="form-input-night" />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">
                          Quantity {!isEditing && (assetFormData.quantity ?? 1) > 1 ? `(Creates ${assetFormData.quantity} items)` : ''}
                        </label>
                        <input
                          type="number"
                          min="1"
                          disabled={isEditing}
                          value={assetFormData.quantity ?? 1}
                          onChange={e => setAssetFormData({ ...assetFormData, quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                          className={`form-input-night ${isEditing ? 'opacity-50 cursor-not-allowed' : ''}`}
                          title={isEditing ? 'Editing existing single asset' : 'Number of separate items to create in inventory'}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Internal Condition</label>
                        <input value={assetFormData.condition} onChange={e => setAssetFormData({ ...assetFormData, condition: e.target.value })} className="form-input-night" placeholder="e.g. Good, Like New..." />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Asset Flag</label>
                        <select value={assetFormData.flag} onChange={e => setAssetFormData({ ...assetFormData, flag: e.target.value as AssetFlag })} className="form-input-night">
                          {Object.values(AssetFlag).map(f => <option key={f} value={f}>{f || 'None'}</option>)}
                        </select>
                      </div>
                    </div>
                  </>
                )}

                <div className="flex gap-4 pt-4">
                  <button type="button" onClick={() => handleViewChange('Assets', 'List')} className="flex-1 py-6 bg-slate-800 text-white rounded-2xl font-black uppercase hover:bg-slate-700 transition">Cancel</button>
                  <button
                    type="submit"
                    disabled={skuExists || skuCalculating}
                    className={`flex-1 py-6 rounded-2xl font-black uppercase transition ${
                      skuExists ? 'bg-red-900/40 text-red-400 cursor-not-allowed' :
                      skuCalculating ? 'bg-slate-800 text-slate-500 cursor-wait' :
                      'bg-sky-500 text-white hover:bg-sky-400'
                    }`}
                  >
                    {skuCalculating ? 'Verifying SKU…' : 'Save Record'}
                  </button>
                </div>
              </form>
            </div>
          )})()}

          {currentPage === 'Employees' && employeeView === 'Form' && (
            <div className="max-w-4xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <h2 className="text-5xl font-black text-white uppercase">{editingEmployee ? 'Edit' : 'Register'} Employee</h2>
              <form onSubmit={handleSaveEmployee} className="bg-slate-900/30 p-6 md:p-10 rounded-[1.5rem] md:rounded-[2.5rem] border border-slate-800/50 space-y-6 md:space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Full Name</label>
                    <input value={employeeFormData.name} onChange={e => setEmployeeFormData({ ...employeeFormData, name: e.target.value })} className="form-input-night" required />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Employee ID</label>
                    <input value={employeeFormData.employee_id} onChange={e => setEmployeeFormData({ ...employeeFormData, employee_id: e.target.value })} className="form-input-night" required />
                    {formErrors.employee_id && <p className="text-red-500 text-xs mt-1">{formErrors.employee_id}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Department</label>
                    <input value={employeeFormData.department} onChange={e => setEmployeeFormData({ ...employeeFormData, department: e.target.value })} className="form-input-night" required />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Email</label>
                    <input type="email" value={employeeFormData.email} onChange={e => setEmployeeFormData({ ...employeeFormData, email: e.target.value })} className="form-input-night" required />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Phone</label>
                    <input value={employeeFormData.phone} onChange={e => setEmployeeFormData({ ...employeeFormData, phone: e.target.value })} className="form-input-night" required />
                  </div>
                </div>
                {!editingEmployee && <label className="block text-sm text-slate-300">Initial login password (optional)
                  <input aria-label="Initial employee login password" type="password" autoComplete="new-password" minLength={10} value={employeeInitialPassword} onChange={e=>setEmployeeInitialPassword(e.target.value)} className="form-input-night" />
                  <span>Leave blank to keep password login unavailable until a password is set.</span>
                  {formErrors.password && <p role="alert">{formErrors.password}</p>}
                </label>}
                <div className="flex gap-4 pt-4">
                  <button type="button" onClick={() => setEmployeeView('List')} className="flex-1 py-6 bg-slate-800 text-white rounded-2xl font-black uppercase hover:bg-slate-700 transition">Cancel</button>
                  <button type="submit" className="flex-1 py-6 bg-indigo-500 text-white rounded-2xl font-black uppercase hover:bg-indigo-600 transition">Save Employee</button>
                </div>
              </form>
            </div>
          )}

          {currentPage === 'Conferences' && conferenceView === 'Form' && (
            <div className="max-w-7xl mx-auto space-y-10 pb-20">
              <p className="text-sm text-slate-400">Event details are kept as a draft until you save. Equipment scans save separately after server confirmation.</p>
              {eventFormSealed && <p role="status" className="p-4 rounded-xl bg-amber-950 text-amber-200">This event is completed or archived. New movements and operational edits are locked. Its history remains available; an administrator must explicitly reopen it before changes.</p>}
              {eventDraftStorageFailed && <p className="p-4 rounded-xl bg-red-950 text-red-200">This browser could not keep the event draft. Keep this page open until the save is confirmed.</p>}
              {eventDraftConflict && <div className="p-4 rounded-xl bg-amber-950 text-amber-200">This event changed after your draft was started. Your edits are preserved. Copy any details you need before loading the latest saved event. <button onClick={loadLatestEventDetails} className="underline ml-3">Load latest saved details</button></div>}
              {pdfFile && <p className="text-amber-300">The selected PDF stays only in this tab. Select it again if you reload before saving.</p>}
              {/* Top Banner Header */}
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div className="space-y-4">
                  <button
                    onClick={() => setConferenceView('List')}
                    className="flex items-center gap-2 text-slate-500 hover:text-sky-500 font-black uppercase text-[10px] tracking-widest transition"
                  >
                    <i aria-hidden="true" className="fa-solid fa-arrow-left"></i> Back to list
                  </button>
                  <div className="space-y-1">
                    <h2 className="text-5xl md:text-7xl font-black text-orange-500 uppercase tracking-tighter leading-none">
                      {conferenceFormData.name || "UNNAMED CONFERENCE"}
                    </h2>
                    {conferenceFormData.is_audit && (
                      <span className="inline-flex items-center gap-2 mt-3 px-4 py-1.5 rounded-full text-[10px] font-black uppercase bg-amber-500/10 text-amber-500 border border-amber-500/30">
                        <i aria-hidden="true" className="fa-solid fa-eye" /> Audit Mode — Non-Blocking
                      </span>
                    )}
                    <p className="text-sm md:text-lg font-bold text-slate-500 uppercase tracking-wide">
                      {conferenceFormData.association_name || "Association Not Specified"}
                    </p>
                    {conferenceFormData.pdf_document && (
                      <div className="pt-2">
                        <button type="button" onClick={(e) => { e.stopPropagation(); handleDownloadPdf(conferenceFormData.id); }}
                          className="inline-flex items-center gap-3 bg-sky-500 text-white px-6 py-3.5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-sky-500/30 hover:bg-sky-400 hover:scale-105 active:scale-95 transition-all"
                        >
                          <i aria-hidden="true" className="fa-solid fa-file-pdf text-base"></i>
                          Download Logistics PDF
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {(user?.is_staff || user?.role === 'accounts') && (
                    <button
                      type="button"
                      onClick={() => handleUpdateLogistics()}
                      className="flex items-center gap-2 px-6 py-3 bg-sky-500 hover:bg-sky-400 text-white text-xs font-black uppercase tracking-widest rounded-2xl shadow-lg shadow-sky-500/20 transition-all active:scale-95"
                      disabled={eventFormSealed}
                      title="Save All Conference Details"
                    >
                      <i aria-hidden="true" className="fa-solid fa-floppy-disk"></i> Save Conference
                    </button>
                  )}
                  {(() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const start = new Date(conferenceFormData.start_date);
                    const end = new Date(conferenceFormData.end_date);
                    
                    const statusLabel = eventLifecycleLabel({ lifecycle_state: backendConferences.find(event => String(event.id) === String(conferenceFormData.id))?.lifecycle_state || conferenceFormData.lifecycle_state, startDate: conferenceFormData.start_date, endDate: conferenceFormData.end_date });
                    let statusClass = 'bg-emerald-100 text-emerald-600 border-emerald-200';
                    
                    if (today < start) {
                      statusClass = 'bg-blue-100 text-blue-600 border-blue-200';
                    } else if (today > end) {
                      statusClass = 'bg-slate-200 text-slate-500 border-slate-300';
                    }
                    
                    return (
                      <div className={`px-5 py-2 rounded-full text-[10px] font-black uppercase tracking-widest border ${statusClass}`}>
                        {statusLabel}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Administrative Top Section - Full Width / 2-Column for Identity & Billing */}
              {(user?.is_staff || user?.role === 'accounts' || (user?.role !== 'godown_incharge' && user?.role !== 'technician')) && (
                <div className="space-y-10">
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-10">
                    {/* Conference Identity & Schedule */}
                    <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 shadow-xl shadow-sky-500/5 space-y-6">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-orange-50 text-orange-500 rounded-xl flex items-center justify-center text-lg border border-orange-100">
                          <i aria-hidden="true" className="fa-solid fa-calendar-days"></i>
                        </div>
                        <h3 className="font-black text-slate-800 uppercase tracking-[0.2em] text-[10px]">Conference Identity & Schedule</h3>
                      </div>
                      {['admin', 'boss', 'accounts', 'godown_incharge'].includes(user?.role || '') && <SavedContacts
                        key={`contacts:${user?.user_id || user?.email}:${conferenceFormData.id || 'new'}`} form={conferenceFormData}
                        onChange={patch => setConferenceFormData((previous: any) => ({ ...previous, ...patch }))}
                        apiFetch={reportApiFetch} canSave={['admin', 'boss', 'accounts'].includes(user?.role || '')} />}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Conference Name <span className="text-red-500">*</span></label>
                          <input value={conferenceFormData.name} onChange={e => setConferenceFormData({ ...conferenceFormData, name: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Conference Name" required />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Customer / Association Name <span className="text-red-500">*</span></label>
                          <input value={conferenceFormData.association_name} onChange={e => setConferenceFormData({ ...conferenceFormData, association_name: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Customer / Association Name" required />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Type</label>
                          <select value={conferenceFormData.conference_type} onChange={e => setConferenceFormData({ ...conferenceFormData, conference_type: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20">
                            <option value="Medical Conference">Medical Conference</option>
                            <option value="Personal Rental">Personal Rental</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Start Date <span className="text-red-500">*</span></label>
                          <input type="date" value={conferenceFormData.start_date} onChange={e => setConferenceFormData({ ...conferenceFormData, start_date: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" required />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">End Date <span className="text-red-500">*</span></label>
                          <input type="date" value={conferenceFormData.end_date} onChange={e => setConferenceFormData({ ...conferenceFormData, end_date: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" required />
                        </div>
                      </div>

                      {/* J-109: Audit Mode toggle */}
                      <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                        <input
                          type="checkbox"
                          id="audit_mode"
                          checked={!!conferenceFormData.is_audit}
                          disabled={Boolean(editingConference)}
                          onChange={e => setConferenceFormData({ ...conferenceFormData, is_audit: e.target.checked })}
                          className="mt-0.5 w-4 h-4 accent-amber-500 shrink-0 cursor-pointer"
                        />
                        <label htmlFor="audit_mode" className="text-[10px] font-black text-amber-700 uppercase tracking-widest cursor-pointer leading-relaxed">
                          Audit Mode (Non-Blocking List)
                          <span className="block text-[9px] font-bold normal-case text-amber-600 mt-0.5 tracking-normal">
                            Assets in this conference will NOT lock or block other live events.
                          </span>
                        </label>
                      </div>
                    </div>

                    {/* Billing & Contact Details */}
                    <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 shadow-xl shadow-sky-500/5 space-y-6">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-indigo-50 text-indigo-500 rounded-xl flex items-center justify-center text-lg border border-indigo-100">
                          <i aria-hidden="true" className="fa-solid fa-file-invoice-dollar"></i>
                        </div>
                        <h3 className="font-black text-slate-800 uppercase tracking-[0.2em] text-[10px]">Billing & GST</h3>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Billing Address <span className="text-red-500">*</span></label>
                          <textarea value={conferenceFormData.billing_address} onChange={e => setConferenceFormData({ ...conferenceFormData, billing_address: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold h-24 resize-none focus:ring-2 focus:ring-sky-500/20" placeholder="Billing Address" required />
                        </div>
                        <div className="space-y-4">
                          <div>
                            <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">GST Number</label>
                            <input value={conferenceFormData.gst_number} onChange={e => setConferenceFormData({ ...conferenceFormData, gst_number: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="GST Number" />
                          </div>
                          <div>
                            <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Transport Address</label>
                            <textarea value={conferenceFormData.transport_address} onChange={e => setConferenceFormData({ ...conferenceFormData, transport_address: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Transport / Delivery Address" />
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-slate-100">
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Contact Person</label>
                          <input value={conferenceFormData.contact_person} onChange={e => setConferenceFormData({ ...conferenceFormData, contact_person: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Name" />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Phone</label>
                          <input value={conferenceFormData.contact_phone} onChange={e => setConferenceFormData({ ...conferenceFormData, contact_phone: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Phone" />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Email</label>
                          <input type="email" value={conferenceFormData.contact_email} onChange={e => setConferenceFormData({ ...conferenceFormData, contact_email: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Email" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Technician Assignment - Specific Row for Admin */}
                  <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 shadow-xl shadow-sky-500/5 space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center text-lg border border-emerald-100">
                          <i aria-hidden="true" className="fa-solid fa-user-gear"></i>
                        </div>
                        <div>
                          <h3 className="font-black text-slate-800 uppercase tracking-[0.2em] text-[10px]">Technician Assignment</h3>
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Select members to manage this conference</p>
                        </div>
                      </div>
                      <div className="px-3 py-1 bg-sky-50 border border-sky-100 text-sky-600 rounded-lg text-[10px] font-black uppercase tracking-widest">
                        {conferenceFormData.assigned_employees.length} Assigned
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                      {employees.filter(emp => emp.role !== 'accounts' && emp.department?.toLowerCase() !== 'accounts').length === 0 ? (
                        <div className="col-span-full py-6 text-center">
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest italic">No Technicians Loaded. Try refreshing.</p>
                        </div>
                      ) : employees.filter(emp => emp.role !== 'accounts' && emp.department?.toLowerCase() !== 'accounts').map(emp => {
                        // Use string comparison for robustness across different DB types
                        const isAssigned = (conferenceFormData.assigned_employees || []).some(id => String(id) === String(emp.id));
                        return (
                          <button
                            key={emp.id}
                            type="button"
                            onClick={() => {
                              const current = [...(conferenceFormData.assigned_employees || [])].map(String);
                              const empIdStr = String(emp.id);
                              if (current.includes(empIdStr)) {
                                setConferenceFormData({ ...conferenceFormData, assigned_employees: current.filter(id => id !== empIdStr) });
                              } else {
                                setConferenceFormData({ ...conferenceFormData, assigned_employees: [...current, empIdStr] });
                              }
                            }}
                            className={`flex items-center gap-3 p-3 rounded-xl border text-[10px] font-black uppercase transition-all duration-300 ${isAssigned ? 'bg-sky-500 border-sky-400 text-white shadow-lg shadow-sky-500/20' : 'bg-slate-50 border-slate-200 text-slate-400 hover:border-sky-300 hover:bg-white'}`}
                          >
                            <i aria-hidden="true" className={`fa-solid ${isAssigned ? 'fa-check-circle' : 'fa-circle-user'}`}></i>
                            <span className="truncate">{emp.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
                {/* Second Row Bottom: Logistics (Narrow) & Scanning (Wide) */}
                <div className="xl:col-span-4 space-y-8">
                  <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 md:p-10 shadow-xl shadow-sky-500/5 space-y-8 relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-sky-50 rounded-full -mr-12 -mt-12 group-hover:bg-sky-100 transition-colors duration-500 opacity-50"></div>

                    <div className="flex items-center gap-4 relative">
                      <div className="w-12 h-12 bg-sky-500/10 text-sky-500 rounded-2xl flex items-center justify-center text-xl shadow-inner border border-sky-500/20">
                        <i aria-hidden="true" className="fa-solid fa-truck"></i>
                      </div>
                      <h3 className="font-black text-slate-800 uppercase tracking-[0.2em] text-xs">Logistics Info</h3>
                    </div>

                    <div className="space-y-6 relative">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Vehicle Number <span className="text-red-500">*</span></label>
                        <input 
                          value={conferenceFormData.vehicle_number} 
                          onChange={e => setConferenceFormData({ ...conferenceFormData, vehicle_number: e.target.value })} 
                          className="w-full bg-sky-50/50 border-none rounded-2xl px-6 py-5 text-sm font-black text-slate-800 focus:ring-2 focus:ring-sky-500/30 transition-shadow placeholder:text-slate-300"
                          placeholder="e.g. KL 01 HJ 5241"
                          required
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Driver Phone <span className="text-red-500">*</span></label>
                        <input 
                          value={conferenceFormData.driver_phone} 
                          onChange={e => setConferenceFormData({ ...conferenceFormData, driver_phone: e.target.value })} 
                          className="w-full bg-sky-50/50 border-none rounded-2xl px-6 py-5 text-sm font-black text-slate-800 focus:ring-2 focus:ring-sky-500/30 transition-shadow placeholder:text-slate-300"
                          placeholder="9021457863"
                          required
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Challan Date</label>
                        <input 
                          type="date"
                          value={conferenceFormData.challan_date || ''} 
                          onChange={e => setConferenceFormData({ ...conferenceFormData, challan_date: e.target.value })} 
                          className="w-full bg-sky-50/50 border-none rounded-2xl px-6 py-5 text-sm font-black text-slate-800 focus:ring-2 focus:ring-sky-500/30 transition-shadow placeholder:text-slate-300"
                        />
                      </div>

                      {(user?.is_staff || user?.role === 'accounts') && (
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Conference Document (PDF)</label>
                          <div className="relative group/file">
                            <input
                              type="file"
                              accept=".pdf"
                              onChange={e => {
                                const file = e.target.files?.[0];
                                if (file) setPdfFile(file);
                              }}
                              className="hidden"
                              id="pdf-upload"
                            />
                            <label
                              htmlFor="pdf-upload"
                              className="w-full flex items-center gap-4 bg-sky-50/50 border-2 border-dashed border-sky-100 rounded-2xl px-6 py-5 cursor-pointer hover:border-sky-500/50 hover:bg-sky-50 transition-all group-hover/file:shadow-inner"
                            >
                              <div className="w-12 h-12 rounded-xl bg-white shadow-sm border border-sky-100 flex items-center justify-center text-sky-500 group-hover/file:scale-110 transition-transform">
                                <i aria-hidden="true" className="fa-solid fa-cloud-arrow-up text-xl"></i>
                              </div>
                              <div className="flex-1 min-w-0 text-left">
                                <p className="text-sm font-bold text-slate-700 truncate">
                                  {pdfFile ? pdfFile.name : (conferenceFormData.pdf_document ? 'Update Document' : 'Upload Logistics PDF')}
                                </p>
                                <p className="text-[10px] text-slate-400 font-medium">Accepts PDF only • Max 10MB</p>
                              </div>
                              {pdfFile && (
                                <button
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPdfFile(null); }}
                                  className="text-slate-300 hover:text-red-500 transition-colors p-2"
                                  title="Clear selection"
                                >
                                  <i aria-hidden="true" className="fa-solid fa-times-circle"></i>
                                </button>
                              )}
                            </label>
                          </div>
                        </div>
                      )}


                      <div className="pt-4 grid grid-cols-1 gap-3">
                        <button 
                          type="button"
                          onClick={() => handlePrintChallan(editingConference, 'dispatch', true)}
                          className="w-full py-4 md:py-5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl font-black uppercase text-[10px] md:text-xs tracking-widest flex items-center justify-center gap-3 shadow-lg shadow-emerald-500/20 transition-all active:scale-95 leading-tight"
                        >
                          <i aria-hidden="true" className="fa-solid fa-print"></i> <span>Print Delivery Challan</span>
                        </button>
                        {(user?.is_staff || user?.role === 'accounts' || user?.role === 'technician' || user?.role === 'godown_incharge') && (
                          <button 
                            type="button"
                            onClick={() => handleUpdateLogistics()}
                            className="w-full py-4 md:py-5 bg-sky-600 hover:bg-sky-700 text-white rounded-2xl font-black uppercase text-[10px] md:text-xs tracking-widest flex items-center justify-center gap-3 shadow-lg shadow-sky-600/20 transition-all active:scale-95 leading-tight text-center"
                          >
                            <i aria-hidden="true" className="fa-solid fa-cloud-arrow-up"></i>
                            <span>{user?.role === 'technician' ? 'Submit Requirements' : user?.role === 'accounts' ? 'Save Conference Details' : 'Update Logistics & PDF'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column: Asset Scanning Card */}
                <div className="xl:col-span-8">
                  <div className="bg-white rounded-[2.5rem] border border-slate-200 p-4 sm:p-6 md:p-10 shadow-xl shadow-sky-500/5 h-full flex flex-col space-y-8 relative">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-orange-500/10 text-orange-500 rounded-2xl flex items-center justify-center text-xl shadow-inner border border-orange-500/20">
                          <i aria-hidden="true" className="fa-solid fa-qrcode"></i>
                        </div>
                        <h3 className="font-black text-slate-800 uppercase tracking-[0.2em] text-xs">Asset Scanning</h3>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="px-3 py-1 bg-sky-100 text-sky-600 rounded-lg text-[10px] font-black uppercase tracking-widest">
                          {conferenceFormData.assets.length + (conferenceFormData.crosscheck_assets || []).length} Total Assets
                        </div>
                        <div className="px-3 py-1 bg-orange-100 text-orange-600 rounded-lg text-[10px] font-black uppercase tracking-widest">
                          {conferenceFormData.assets.length} Scanned
                        </div>
                      </div>
                    </div>

                    {/* Scanning Control Bar */}
                    <div className="space-y-6">
                      <div className="flex gap-1 p-1.5 bg-sky-50/50 rounded-2xl border border-sky-100/50">
                        {/* 1. SELECT TAB (Non-Admin Only) */}
                        {(!user?.is_staff && (user?.role !== 'godown_incharge' && user?.role !== 'technician' && user?.role !== 'accounts')) && (
                          <button
                            onClick={() => setAssetTab('available')}
                            className={`flex-1 py-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${assetTab === 'available' ? 'bg-white text-sky-500 shadow-md shadow-sky-900/5' : 'text-slate-400 hover:text-slate-600 hover:bg-sky-100/30'}`}
                          >
                            Select
                          </button>
                        )}
                        
                        {/* 2. REQUIREMENTS TAB (Everyone) */}
                        <button
                          onClick={() => setAssetTab('assigned')}
                          className={`flex-1 py-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${assetTab === 'assigned' ? 'bg-white text-emerald-500 shadow-md shadow-sky-900/5' : 'text-slate-400 hover:text-slate-600 hover:bg-sky-100/30'}`}
                        >
                          Requirements
                        </button>

                        {/* 3. PACKUP TAB (Everyone) - Middle Section */}
                        <button
                          onClick={() => setAssetTab('packup')}
                          className={`flex-1 py-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${assetTab === 'packup' ? 'bg-white text-sky-500 shadow-md shadow-sky-900/5' : 'text-slate-400 hover:text-slate-600 hover:bg-sky-100/30'}`}
                        >
                          Packup
                        </button>

                        {/* 4. CROSSCHECK TAB (Admin/Godown/Accounts Monitor) */}
                        <button
                          onClick={() => setAssetTab('crosscheck')}
                          className={`flex-1 py-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${assetTab === 'crosscheck' ? 'bg-white text-orange-500 shadow-md shadow-sky-900/5' : 'text-slate-400 hover:text-slate-600 hover:bg-sky-100/30'}`}
                        >
                          Crosscheck
                        </button>
                      </div>

                      {/* Scanner visibility logic per role */}
                      {user?.role !== 'accounts' && ((assetTab === 'available') || 
                        ((user?.is_staff || (user?.role !== 'godown_incharge' && user?.role !== 'technician')) && assetTab === 'assigned') || 
                        (assetTab === 'packup') ||
                        (canVerifyReturns(user) && assetTab === 'crosscheck')) && (
                          <div className="relative group">
                            <div className="absolute left-4 md:left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors pointer-events-none">
                              <i aria-hidden="true" className="fa-solid fa-magnifying-glass"></i>
                            </div>
                            <input
                              type="text"
                              placeholder={assetTab === 'available' ? "Scan or type SKU..." : assetTab === 'assigned' ? "Scan to add equipment..." : "Scan to remove/verify..."}
                              value={assetTab === 'available' ? quickAddInput : quickRemoveInput}
                              onChange={(e) => assetTab === 'available' ? setQuickAddInput(e.target.value) : setQuickRemoveInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const val = (e.target as HTMLInputElement).value.trim();
                                  if (val) handleScan(val, true);
                                  if (assetTab === 'available') setQuickAddInput(''); else setQuickRemoveInput('');
                                }
                              }}
                              className="w-full bg-sky-50 border-none rounded-2xl pl-11 md:pl-14 pr-16 md:pr-20 py-4 md:py-6 text-xs md:text-sm font-black text-slate-800 focus:ring-4 focus:ring-sky-500/10 transition-all placeholder:text-slate-400 placeholder:font-bold shadow-sm"
                            />
                            <button
                              type="button"
                              onClick={() => setShowScanner(true)}
                              className="absolute right-3 md:right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-sky-500 hover:bg-sky-400 text-white rounded-xl shadow-lg shadow-sky-500/30 flex items-center justify-center transition-transform active:scale-90"
                              title="Scan with Camera"
                            >
                              <i aria-hidden="true" className="fa-solid fa-camera text-sm"></i>
                            </button>
                          </div>
                        )}
                      </div>

                    {/* Asset List Area */}
                    <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar min-h-[400px]">
                      {assetTab === 'available' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {!quickAddInput ? (
                            <div className="col-span-2 space-y-8">
                              <ScanPrompt subtitle="Type SKU or scan QR code to allocate assets" />

                              {/* Requirements List (for Tech) or Progress List (for Godown) */}
                              {user?.role === 'technician' ? (
                                (conferenceFormData.assets || []).length > 0 && (() => {
                                  const q = quickAddInput.toLowerCase();
                                  const qNorm = normalizeSearch(q);
                                  const techPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                                  const filteredAllocated = techPool.filter(a => {
                                    if (!new Set((conferenceFormData.assets || []).map(String)).has(String(a.id))) return false;
                                    if (!q) return true;
                                    return (a.sku && a.sku.toLowerCase().includes(q)) || 
                                           (a.aliasName && a.aliasName.toLowerCase().includes(q)) ||
                                           (a.serialNumber && a.serialNumber.toLowerCase().includes(q)) ||
                                           normalizeSearch(a.sku || '').includes(qNorm) ||
                                           normalizeSearch(a.aliasName || '').includes(qNorm);
                                  });
                                  if (quickAddInput && filteredAllocated.length === 0) return null;
                                  return (
                                    <div className="space-y-4 pt-6 border-t border-slate-100">
                                      <div className="flex items-center justify-between px-1">
                                        <h4 className="text-[10px] font-black text-sky-500 uppercase tracking-widest">{quickAddInput ? 'Search in Allocated' : 'Allocated Assets'}</h4>
                                        <span className="text-[10px] font-black text-sky-500 bg-sky-50 px-2 py-0.5 rounded-full">{filteredAllocated.length} ITEMS</span>
                                      </div>
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {filteredAllocated.map(asset => (
                                          <div key={asset.id} className="p-4 rounded-2xl border border-sky-100 bg-sky-50/20 flex items-center gap-4 transition-all hover:bg-sky-50/30">
                                            <div className="w-10 h-10 bg-white border border-sky-100 text-sky-500 rounded-xl flex items-center justify-center text-lg shadow-sm">
                                              <i aria-hidden="true" className="fa-solid fa-check-double"></i>
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              <p className="font-black uppercase text-xs text-slate-800 truncate">{asset.aliasName || asset.sku}</p>
                                              <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5 truncate">{asset.type} • ALLOCATED</p>
                                            </div>
                                            {user?.role !== 'accounts' && (
                                              <button
                                                onClick={() => triggerAssetConferenceAction(asset, 'unassign')}
                                                className="w-10 h-10 bg-white border border-slate-100 rounded-xl text-slate-400 hover:text-red-500 hover:border-red-500/50 transition-all flex items-center justify-center"
                                                title="Unassign Asset"
                                              >
                                                <i aria-hidden="true" className="fa-solid fa-trash-can text-xs"></i>
                                              </button>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : (
                                conferenceFormData.assets.length > 0 && (
                                  <div className="space-y-4 pt-6 border-t border-slate-100">
                                    <div className="flex items-center justify-between px-1">
                                      <h4 className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">Currently Scanned</h4>
                                      <span className="text-[10px] font-black text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full">{conferenceFormData.assets.length} ITEMS</span>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      {(allAssetsRef.current.length > 0 ? allAssetsRef.current : assets).filter(a => new Set(conferenceFormData.assets.map(String)).has(String(a.id))).map(asset => (
                                        <div key={asset.id} className="p-4 rounded-2xl border border-emerald-100 bg-emerald-50/20 flex items-center gap-4 transition-all hover:bg-emerald-50/30">
                                          <div className="w-10 h-10 bg-white border border-emerald-100 text-emerald-500 rounded-xl flex items-center justify-center text-lg shadow-sm">
                                            <i aria-hidden="true" className="fa-solid fa-check-double"></i>
                                          </div>
                                          <div className="min-w-0 flex-1">
                                            <p className="font-black uppercase text-xs text-slate-800 truncate">{asset.aliasName || asset.sku}</p>
                                            <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5 truncate">{asset.type}</p>
                                          </div>
                                          {user?.role !== 'accounts' && (
                                            <button
                                              onClick={() => triggerAssetConferenceAction(asset, 'unassign')}
                                              className="w-10 h-10 bg-white border border-slate-100 rounded-xl text-slate-400 hover:text-red-500 hover:border-red-500/50 transition-all flex items-center justify-center"
                                              title="Hard Remove (Accidental Scan)"
                                            >
                                              <i aria-hidden="true" className="fa-solid fa-trash-can text-xs"></i>
                                            </button>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )
                              )}
                            </div>
                          ) : (() => {
                            const currentConferenceId = editingConference?.id;
                            const bookedInOtherConferences = new Set<string>(
                              backendConferences
                                .filter(c => String(c.id) !== String(currentConferenceId))
                                .flatMap(c => [
                                  ...((c as any).assets || []).map(String),
                                  ...((c.crosscheckAssets || []).map(String))
                                ])
                            );
                            const selectedIds = new Set(conferenceFormData.assets.map((id: any) => String(id)));
                            const crosscheckIds = new Set((conferenceFormData.crosscheck_assets || []).map((id: any) => String(id)));
                            const q = quickAddInput.toLowerCase();
                            const qNorm = normalizeSearch(q);

                            // Use allAssetsRef (full DB) so search shows all assets, not just current 50
                            const searchPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                            const availableFiltered = searchPool.filter(a => {
                              const matchesSearch = !q || 
                                normalizeSearch(a.sku || '').includes(qNorm) || 
                                normalizeSearch(a.aliasName || '').includes(qNorm) || 
                                normalizeSearch(a.serialNumber || '').includes(qNorm) || 
                                normalizeSearch(a.type || '').includes(qNorm);
                              const hasBulkBalance = isBulkStock(a) && quantityLimit(a, conferenceFormData, 'stage') > 0;
                              const notInCurrentConf = hasBulkBalance || (!selectedIds.has(String(a.id)) && !crosscheckIds.has(String(a.id)));
                              const notInOtherConf = hasBulkBalance || !bookedInOtherConferences.has(String(a.id));
                              const notDamaged = a.status !== AssetStatus.DAMAGED;
                              return matchesSearch && notInCurrentConf && notInOtherConf && notDamaged;
                            });

                            if (availableFiltered.length === 0) {
                              return (
                                <div className="col-span-2 py-20 text-center space-y-4">
                                  <div className="text-slate-200 text-6xl"><i aria-hidden="true" className="fa-solid fa-layer-group"></i></div>
                                  <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">No matching assets found</p>
                                </div>
                              );
                            }

                            return availableFiltered.map(asset => (
                              <div
                                key={asset.id}
                                onClick={() => triggerAssetConferenceAction(asset, 'add')}
                                className="p-5 rounded-[1.5rem] border border-slate-100 bg-white hover:border-sky-500/50 hover:bg-sky-50/30 cursor-pointer transition-all group flex items-center gap-4 shadow-sm"
                              >
                                <div className="w-12 h-12 bg-sky-50/80 rounded-2xl flex items-center justify-center text-sky-500 border border-sky-100 group-hover:scale-110 transition-transform">
                                  <i aria-hidden="true" className="fa-solid fa-box-open"></i>
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="font-black uppercase text-xs text-slate-800 group-hover:text-sky-600 transition truncate">{asset.aliasName || asset.sku}</p>
                                  <p className="text-[9px] text-slate-400 font-bold uppercase mt-1 truncate">{asset.type} • {asset.serialNumber || 'No SN'}</p>
                                </div>
                                <i aria-hidden="true" className="fa-solid fa-circle-plus text-slate-200 group-hover:text-sky-500 transition-colors"></i>
                              </div>
                            ))
                          })()}
                        </div>
                      )}

                      {assetTab === 'assigned' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {user?.role === 'technician' ? (
                            <div className="col-span-2 space-y-12">
                               {/* 1. Technician Search/Scan Bar (Inline - Matching Godown) */}
                               <div className="space-y-4 text-left">
                                 <div className="relative group">
                                   <div className="absolute left-4 md:left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors pointer-events-none">
                                     <i aria-hidden="true" className="fa-solid fa-magnifying-glass"></i>
                                   </div>
                                   <input 
                                     type="text"
                                     placeholder="Search or scan requirement..."
                                     value={quickAddInput}
                                     onChange={(e) => setQuickAddInput(e.target.value)}
                                     onKeyDown={(e) => {
                                       if (e.key === 'Enter') {
                                         const val = (e.target as HTMLInputElement).value.trim();
                                         if (val) {
                                            handleScan(val, true); 
                                            setQuickAddInput('');
                                         }
                                       }
                                     }}
                                     className="w-full bg-sky-50 border-none rounded-2xl pl-11 md:pl-14 pr-16 md:pr-20 py-4 md:py-6 text-xs md:text-sm font-black text-slate-800 focus:ring-4 focus:ring-sky-500/10 transition-all placeholder:text-slate-400 placeholder:font-bold shadow-sm"
                                   />
                                   <button
                                     type="button"
                                     onClick={() => setShowScanner(true)}
                                     className="absolute right-3 md:right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-sky-500 hover:bg-sky-400 text-white rounded-xl shadow-lg shadow-sky-500/30 flex items-center justify-center transition-transform active:scale-90"
                                     title="Scan with Camera"
                                   >
                                     <i aria-hidden="true" className="fa-solid fa-camera text-sm"></i>
                                   </button>
                                 </div>
                                 
                                 {quickAddInput && (
                                   <div className="space-y-4">
                                     <div className="flex items-center justify-between px-1">
                                       <h4 className="text-[10px] font-black text-sky-500 uppercase tracking-widest">Available to Add</h4>
                                       <button onClick={() => setQuickAddInput('')} className="text-[10px] font-black text-slate-400 hover:text-red-500 transition-colors uppercase tracking-widest">Clear Search</button>
                                     </div>
                                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                         {(() => {
                                           const q = quickAddInput.toLowerCase();
                                           const qNorm = normalizeSearch(q);
                                           const currentConferenceId = editingConference?.id;
                                           const bookedInOtherConferences = new Set<string>(
                                             backendConferences
                                               .filter(c => String(c.id) !== String(currentConferenceId))
                                               .flatMap(c => [
                                                 ...((c as any).assets || []).map(String),
                                                 ...((c.crosscheckAssets || []).map(String))
                                               ])
                                           );
                                           const filtered = assets.filter(a => {
                                             const matchesSearch = !q || 
                                               (a.sku && a.sku.toLowerCase() === q) ||
                                               (a.serialNumber && a.serialNumber.toLowerCase() === q) ||
                                               normalizeSearch(a.sku || '').includes(qNorm) || 
                                               normalizeSearch(a.aliasName || '').includes(qNorm) || 
                                               normalizeSearch(a.name || '').includes(qNorm) || 
                                               normalizeSearch(a.description || '').includes(qNorm) || 
                                               normalizeSearch(a.serialNumber || '').includes(qNorm) || 
                                               (a.qrCode && normalizeSearch(a.qrCode) !== '' && (normalizeSearch(a.qrCode).includes(qNorm) || qNorm.includes(normalizeSearch(a.qrCode)))) ||
                                               normalizeSearch(a.barcode || '').includes(qNorm) || 
                                               normalizeSearch(a.type || '').includes(qNorm);
                                             const notInReqs = !(conferenceFormData.requirements || []).some((id: any) => String(id) === String(a.id));
                                             const notInCurrent = !conferenceFormData.assets.some((id: any) => String(id) === String(a.id));
                                             const notInOtherConf = !bookedInOtherConferences.has(String(a.id));
                                             const notDamaged = a.status !== AssetStatus.DAMAGED;
                                             return matchesSearch && notInReqs && notInCurrent && notInOtherConf && notDamaged;
                                           });
                                           if (filtered.length === 0) return <div className="col-span-2 text-center text-xs font-bold text-slate-400 py-6">No matching assets to add as requirement</div>;
                                           return filtered.slice(0, 8).map(asset => (
                                             <div 
                                               key={asset.id} 
                                               onClick={() => {
                                                 triggerAssetConferenceAction(asset, 'add');
                                                 setQuickAddInput('');
                                               }}
                                               className="p-4 rounded-2xl border border-slate-100 bg-white hover:bg-sky-50/50 cursor-pointer transition-all flex items-center gap-3 border-l-4 border-l-sky-500 group shadow-sm"
                                             >
                                               <div className="min-w-0 flex-1">
                                                 <p className="font-black uppercase text-[10px] text-slate-800 truncate">{asset.aliasName || asset.sku}</p>
                                                 <p className="text-[8px] text-slate-400 font-bold uppercase truncate">{asset.type}</p>
                                               </div>
                                               <i aria-hidden="true" className="fa-solid fa-plus-circle text-sky-500 group-hover:scale-110 transition-transform"></i>
                                             </div>
                                           ));
                                         })()}
                                     </div>
                                   </div>
                                 )}
                               </div>

                               {/* 2. Current Requirements List */}
                               <div className="space-y-4">
                                 <div className="flex items-center justify-between px-1">
                                   <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                     {quickAddInput ? 'Search in Requirements' : 'Requirements List'}
                                   </h4>
                                   {conferenceFormData.requirements.length > 0 && (
                                     <span className="text-[10px] font-black text-sky-500 bg-sky-50 px-2 py-0.5 rounded-full">
                                       {conferenceFormData.requirements.length} ITEMS
                                     </span>
                                   )}
                                 </div>

                                 {conferenceFormData.requirements.length === 0 ? (
                                   <div className="p-12 text-center bg-slate-50/50 rounded-3xl border border-dashed border-slate-200">
                                     <div className="text-slate-200 text-4xl mb-4"><i aria-hidden="true" className="fa-solid fa-clipboard-list"></i></div>
                                     <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">No requirements added yet</p>
                                   </div>
                                 ) : (() => {
                                     const q = quickAddInput.toLowerCase();
                                     const qNorm = normalizeSearch(q);
                                     const fullReqsList = conferenceFormData.requirements
                                       .map((id: any) => (allAssetsRef.current.length > 0 ? allAssetsRef.current : assets).find(a => String(a.id) === String(id)))
                                       .filter(Boolean) as Asset[];

                                     const filteredReqs = fullReqsList.filter(a => {
                                       if (!q) return true;
                                       return (a.sku && a.sku.toLowerCase().includes(q)) || 
                                              (a.aliasName && a.aliasName.toLowerCase().includes(q)) ||
                                              (a.serialNumber && a.serialNumber.toLowerCase().includes(q)) ||
                                              normalizeSearch(a.sku || '').includes(qNorm) ||
                                              normalizeSearch(a.aliasName || '').includes(qNorm);
                                     });
                                     if (quickAddInput && filteredReqs.length === 0) {
                                       return (
                                         <div className="p-8 text-center text-xs font-bold text-slate-400">
                                           No matching requirements found.
                                         </div>
                                       );
                                     }
                                     // F-3: Cart view — group by display alias (MacBook/Windows Laptop for laptops)
                                      const groups = filteredReqs.reduce((acc: Record<string, Asset[]>, a) => {
                                        const key = getLaptopSubGroup(a) ?? a.aliasName ?? a.sku ?? 'Unknown';
                                        if (!acc[key]) acc[key] = [];
                                        acc[key].push(a);
                                        return acc;
                                      }, {} as Record<string, Asset[]>);
                                      return (
                                        <div className="space-y-2">
                                          {Object.entries(groups).map(([name, items]: [string, Asset[]]) => {
                                            const gKey = `req-${name}`;
                                            const isOpen = !!expandedGroups[gKey];
                                            return (
                                              <div key={gKey} className="rounded-2xl border border-sky-100 bg-sky-50/10 overflow-hidden shadow-sm">
                                                <button onClick={() => toggleGroup(gKey)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-sky-50/20 transition-all">
                                                  <div className="w-8 h-8 bg-sky-100 text-sky-600 rounded-xl flex items-center justify-center text-sm border border-sky-200 shrink-0">
                                                    <i aria-hidden="true" className="fa-solid fa-list-check"></i>
                                                  </div>
                                                  <span className="truncate flex-1 min-w-0 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                                  <div className="shrink-0 flex items-center bg-gray-200 rounded-full text-[10px] font-black overflow-hidden mr-2">
                                                    <button 
                                                      onClick={(e) => { e.stopPropagation(); triggerAssetConferenceAction(items[0], 'unassign'); }} 
                                                      className="px-2.5 py-1 hover:bg-gray-300 hover:text-red-600 transition-colors"
                                                    >
                                                      <i aria-hidden="true" className="fa-solid fa-minus"></i>
                                                    </button>
                                                    <span className="text-gray-900 font-bold px-3 min-w-[2rem] text-center">{items.length}</span>
                                                    <button 
                                                      onClick={(e) => { 
                                                        e.stopPropagation();
                                                        const targetName = name;
                                                        const gPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                                                        const availableAsset = gPool.find(a => 
                                                          (getLaptopSubGroup(a) ?? a.aliasName ?? a.sku ?? 'Unknown') === targetName && 
                                                          !conferenceFormData.requirements.some((id: any) => String(id) === String(a.id)) &&
                                                          !conferenceFormData.assets.some((id: any) => String(id) === String(a.id)) &&
                                                          a.status !== AssetStatus.DAMAGED
                                                        );
                                                        if (availableAsset) {
                                                          triggerAssetConferenceAction(availableAsset, 'add');
                                                        } else {
                                                          alert("No more available items of this type in stock.");
                                                        }
                                                      }} 
                                                      className="px-2.5 py-1 hover:bg-gray-300 hover:text-green-600 transition-colors"
                                                    >
                                                      <i aria-hidden="true" className="fa-solid fa-plus"></i>
                                                    </button>
                                                  </div>
                                                  <i aria-hidden="true" className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                                </button>
                                                {isOpen && (
                                                  <div className="border-t border-sky-100 divide-y divide-sky-50">
                                                    {items.map(asset => (
                                                      <div key={asset.id} className="flex items-center gap-3 px-4 py-2.5">
                                                        <span className="font-mono text-[10px] text-slate-700 font-bold truncate flex-1">
                                                          {asset.aliasName && !['Apple MacBook', 'Windows Laptop', 'MacBook'].includes(asset.aliasName)
                                                            ? `${asset.aliasName} • ${asset.sku || asset.serialNumber}`
                                                            : (asset.sku || asset.serialNumber)}
                                                        </span>
                                                        <button onClick={() => triggerAssetConferenceAction(asset, 'unassign')} className="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 transition-all flex items-center justify-center shrink-0" title="Remove">
                                                          <i aria-hidden="true" className="fa-solid fa-trash-can text-[9px]"></i>
                                                        </button>
                                                      </div>
                                                    ))}
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                 })()}
                               </div>
                            </div>
                          ) : user?.role === 'godown_incharge' ? (
<div className="col-span-2 space-y-12">
                                {/* 1. Pending Requirements (From Tech) */}
                                <div className="space-y-4">
                                  <div className="flex items-center justify-between px-1">
                                    <h4 className="text-[10px] font-black text-orange-500 uppercase tracking-widest">Pending from Technician</h4>
                                    <span className="text-[10px] font-black text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full">{(conferenceFormData.requirements || []).length} PENDING</span>
                                  </div>
                                  {(conferenceFormData.requirements || []).length === 0 ? (
                                    <div className="p-8 text-center bg-slate-50/50 rounded-3xl border border-dashed border-slate-200">
                                      <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">No pending requirements</p>
                                    </div>
                                   ) : (() => {
                                     const isAssignedSet = new Set([
                                       ...(conferenceFormData.assets || []).map(String),
                                       ...(conferenceFormData.staged_assets || []).map(String)
                                     ]);
                                     const pendingAssets = (conferenceFormData.requirements || [])
                                       .filter((id: any) => !isAssignedSet.has(String(id)))
                                       .map((id: any) => (allAssetsRef.current.length > 0 ? allAssetsRef.current : assets).find(a => String(a.id) === String(id)))
                                       .filter(Boolean) as Asset[];
                                     const groups = pendingAssets.reduce((acc: Record<string, Asset[]>, a) => {
                                       // Group laptops under MacBook / Windows Laptop; all others by raw alias
                                       const key = getLaptopSubGroup(a) ?? a.aliasName ?? a.sku ?? 'Unknown';
                                       if (!acc[key]) acc[key] = [];
                                       acc[key].push(a);
                                       return acc;
                                     }, {} as Record<string, Asset[]>);
                                     return (
                                       <div className="space-y-2">
                                         {Object.entries(groups).map(([name, items]: [string, Asset[]]) => {
                                           const gKey = `godown-req-${name}`;
                                           const isOpen = !!expandedGroups[gKey];
                                           return (
                                             <div key={gKey} className="rounded-2xl border border-orange-100 bg-orange-50/10 overflow-hidden">
                                               <button onClick={() => toggleGroup(gKey)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-orange-50/20 transition-all">
                                                 <div className="w-8 h-8 bg-orange-100 text-orange-600 rounded-xl flex items-center justify-center text-sm border border-orange-200 shrink-0">
                                                   <i aria-hidden="true" className="fa-solid fa-hourglass-start"></i>
                                                 </div>
                                                 <span className="truncate flex-1 min-w-0 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                                 <span className="shrink-0 px-2 py-0.5 bg-orange-500 text-white text-[9px] font-black rounded-full">x {items.length}</span>
                                                 <i aria-hidden="true" className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                               </button>
                                               {isOpen && (
                                                 <div className="border-t border-orange-100 divide-y divide-orange-50">
                                                   {items.map(asset => (
                                                     <div key={asset.id} className="flex items-center gap-3 px-4 py-2.5">
                                                        <span className="font-mono text-[10px] text-slate-700 font-bold truncate flex-1">
                                                          {asset.aliasName && !['Apple MacBook', 'Windows Laptop', 'MacBook'].includes(asset.aliasName)
                                                            ? `${asset.aliasName} • ${asset.sku || asset.serialNumber}`
                                                            : (asset.sku || asset.serialNumber)}
                                                        </span>
                                                        <span className="shrink-0 px-1.5 py-0.5 bg-orange-400 text-white text-[8px] font-black rounded-full">PENDING</span>
                                                     </div>
                                                   ))}
                                                 </div>
                                               )}
                                             </div>
                                           );
                                         })}
                                       </div>
                                     );
                                   })()}
                                </div>

                                 {/* Multi-Truck Target Selector for Godown Packing Station */}
                                 {(() => {
                                   const activeConfTrucks = (editingConference?.truckChallans && editingConference.truckChallans.length > 0)
                                     ? editingConference.truckChallans
                                     : (backendConferences.find(c => c.id === conferenceFormData.id)?.truckChallans || []);
                                   const effectiveTargetTruck = (activeConfTrucks.find(t => t.id === packingTargetTruckId))
                                     || (activeConfTrucks.length > 0 ? activeConfTrucks[activeConfTrucks.length - 1] : null);

                                   if (!effectiveTargetTruck || activeConfTrucks.length === 0) return null;

                                   return (
                                     <div className="flex items-center justify-between p-4 bg-sky-950/40 border border-sky-500/30 rounded-2xl flex-wrap gap-3 mb-6 shadow-lg">
                                       <div className="flex items-center gap-2.5">
                                         <div className="w-8 h-8 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center font-bold">
                                           <i aria-hidden="true" className="fa-solid fa-truck-ramp-box"></i>
                                         </div>
                                         <div>
                                           <p className="text-[11px] font-black text-sky-400 uppercase tracking-wider">
                                             Packing Target: {effectiveTargetTruck.label || `Truck ${effectiveTargetTruck.truck_number}`}
                                           </p>
                                           <p className="text-[9px] text-slate-400">Scanned items will be packed into this truck challan</p>
                                         </div>
                                       </div>
                                       <div className="flex items-center gap-1.5 flex-wrap">
                                         {activeConfTrucks.map(t => {
                                           const isSelected = effectiveTargetTruck.id === t.id;
                                           const isLatest = t.truck_number === activeConfTrucks[activeConfTrucks.length - 1].truck_number;
                                           return (
                                             <button
                                               key={t.id}
                                               type="button"
                                               onClick={() => setPackingTargetTruckId(t.id)}
                                               className={`px-3.5 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-1.5 ${
                                                 isSelected
                                                   ? 'bg-sky-500 text-white shadow-md shadow-sky-500/30 ring-2 ring-sky-400'
                                                   : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                                               }`}
                                             >
                                               <span>{t.label || `Truck ${t.truck_number}`}</span>
                                               {isLatest && (
                                                 <span className="text-[9px] text-emerald-300 font-bold">(Active)</span>
                                               )}
                                               <span className="text-[10px] opacity-80 font-mono">({(t.assets || []).length})</span>
                                             </button>
                                           );
                                         })}
                                       </div>
                                     </div>
                                   );
                                 })()}

                                {/* 2. Godown Search/Scan Bar */}
                                <div className="space-y-4">
                                  <div className="flex gap-3">
                                    <div className="relative group flex-1">
                                      <div className="absolute left-4 md:left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors pointer-events-none">
                                        <i aria-hidden="true" className="fa-solid fa-magnifying-glass"></i>
                                      </div>
                                      <input 
                                        type="text"
                                        placeholder="Search or scan requirement..."
                                        value={quickAddInput}
                                        onChange={(e) => setQuickAddInput(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            const val = (e.target as HTMLInputElement).value.trim();
                                            if (val) {
                                               handleScan(val, true); 
                                               setQuickAddInput('');
                                            }
                                          }
                                        }}
                                        className="w-full bg-sky-50 border-none rounded-2xl pl-11 md:pl-14 pr-16 md:pr-20 py-4 md:py-6 text-xs md:text-sm font-black text-slate-800 focus:ring-4 focus:ring-sky-500/10 transition-all placeholder:text-slate-400 placeholder:font-bold shadow-sm"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => setShowScanner(true)}
                                        className="absolute right-3 md:right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-sky-500 hover:bg-sky-400 text-white rounded-xl shadow-lg shadow-sky-500/30 flex items-center justify-center transition-transform active:scale-90"
                                        title="Scan with Camera"
                                      >
                                        <i aria-hidden="true" className="fa-solid fa-camera text-sm"></i>
                                      </button>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setConsumablesPickerSearchQuery('');
                                        setShowConsumablesPicker(true);
                                      }}
                                      className="shrink-0 px-6 py-4 bg-amber-500 hover:bg-amber-600 text-white rounded-2xl font-black text-xs uppercase tracking-wider transition-all shadow-md shadow-amber-500/20 flex items-center gap-2"
                                    >
                                      <i aria-hidden="true" className="fa-solid fa-cubes text-base"></i> + Consumables
                                    </button>
                                  </div>
                                  {quickAddInput && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                                      {(() => {
                                         const q = quickAddInput.toLowerCase();
                                         const gPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                                         const avail = gPool.filter(a => {
                                           const matches = !q || 
                                             (a.sku && a.sku.toLowerCase() === q) ||
                                             (a.serialNumber && a.serialNumber.toLowerCase() === q) ||
                                             (a.sku && a.sku.toLowerCase().includes(q)) || 
                                             (a.aliasName && a.aliasName.toLowerCase().includes(q));
                                           const notUsed = (isBulkStock(a) && quantityLimit(a, conferenceFormData, 'stage') > 0) || (!new Set((conferenceFormData.assets || []).map(String)).has(String(a.id)) && !new Set((conferenceFormData.staged_assets || []).map(String)).has(String(a.id)));
                                           return matches && notUsed && a.status !== AssetStatus.DAMAGED;
                                         });
                                         if (avail.length === 0) return <div className="col-span-2 text-center text-xs font-bold text-slate-400">No matches found.</div>;
                                         return avail.slice(0, 6).map(asset => (
                                           <div 
                                             key={asset.id} 
                                             onClick={() => {
                                                triggerAssetConferenceAction(asset, 'add');
                                                setQuickAddInput('');
                                             }}
                                             className="p-4 rounded-2xl border border-slate-100 bg-white hover:bg-sky-50/50 cursor-pointer transition-all flex items-center gap-3 border-l-4 border-l-sky-500"
                                           >
                                             <div className="min-w-0 flex-1">
                                               <p className="font-black uppercase text-[10px] text-slate-800 truncate">{asset.aliasName || asset.sku}</p>
                                               <p className="text-[8px] text-slate-400 font-bold uppercase">{asset.type}</p>
                                             </div>
                                             <i aria-hidden="true" className="fa-solid fa-plus-circle text-sky-500"></i>
                                           </div>
                                         ));
                                      })()}
                                    </div>
                                  )}
                                </div>

                                {/* 3. Staged / Assigned Items */}
                                <div className="col-span-2 space-y-6">
                                  <div className="flex items-center justify-between px-1 border-t border-slate-200 pt-8">
                                    <div className="flex items-center gap-3">
                                      <h4 className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">Staged / Packed Items</h4>
                                      {(() => {
                                        // Semantic dispatch lock: true once Finalize Dispatch has been clicked
                                        // (staged_assets cleared, items moved to assets, challan saved)
                                        const isDispatched = (conferenceFormData.assets || []).length > 0 &&
                                          (conferenceFormData.staged_assets || []).length === 0 &&
                                          (conferenceFormData.challanAssets || []).length > 0;
                                        return isDispatched ? (
                                          <span className="text-[9px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-full uppercase tracking-wider">
                                            <i aria-hidden="true" className="fa-solid fa-lock mr-1"></i>Dispatched — Read Only
                                          </span>
                                        ) : null;
                                      })()}
                                    </div>
                                    <span className="text-[10px] font-black text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full">{eventQuantityTotal(conferenceFormData, [...(conferenceFormData.assets || []), ...(conferenceFormData.staged_assets || [])], 'requirements')} READY</span>
                                  </div>
                                  
                                   {/* F-3: Cart view for godown staged/assigned items */}
                                   <div className="space-y-2">
                                     {(() => {
                                       const requirementIds = new Set((conferenceFormData.requirements || []).map(String));
                                       // Semantic dispatch lock — no dates, purely state-driven
                                       const isConferenceEnded = (conferenceFormData.assets || []).length > 0 &&
                                          (conferenceFormData.staged_assets || []).length === 0 &&
                                          (conferenceFormData.challanAssets || []).length > 0;
                                       const gPool2 = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                                       const packedList = gPool2.filter(a => new Set((conferenceFormData.assets || []).map(String)).has(String(a.id)));
                                       const stagedList = gPool2.filter(a => new Set((conferenceFormData.staged_assets || []).map(String)).has(String(a.id)));
                                       const allItems = [
                                         ...packedList.map(a => ({ asset: a, type: requirementIds.has(String(a.id)) ? 'fulfilled' : 'extra' })),
                                         ...stagedList.map(a => ({ asset: a, type: 'staged' }))
                                       ];
                                       const groups = allItems.reduce((acc: Record<string, {asset: Asset, type: string}[]>, item) => {
                                         const key = getLaptopSubGroup(item.asset) ?? item.asset.aliasName ?? item.asset.sku ?? 'Unknown';
                                         if (!acc[key]) acc[key] = [];
                                         acc[key].push(item);
                                         return acc;
                                       }, {} as Record<string, {asset: Asset, type: string}[]>);
                                       return Object.entries(groups).map(([name, items]: [string, {asset: Asset, type: string}[]]) => {
                                         const gKey = `godown-staged-${name}`;
                                         const isOpen = !!expandedGroups[gKey];
                                         const dominantType = items[0]?.type;
                                         const colors = dominantType === 'extra' ? { border: 'border-amber-200', bg: 'bg-amber-50/10', iconBg: 'bg-amber-100 text-amber-600 border-amber-200', badge: 'bg-amber-500', icon: 'fa-layer-group' }
                                           : dominantType === 'staged' ? { border: 'border-sky-200', bg: 'bg-sky-50/20', iconBg: 'bg-sky-100 text-sky-600 border-sky-300', badge: 'bg-sky-500', icon: 'fa-box' }
                                           : { border: 'border-emerald-100', bg: 'bg-emerald-50/10', iconBg: 'bg-emerald-100 text-emerald-600 border-emerald-200', badge: 'bg-emerald-500', icon: 'fa-check-double' };
                                         return (
                                           <div key={gKey} className={`rounded-2xl border ${colors.border} ${colors.bg} overflow-hidden shadow-sm`}>
                                             <button onClick={() => toggleGroup(gKey)} className="w-full flex items-center gap-3 px-4 py-3 hover:brightness-105 transition-all">
                                               <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm border shrink-0 ${colors.iconBg}`}>
                                                 <i aria-hidden="true" className={`fa-solid ${colors.icon}`}></i>
                                               </div>
                                               <span className="truncate flex-1 min-w-0 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                               <span className={`shrink-0 px-2 py-0.5 ${colors.badge} text-white text-[9px] font-black rounded-full`}>x {eventQuantityTotal(conferenceFormData, items.map(i => i.asset.id), 'requirements')}</span>
                                               <i aria-hidden="true" className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                             </button>
                                             {isOpen && (
                                               <div className={`border-t ${colors.border} divide-y divide-slate-100/50`}>
                                                 {items.map(({ asset, type }) => (
                                                   <div key={`${type}-${asset.id}`} className="flex items-center gap-3 px-4 py-2.5">
                                                     <span className="font-mono text-[10px] text-slate-700 font-bold truncate flex-1">
                                             {asset.aliasName && !['Apple MacBook', 'Windows Laptop', 'MacBook'].includes(asset.aliasName)
                                               ? `${asset.aliasName} • ${asset.sku || asset.serialNumber}`
                                               : (asset.sku || asset.serialNumber)}
                                           </span>
                                                     <span className={`shrink-0 px-1.5 py-0.5 text-white text-[8px] font-black rounded-full ${colors.badge}`}>
                                                       {type === 'staged' ? 'STAGED' : type === 'extra' ? 'EXTRA' : 'PACKED'}
                                                     </span>
                                                     {quantityLabel(conferenceFormData, asset.id) && <span className="text-[10px] font-bold text-slate-600">{quantityLabel(conferenceFormData, asset.id)}</span>}
                                                     {!isConferenceEnded && (
                                                       <button onClick={() => triggerAssetConferenceAction(asset, 'unassign')} className="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 transition-all flex items-center justify-center shrink-0" title="Remove">
                                                         <i aria-hidden="true" className="fa-solid fa-xmark text-[9px]"></i>
                                                       </button>
                                                     )}
                                                   </div>
                                                 ))}
                                               </div>
                                             )}
                                           </div>
                                         );
                                       });
                                     })()}
                                   </div>



                                </div>
                             </div>
                          ) : (
                            // Admin Role View: Show BOTH Pending Requirements and Extra Scans
                            (() => {
                              const requirementIds = new Set((conferenceFormData.requirements || []).map(String));
                              const assignedIds = new Set((conferenceFormData.assets || []).map(String));
                              const stagedIds = new Set((conferenceFormData.staged_assets || []).map(String));

                              if (requirementIds.size === 0 && assignedIds.size === 0 && stagedIds.size === 0) {
                                return (
                                  <div className="col-span-2 py-20 text-center space-y-4">
                                    <div className="text-slate-200 text-6xl"><i aria-hidden="true" className="fa-solid fa-clipboard-list"></i></div>
                                    <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">No requirements or assignments</p>
                                  </div>
                                );
                              }

                              return (
                                <>
                                  {/* F-3: Cart view — Admin: Staged + Pending + Assigned grouped by alias */}
                                  {(() => {
                                    const aPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                                    const stagedList = aPool.filter(a => stagedIds.has(String(a.id)));
                                    const pendingList = aPool.filter(a => requirementIds.has(String(a.id)) && !assignedIds.has(String(a.id)));
                                    const assignedList = aPool.filter(a => assignedIds.has(String(a.id)));
                                    type CartEntry = { asset: Asset; type: 'staged' | 'pending' | 'extra' | 'assigned' };
                                    const allItems: CartEntry[] = [
                                      ...stagedList.map(a => ({ asset: a, type: 'staged' as const })),
                                      ...pendingList.map(a => ({ asset: a, type: 'pending' as const })),
                                      ...assignedList.map(a => ({ asset: a, type: requirementIds.has(String(a.id)) ? 'assigned' as const : 'extra' as const }))
                                    ];
                                    const groups = allItems.reduce((acc: Record<string, CartEntry[]>, item) => {
                                      const key = item.asset.aliasName || item.asset.sku || 'Unknown';
                                      if (!acc[key]) acc[key] = [];
                                      acc[key].push(item);
                                      return acc;
                                    }, {} as Record<string, CartEntry[]>);
                                    return (
                                      <>
                                        {Object.entries(groups).map(([name, items]: [string, CartEntry[]]) => {
                                          const gKey = `admin-cart-${name}`;
                                          const isOpen = !!expandedGroups[gKey];
                                          const hasExtra = items.some(i => i.type === 'extra');
                                          const hasStaged = items.some(i => i.type === 'staged');
                                          const colors = hasExtra ? { border: 'border-amber-200', bg: 'bg-amber-50/10', iconBg: 'bg-amber-100 text-amber-600 border-amber-200', badge: 'bg-amber-500', icon: 'fa-triangle-exclamation' }
                                            : hasStaged ? { border: 'border-sky-200', bg: 'bg-sky-50/10', iconBg: 'bg-sky-100 text-sky-600 border-sky-200', badge: 'bg-sky-500', icon: 'fa-box' }
                                            : { border: 'border-emerald-100', bg: 'bg-emerald-50/10', iconBg: 'bg-emerald-100 text-emerald-600 border-emerald-200', badge: 'bg-emerald-500', icon: 'fa-check-double' };
                                          return (
                                            <div key={gKey} className={`rounded-2xl border ${colors.border} ${colors.bg} overflow-hidden shadow-sm`}>
                                              <button onClick={() => toggleGroup(gKey)} className="w-full flex items-center gap-3 px-4 py-3 hover:brightness-105 transition-all">
                                                <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm border shrink-0 ${colors.iconBg}`}>
                                                  <i aria-hidden="true" className={`fa-solid ${colors.icon}`}></i>
                                                </div>
                                                <span className="truncate flex-1 min-w-0 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                                <span className={`shrink-0 px-2 py-0.5 ${colors.badge} text-white text-[9px] font-black rounded-full`}>x {eventQuantityTotal(conferenceFormData, items.map(i => i.asset.id), 'requirements')}</span>
                                                <i aria-hidden="true" className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                              </button>
                                              {isOpen && (
                                                <div className={`border-t ${colors.border} divide-y divide-slate-100/50`}>
                                                  {items.map(({ asset, type }) => (
                                                    <div key={`${type}-${asset.id}`} className="flex items-center gap-3 px-4 py-2.5">
                                                      <span className="font-mono text-[10px] text-slate-700 font-bold truncate flex-1">
                                                        {asset.aliasName && !['Apple MacBook', 'Windows Laptop', 'MacBook'].includes(asset.aliasName)
                                                          ? `${asset.aliasName} • ${asset.sku || asset.serialNumber}`
                                                          : (asset.sku || asset.serialNumber)}
                                                      </span>
                                                      <span className={`shrink-0 px-1.5 py-0.5 text-white text-[8px] font-black rounded-full ${colors.badge}`}>
                                                        {type === 'staged' ? 'STAGED' : type === 'extra' ? 'EXTRA' : type === 'pending' ? 'PENDING' : 'ASSIGNED'}
                                                      </span>
                                                      {quantityLabel(conferenceFormData, asset.id) && <span className="text-[10px] font-bold text-slate-600">{quantityLabel(conferenceFormData, asset.id)}</span>}
                                                      {(type === 'extra' || type === 'assigned' || type === 'staged') && (
                                                        <button onClick={() => triggerAssetConferenceAction(asset, 'unassign')} className="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 transition-all flex items-center justify-center shrink-0" title="Remove">
                                                          <i aria-hidden="true" className="fa-solid fa-trash-can text-[9px]"></i>
                                                        </button>
                                                      )}
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </>
                                    );
                                  })()}
                                </>
                              );
                            })()
                          )}
                        </div>
                      )}

                                  {assetTab === 'assigned' && ['admin', 'boss', 'godown_incharge'].includes(user?.role || '') && (conferenceFormData.staged_assets || []).length > 0 && (
                                    <div className="pt-8 border-t border-slate-200 mt-4">
                                      <button 
                                        onClick={() => { void submitStagedDispatch(); }}
                                        disabled={quantitySaving || pendingMovementCount > 0}
                                        className="w-full py-6 bg-emerald-600 text-white rounded-3xl font-black uppercase text-sm tracking-[0.2em] shadow-xl shadow-emerald-500/20 hover:bg-emerald-500 hover:-translate-y-1 active:scale-[0.98] transition-all flex items-center justify-center gap-3"
                                      >
                                        <i aria-hidden="true" className="fa-solid fa-paper-plane"></i> Submit Dispatch to Show
                                      </button>
                                      <p className="text-center text-[10px] text-slate-400 font-bold uppercase mt-4 tracking-widest italic animate-pulse">Finalize items to clear current packing station</p>
                                    </div>
                                  )}

                      {assetTab === 'assigned' && ['admin', 'boss', 'godown_incharge', 'technician'].includes(user?.role || '') && (
                                  <ConsumablePanel mode="requests" data={conferenceFormData.consumable_data || {}} ledger={conferenceFormData.consumable_ledger || {}}
                                    assets={allAssetsRef.current.length ? allAssetsRef.current : assets} warehouse={['admin', 'boss', 'godown_incharge'].includes(user?.role || '')}
                                    disabled={consumableSaving || pendingMovementCount > 0 || eventDraftConflict}
                                    onRequest={handleUpdateRequestedConsumable} onReturn={handleUpdateReturnedConsumable}
                                    onConfirm={(id, confirmed) => setConferenceFormData((prev: any) => ({ ...prev, consumable_data: { ...prev.consumable_data,
                                      [id]: { ...prev.consumable_data[id], return_confirmed: confirmed } } }))}
                                    onSave={() => { void handleSaveConsumables('save'); }} onDispatch={() => { void handleSaveConsumables('dispatch'); }} />
                      )}

                      {assetTab === 'packup' && (() => {
                        // J-46: Cart view for packup tab
                        const packPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                        const packupList = packPool.filter(a =>
                          new Set((conferenceFormData.assets || []).map(String)).has(String(a.id))
                        ).filter(a => {
                          const q = quickRemoveInput.toLowerCase();
                          const qNorm = normalizeSearch(q);
                          return !q ||
                            (a.sku && a.sku.toLowerCase() === q) ||
                            (a.serialNumber && a.serialNumber.toLowerCase() === q) ||
                            normalizeSearch(a.sku || '').includes(qNorm) ||
                            normalizeSearch(a.aliasName || '').includes(qNorm) ||
                            normalizeSearch(a.name || '').includes(qNorm) ||
                            normalizeSearch(a.description || '').includes(qNorm) ||
                            normalizeSearch(a.serialNumber || '').includes(qNorm) ||
                            normalizeSearch(a.barcode || '').includes(qNorm) ||
                            normalizeSearch(a.type || '').includes(qNorm);
                        });

                        // ── Transfer Assets header (admin/godown_incharge only) ──
                        const canTransfer = user?.is_staff || user?.role === 'admin' || user?.role === 'godown_incharge';
                        const transferLog: any[] = conferenceFormData.transfer_log || [];

                        return (
                          <div className="space-y-3">
                            {/* Transfer Button header */}
                            {canTransfer && packupList.length > 0 && (
                              <div className="flex items-center justify-between px-1 mb-1">
                                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                  {eventQuantityTotal(conferenceFormData, packupList.map(asset => asset.id), 'packup')} units on site
                                </p>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTransferSelectedIds(new Set());
                                    setTransferTargetConfId('');
                                    setTransferScanInput('');
                                    setShowTransferModal(true);
                                  }}
                                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-lg shadow-purple-500/20 active:scale-95"
                                >
                                  <i aria-hidden="true" className="fa-solid fa-arrow-right-arrow-left text-[10px]"></i>
                                  Transfer Assets
                                </button>
                              </div>
                            )}

                            {/* Transfer Log section — shows completed transfer events */}
                            {transferLog.length > 0 && (
                              <div className="rounded-2xl border border-purple-200 bg-purple-50/30 p-3 space-y-2">
                                <p className="text-[9px] font-black text-purple-600 uppercase tracking-widest flex items-center gap-2">
                                  <i aria-hidden="true" className="fa-solid fa-clock-rotate-left"></i> Transfer History ({transferLog.length})
                                </p>
                                {transferLog.map((entry: any, idx: number) => (
                                  <div key={idx} className={`flex items-start gap-2.5 p-2 rounded-xl text-[10px] border ${entry.direction === 'outgoing' ? 'bg-orange-50 border-orange-200' : 'bg-emerald-50 border-emerald-200'}`}>
                                    <i aria-hidden="true" className={`fa-solid mt-0.5 shrink-0 ${entry.direction === 'outgoing' ? 'fa-arrow-up-right-from-square text-orange-500' : 'fa-arrow-down-to-line text-emerald-500'}`}></i>
                                    <div className="min-w-0 flex-1">
                                      <p className="font-black text-slate-800">
                                        {entry.direction === 'outgoing'
                                          ? `→ ${entry.to_conference_name}`
                                          : `← ${entry.from_conference_name}`}
                                        <span className="ml-1.5 text-slate-400 font-normal">{entry.asset_names?.length || entry.transferred_asset_ids?.length || 0} items</span>
                                      </p>
                                      {entry.from_address && (
                                        <p className="text-slate-500 mt-0.5">From: {entry.from_address}</p>
                                      )}
                                      <p className="text-slate-400 mt-0.5">{new Date(entry.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })} • {entry.transferred_by}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Empty state */}
                            {packupList.length === 0 && (
                              <div className="py-20 text-center space-y-4">
                                <div className="text-slate-200 text-6xl"><i aria-hidden="true" className="fa-solid fa-truck-ramp-box"></i></div>
                                <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">No assets dispatched to site yet</p>
                              </div>
                            )}


                            {/* Grouped asset list */}
                            {packupList.length > 0 && (() => {
                              // J-119 Task 3: Normalize key (trim) so aliasName differences in casing/whitespace
                              // across batches always collapse into a single group.
                              // Laptops are grouped as MacBook or Windows Laptop by getLaptopSubGroup.
                              const groups = packupList.reduce((acc: Record<string, Asset[]>, a) => {
                                const key = (getLaptopSubGroup(a) ?? a.aliasName ?? a.sku ?? 'Unknown').trim();
                                if (!acc[key]) acc[key] = [];
                                acc[key].push(a);
                                return acc;
                              }, {} as Record<string, Asset[]>);

                              return (
                                <div className="space-y-2">
                                  {Object.entries(groups).map(([name, items]: [string, Asset[]]) => {
                                    const gKey = `packup-${name}`;
                                    const isOpen = !!expandedGroups[gKey];
                                    return (
                                      <div key={gKey} className="rounded-2xl border border-emerald-100 bg-emerald-50/10 overflow-hidden shadow-sm">
                                        <button onClick={() => toggleGroup(gKey)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-emerald-50/20 transition-all">
                                          <div className="w-8 h-8 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center text-sm border border-emerald-200 shrink-0">
                                            <i aria-hidden="true" className="fa-solid fa-check-double"></i>
                                          </div>
                                          <span className="truncate flex-1 min-w-0 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                          <span className="shrink-0 px-2 py-0.5 bg-emerald-500 text-white text-[9px] font-black rounded-full">x {eventQuantityTotal(conferenceFormData, items.map(i => i.id), 'packup')}</span>
                                          <i aria-hidden="true" className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                        </button>
                                        {isOpen && (
                                          <div className="border-t border-emerald-100 divide-y divide-emerald-50">
                                            {items.map(asset => (
                                              <div key={asset.id} className="relative flex items-center gap-2 px-4 py-2.5">
                                                <span className="font-mono text-[10px] text-slate-500 truncate flex-1">{asset.sku || asset.serialNumber}</span>
                                                <span className="shrink-0 px-2 py-0.5 bg-emerald-500 text-white text-[8px] font-black rounded-full">ON-SITE</span>
                                                {quantityLabel(conferenceFormData, asset.id) && <span className="text-[10px] font-bold text-slate-600">{quantityLabel(conferenceFormData, asset.id)}</span>}
                                                {user?.role === 'technician' && (
                                                  <div className="flex gap-1.5 shrink-0">
                                                    <button
                                                      onClick={() => setFlagMenuAssetId(flagMenuAssetId === asset.id ? null : asset.id)}
                                                      className={`w-7 h-7 border rounded-lg flex items-center justify-center transition-all ${
                                                        asset.status === 'Damaged' || asset.flag === 'Missing'
                                                          ? 'bg-red-500 border-red-400 text-white animate-pulse'
                                                          : 'bg-white border-slate-200 text-slate-400 hover:text-red-500'
                                                      }`}
                                                      title="Report Issue"
                                                    >
                                                      <i aria-hidden="true" className="fa-solid fa-circle-exclamation text-[9px]"></i>
                                                    </button>
                                                    <button
                                                      onClick={() => triggerAssetConferenceAction(asset, 'remove')}
                                                      className="w-7 h-7 bg-white border border-slate-200 text-slate-400 hover:text-orange-500 hover:border-orange-300 rounded-lg flex items-center justify-center transition-all"
                                                      title="Move to Crosscheck (Return)"
                                                    >
                                                      <i aria-hidden="true" className="fa-solid fa-arrow-right-from-bracket text-[9px]"></i>
                                                    </button>
                                                  </div>
                                                )}
                                                {/* J-119 Task 1: Admin Remove button — hard-removes asset from this conference */}
                                                {user?.is_staff && (
                                                  <button
                                                    onClick={() => triggerAssetConferenceAction(asset, 'unassign')}
                                                    className="w-7 h-7 bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 rounded-lg flex items-center justify-center transition-all shrink-0"
                                                    title="Admin: Remove from Packup"
                                                  >
                                                    <i aria-hidden="true" className="fa-solid fa-trash-can text-[9px]"></i>
                                                  </button>
                                                )}
                                                {/* Floating Issue Menu */}
                                                {flagMenuAssetId === asset.id && (
                                                  <div className="absolute top-0 right-12 z-[60] bg-white border border-slate-200 rounded-2xl shadow-2xl p-2 min-w-[160px] animate-in fade-in slide-in-from-right-2 duration-200">
                                                    <button
                                                      onClick={() => handleQuickUpdateAsset(asset, { flag: AssetFlag.MISSING }, conferenceFormData.id, 'Packup')}
                                                      className="w-full px-4 py-3 hover:bg-red-50 flex items-center gap-3 rounded-xl transition-colors text-left"
                                                    >
                                                      <i aria-hidden="true" className="fa-solid fa-flag text-red-500 text-xs"></i>
                                                      <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Missing</span>
                                                    </button>
                                                    <button
                                                      onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.DAMAGED, flag: AssetFlag.REQUIRED_SERVICE }, conferenceFormData.id, 'Packup')}
                                                      className="w-full px-4 py-3 hover:bg-orange-50 flex items-center gap-3 rounded-xl transition-colors text-left"
                                                    >
                                                      <i aria-hidden="true" className="fa-solid fa-tools text-orange-500 text-xs"></i>
                                                      <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Damaged</span>
                                                    </button>
                                                    <button
                                                      onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.AVAILABLE, flag: AssetFlag.NONE }, conferenceFormData.id, 'Packup')}
                                                      className="w-full px-4 py-3 hover:bg-slate-50 flex items-center gap-3 rounded-xl transition-colors text-left border-t border-slate-100"
                                                    >
                                                      <i aria-hidden="true" className="fa-solid fa-check text-emerald-500 text-xs"></i>
                                                      <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Clear / No Issue</span>
                                                    </button>
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </div>
                        );
                      })()}



                      {assetTab === 'crosscheck' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {(conferenceFormData.crosscheck_assets || []).length === 0 ? (
                            <div className="col-span-2 py-20 text-center space-y-4">
                              <div className="text-slate-200 text-6xl"><i aria-hidden="true" className="fa-solid fa-truck-loading"></i></div>
                              <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">No assets in crosscheck queue</p>
                            </div>
                          ) : (() => {
                             // F-3: Cart view for crosscheck tab
                             const crossPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                             const crosscheckList = crossPool.filter(a => new Set((conferenceFormData.crosscheck_assets || []).map(String)).has(String(a.id)));
                             const groups = crosscheckList.reduce((acc: Record<string, Asset[]>, a) => {
                               // Group laptops as MacBook / Windows Laptop
                               const key = getLaptopSubGroup(a) ?? a.aliasName ?? a.sku ?? 'Unknown';
                               if (!acc[key]) acc[key] = [];
                               acc[key].push(a);
                               return acc;
                             }, {} as Record<string, Asset[]>);
                             return Object.entries(groups).map(([name, items]: [string, Asset[]]) => {
                               const gKey = `crosscheck-${name}`;
                               const isOpen = !!expandedGroups[gKey];
                               return (
                                 <div key={gKey} className="relative rounded-2xl border border-orange-100 bg-orange-50/10 overflow-hidden shadow-sm">
                                   <button onClick={() => toggleGroup(gKey)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-orange-50/20 transition-all">
                                     <div className="w-8 h-8 bg-orange-100 text-orange-600 rounded-xl flex items-center justify-center text-sm border border-orange-200 shrink-0">
                                       <i aria-hidden="true" className="fa-solid fa-box"></i>
                                     </div>
                                     <span className="truncate flex-1 min-w-0 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                     <span className="shrink-0 px-2 py-0.5 bg-orange-500 text-white text-[9px] font-black rounded-full">x {eventQuantityTotal(conferenceFormData, items.map(i => i.id), 'crosscheck')}</span>
                                     <i aria-hidden="true" className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                   </button>
                                   {isOpen && (
                                     <div className="border-t border-orange-100 divide-y divide-orange-50">
                                       {items.map(asset => (
                                         <div key={asset.id} className="flex items-center gap-2 px-4 py-2.5">
                                           <span className="font-mono text-[10px] text-slate-700 font-bold truncate flex-1">
                                             {asset.aliasName && !['Apple MacBook', 'Windows Laptop', 'MacBook'].includes(asset.aliasName)
                                               ? `${asset.aliasName} • ${asset.sku || asset.serialNumber}`
                                               : (asset.sku || asset.serialNumber)}
                                           </span>
                                           {quantityLabel(conferenceFormData, asset.id) && <span className="text-[10px] font-bold text-slate-600">{quantityLabel(conferenceFormData, asset.id)}</span>}
                                           {canVerifyReturns(user) && (
                                             <div className="flex gap-1.5 shrink-0">
                                               <button 
                                                 onClick={() => setFlagMenuAssetId(flagMenuAssetId === asset.id ? null : asset.id)}
                                                 className={`w-7 h-7 border rounded-lg flex items-center justify-center transition-all ${
                                                   asset.status === 'Damaged' || asset.flag === 'Missing'
                                                     ? 'bg-red-500 border-red-400 text-white animate-pulse'
                                                     : 'bg-white border-slate-200 text-slate-400 hover:text-red-500'
                                                 }`} title="Report Issue">
                                                 <i aria-hidden="true" className="fa-solid fa-circle-exclamation text-[9px]"></i>
                                               </button>
                                               <button onClick={() => verifyCrosscheckAsset(asset)} className="w-7 h-7 bg-orange-500 text-white rounded-lg flex items-center justify-center transition-all active:scale-95" title="Verify Receipt">
                                                 <i aria-hidden="true" className="fa-solid fa-check text-[9px]"></i>
                                               </button>
                                             </div>
                                           )}
                                           {/* Floating Issue Menu */}
                                           {flagMenuAssetId === asset.id && (
                                             <div className="absolute top-0 right-12 z-[60] bg-white border border-slate-200 rounded-2xl shadow-2xl p-2 min-w-[160px] animate-in fade-in slide-in-from-right-2 duration-200">
                                               <button onClick={() => handleQuickUpdateAsset(asset, { flag: AssetFlag.MISSING }, conferenceFormData.id, 'Crosscheck')} className="w-full px-4 py-3 hover:bg-red-50 flex items-center gap-3 rounded-xl transition-colors text-left">
                                                 <i aria-hidden="true" className="fa-solid fa-flag text-red-500 text-xs"></i>
                                                 <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Missing</span>
                                               </button>
                                               <button onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.DAMAGED, flag: AssetFlag.REQUIRED_SERVICE }, conferenceFormData.id, 'Crosscheck')} className="w-full px-4 py-3 hover:bg-orange-50 flex items-center gap-3 rounded-xl transition-colors text-left">
                                                 <i aria-hidden="true" className="fa-solid fa-tools text-orange-500 text-xs"></i>
                                                 <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Damaged</span>
                                               </button>
                                               <button onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.AVAILABLE, flag: AssetFlag.NONE }, conferenceFormData.id, 'Crosscheck')} className="w-full px-4 py-3 hover:bg-slate-50 flex items-center gap-3 rounded-xl transition-colors text-left border-t border-slate-100">
                                                 <i aria-hidden="true" className="fa-solid fa-check text-emerald-500 text-xs"></i>
                                                 <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Clear / No Issue</span>
                                               </button>
                                             </div>
                                           )}
                                         </div>
                                       ))}
                                     </div>
                                   )}
                                 </div>
                               );
                             });
                           })()}
                          
                          <ConsumablePanel mode="returns" data={conferenceFormData.consumable_data || {}} ledger={conferenceFormData.consumable_ledger || {}}
                                    assets={allAssetsRef.current.length ? allAssetsRef.current : assets} warehouse={['admin', 'boss', 'godown_incharge'].includes(user?.role || '')}
                                    disabled={consumableSaving || pendingMovementCount > 0 || eventDraftConflict}
                                    onRequest={handleUpdateRequestedConsumable} onReturn={handleUpdateReturnedConsumable}
                                    onConfirm={(id, confirmed) => setConferenceFormData((prev: any) => ({ ...prev, consumable_data: { ...prev.consumable_data,
                                      [id]: { ...prev.consumable_data[id], return_confirmed: confirmed } } }))}
                                    onSave={() => { void handleSaveConsumables('save'); }} onDispatch={() => { void handleSaveConsumables('dispatch'); }} />

                          {(['admin', 'boss', 'godown_incharge'].includes(user?.role || '')) && (
                            <div className="col-span-2 pt-10 border-t border-slate-100 mt-6">
                              <button 
                                onClick={() => handleUpdateLogistics(true)}
                                disabled={consumableSaving || pendingMovementCount > 0}
                                className="w-full py-6 bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-[2rem] font-black uppercase text-xs tracking-[0.3em] shadow-2xl shadow-orange-500/30 hover:from-orange-600 hover:to-amber-600 hover:-translate-y-1 active:scale-[0.96] transition-all flex items-center justify-center gap-4 border-b-4 border-orange-700/50 group"
                              >
                                <span className="opacity-70 group-hover:translate-x-1 transition-transform"><i aria-hidden="true" className="fa-solid fa-paper-plane"></i></span>
                                SUBMIT
                              </button>
                              <p className="text-center text-[10px] text-slate-400 font-black uppercase mt-5 tracking-[0.2em] opacity-60 italic">Verify all items locally then click to finalize returns</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}


          {currentPage === 'Billing' && challanViewMode === 'List' && renderChallanList()}

          {
            currentPage === 'Billing' && challanViewMode === 'Detail' && selectedBookingForChallan && (() => {
              const conf = selectedBookingForChallan;
              const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;

              const dispatchIds = (conf.challanAssets && conf.challanAssets.length > 0)
                ? conf.challanAssets.map(String)
                : [...(conf.assets || []), ...(conf.staged_assets || [])].map(String);
              // Return challan uses the same dispatched list as its base — edited/added items
              // should be present on the return too (transfers reduce it further if any).
              const returnIds = (conf.assets || []).map(String);
              const hasTransfers = hasRecordedQuantities(conf) || (conf.transfer_log && conf.transfer_log.length > 0) ||
                (dispatchIds.length !== returnIds.length || JSON.stringify([...dispatchIds].sort()) !== JSON.stringify([...returnIds].sort()));

              // The printed challan PDF always says "DELIVERY CHALLAN" — "Return" is just our internal tab label.
              const detailTitle = 'DELIVERY CHALLAN';

              const trucks = conf.truckChallans || [];
              const hasTrucks = trucks.length > 0;
              const activeTruck = activeTruckChallanId ? trucks.find(t => t.id === activeTruckChallanId) : null;

              const targetAssetIds = challanAssetIds(conf, hasTransfers ? challanDetailTab : 'dispatch', activeTruck);

              // Guaranteed mapping: Every ID in targetAssetIds gets an asset object.
              // Multi-tier fallback ensures no item can EVER disappear due to pool lookup miss.
              const effectiveAssets: Asset[] = targetAssetIds.map(idStr => {
                const id = String(idStr);
                let baseAsset: Asset;
                // 1. Try pool (allAssetsRef or assets)
                let found = pool.find(a => String(a.id) === id);
                if (found) {
                  knownAssetsMapRef.current.set(id, found);
                  baseAsset = found;
                } else if ((found = knownAssetsMapRef.current.get(id))) {
                  // 2. Try knownAssetsMapRef
                  baseAsset = found;
                } else if (activeTruck && (activeTruck as any).assets_details && (found = (activeTruck as any).assets_details.find((a: any) => String(a.id) === id))) {
                  // 3. Try truck assets_details
                  baseAsset = mapRawAsset(found);
                  knownAssetsMapRef.current.set(id, baseAsset);
                } else if ((conf as any).challan_assets_details && (found = (conf as any).challan_assets_details.find((a: any) => String(a.id) === id))) {
                  // 3b. Try conf challan_assets_details
                  baseAsset = mapRawAsset(found);
                  knownAssetsMapRef.current.set(id, baseAsset);
                } else {
                  // 4. Try localStorage cache
                  let cached: any = null;
                  /* An old browser cache cannot establish current stock or custody. */

                  if (cached && cached.id) {
                    baseAsset = cached;
                  } else {
                    // 5. Resilient Fallback - NEVER let an item disappear!
                    baseAsset = {
                      id: id,
                      sku: `ITEM-${id}`,
                      aliasName: `Item #${id}`,
                      serialNumber: '',
                      type: 'Other',
                      quantity: 1,
                      itemPrice: 0,
                      status: 'In Use' as any,
                      barcode: '',
                      condition: 'Good',
                      description: 'Challan Item',
                      isBarcodeAdded: false,
                      macAddress: '',
                      imeiNumber1: '',
                      imeiNumber2: '',
                      purchasedDate: '',
                      depreciationPercentage: 0,
                      availableFrom: '',
                      availableTill: '',
                      createdAt: '',
                      lastMaintained: ''
                    } as Asset;
                  }
                }

                // If active truck is selected, override quantity if allocated quantity exists for this truck
                const truckQty = activeTruck?.asset_quantities?.[id];
                const finalQty = (truckQty !== undefined && truckQty !== null)
                  ? Number(truckQty)
                  : (Number(baseAsset.quantity) || 1);

                return {
                  ...baseAsset,
                  quantity: finalQty,
                };
              }).filter(Boolean);

              // Per user requirement: if multi-trucks exist, master challan has blank vehicle and driver.
              // If an active truck is selected, show that truck's vehicle and driver.
              // IMPORTANT: effectiveBooking.id is ALWAYS conf.id — never mutated.
              const effectiveBooking: Booking = activeTruck
                ? {
                    ...conf,
                    challanNumber: activeTruck.challan_number || (activeTruck.truck_number === 1 ? conf.challanNumber : ''),
                    vehicleNumber: activeTruck.vehicle_number || '',
                    driverPhone: activeTruck.driver_phone || '',
                  }
                : (hasTrucks ? { ...conf, vehicleNumber: '', driverPhone: '' } : conf);

              return (
                <div className="animate-in fade-in zoom-in duration-300">
                  <div className="no-print p-8 flex flex-col md:flex-row justify-between items-center gap-4 container mx-auto">
                    <button onClick={() => { setActiveTruckChallanId(null); setChallanViewMode('List'); }} className="px-6 py-3 bg-slate-800 text-white rounded-xl font-bold uppercase text-xs">
                      ← Back to List
                    </button>

                    {/* Dual Challan Tab Toggle if transfers exist */}
                    {hasTransfers && (!activeTruck || !conf.truck_manifest) && (
                      <div className="flex bg-slate-900/80 p-1.5 rounded-2xl border border-slate-800 shadow-xl">
                        <button
                          onClick={() => setChallanDetailTab('dispatch')}
                          className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all ${
                            challanDetailTab === 'dispatch'
                              ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/20'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          📄 Original Dispatch ({dispatchIds.length})
                        </button>
                        <button
                          onClick={() => setChallanDetailTab('return')}
                          className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all ${
                            challanDetailTab === 'return'
                              ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          ↩️ Return Challan ({returnIds.length})
                        </button>
                      </div>
                    )}

                    <div className="flex gap-4">
                      {user?.role === 'accounts' && (
                        <button
                          disabled={invoicingId === conf.id}
                          onClick={() => handleToggleInvoiced(conf.id, !!(conf.is_invoiced || conf.isInvoiced))}
                          className={`px-5 py-3 rounded-xl font-bold uppercase text-xs shadow-lg transition-all flex items-center gap-2 border ${
                            (conf.is_invoiced || conf.isInvoiced)
                              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25 shadow-emerald-500/10'
                              : 'bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25 shadow-amber-500/10'
                          } ${invoicingId === conf.id ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer active:scale-95'}`}
                          title={(conf.is_invoiced || conf.isInvoiced) ? 'Click to mark as Pending Invoice' : 'Click to mark as Invoiced'}
                        >
                          {invoicingId === conf.id ? (
                            <i aria-hidden="true" className="fa-solid fa-spinner fa-spin text-xs"></i>
                          ) : (
                            <i aria-hidden="true" className={`fa-solid ${(conf.is_invoiced || conf.isInvoiced) ? 'fa-circle-check text-emerald-400' : 'fa-clock text-amber-400'}`}></i>
                          )}
                          {(conf.is_invoiced || conf.isInvoiced) ? 'Invoiced' : 'Pending Invoice'}
                        </button>
                      )}
                      <button
                        onClick={() => handlePrintChallan(conf, hasTransfers ? challanDetailTab : 'dispatch', false, activeTruck)}
                        className="px-6 py-3 bg-sky-500 hover:bg-sky-400 text-white rounded-xl font-bold uppercase text-xs shadow-lg shadow-sky-500/20 transition-all flex items-center gap-2"
                      >
                        <i aria-hidden="true" className="fa-solid fa-print"></i>
                        Print {activeTruck ? activeTruck.label : (hasTransfers ? (challanDetailTab === 'return' ? 'Return Challan' : 'Dispatch Challan') : 'Challan')}
                      </button>
                    </div>
                  </div>

                  {/* ── MULTI-TRUCK BAR ────────────────────────────────────── */}
                  <div className="no-print container mx-auto px-8 pb-6"><TruckManifestPanel key={conf.id} booking={conf}
                    canWrite={['admin', 'boss', 'godown_incharge'].includes(user?.role || '')}
                    disabled={manifestSaving || pendingMovementCount > 0}
                    onViewTruck={id => { setActiveTruckChallanId(id); setChallanDetailTab('dispatch'); }}
                    onCommand={(action, fields) => submitManifestCommand(conf.id, action, fields)} /></div>
                  {!conf.truck_manifest && (<div className="no-print container mx-auto px-8 pb-6">
                    {!hasTrucks ? (
                      <div className="flex items-center justify-between bg-slate-900/60 p-4 md:p-5 rounded-2xl border border-slate-800 flex-wrap gap-4">
                        <div>
                          <p className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                            <i aria-hidden="true" className="fa-solid fa-truck-fast text-emerald-400"></i>
                            Multi-Truck Logistics
                          </p>
                          <p className="text-[10px] text-slate-400 mt-0.5">Need to split this event across multiple trucks? Create individual truck challans with distinct vehicles, drivers, and items.</p>
                        </div>
                        {(user?.role === 'admin' || user?.role === 'godown_incharge' || user?.is_staff) && (
                          <button
                            onClick={() => handleAddTruck(conf.id)}
                            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-lg shadow-emerald-500/20"
                          >
                            <i aria-hidden="true" className="fa-solid fa-truck"></i>
                            + Add Truck 2 (Split Challans)
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-4 bg-slate-900/60 p-5 rounded-3xl border border-slate-800">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-black text-sky-400 uppercase tracking-widest bg-sky-500/10 px-3 py-1 rounded-lg border border-sky-500/20 flex items-center gap-1.5">
                              <i aria-hidden="true" className="fa-solid fa-truck-fast"></i> Multi-Truck Dispatch
                            </span>
                            <span className="text-[10px] text-slate-400 font-bold">
                              {trucks.length} Trucks Active • Main Challan preserves all {dispatchIds.length} items
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {(user?.role === 'admin' || user?.role === 'godown_incharge' || user?.is_staff) && (
                              <button
                                onClick={() => handleAddTruck(conf.id)}
                                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-[10px] font-black uppercase tracking-widest rounded-xl border border-emerald-500/30 transition-all shadow-sm"
                              >
                                <i aria-hidden="true" className="fa-solid fa-plus text-[9px]"></i>
                                Add Truck {trucks.length + 1}
                              </button>
                            )}
                            {(user?.role === 'admin' || user?.role === 'godown_incharge' || user?.is_staff) && (
                              <button
                                onClick={() => {
                                  if (confirm('Are you sure you want to remove ALL truck splits and return to a single main challan?')) {
                                    handleDeleteAllTrucks(trucks[0].id, conf.id);
                                  }
                                }}
                                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[10px] font-black uppercase tracking-widest rounded-xl border border-red-500/30 transition-all shadow-sm"
                              >
                                <i aria-hidden="true" className="fa-solid fa-trash text-[9px]"></i>
                                Remove Split
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Truck Cards */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                          {/* Main Master Card */}
                          <div
                            onClick={() => setActiveTruckChallanId(null)}
                            className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                              activeTruckChallanId === null
                                ? 'bg-sky-500/15 border-sky-500/60 shadow-lg shadow-sky-500/10 ring-1 ring-sky-500/50'
                                : 'bg-slate-950/40 border-slate-800 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[10px] font-black text-sky-400 uppercase tracking-widest">Main Challan</span>
                              <span className="px-2 py-0.5 bg-sky-500/20 text-sky-300 text-[9px] font-black rounded-md">
                                {dispatchIds.length} Items
                              </span>
                            </div>
                            <p className="text-[11px] font-bold text-white uppercase">Master Manifest</p>
                            <p className="text-[9px] text-slate-400 mt-1">Full conference manifest (all items)</p>
                            <div className="mt-3 pt-2 border-t border-slate-800/60">
                              <span className={`inline-block w-full py-1 text-center text-[9px] font-black uppercase rounded-lg ${
                                activeTruckChallanId === null ? 'bg-sky-500 text-white font-black' : 'bg-slate-800 text-slate-400'
                              }`}>
                                {activeTruckChallanId === null ? 'Viewing Master' : 'View Master'}
                              </span>
                            </div>
                          </div>

                          {/* Individual Truck Cards */}
                          {trucks.map(truck => {
                            const isActive = activeTruckChallanId === truck.id;
                            const isEditing = editingTruckId === truck.id;

                            return (
                              <div
                                key={truck.id}
                                className={`p-4 rounded-2xl border transition-all ${
                                  isActive
                                    ? 'bg-emerald-500/15 border-emerald-500/60 shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-500/50'
                                    : 'bg-slate-950/40 border-slate-800 hover:border-slate-700'
                                }`}
                              >
                                <div className="flex items-center justify-between mb-1.5">
                                  <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">{truck.label}</span>
                                  <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 text-[9px] font-black rounded-md">
                                    {truck.assets.length} Items
                                  </span>
                                </div>

                                {isEditing ? (
                                  <div className="space-y-2 mt-2" onClick={e => e.stopPropagation()}>
                                    <input
                                      type="text"
                                      placeholder="Challan Number"
                                      value={truckEditValues.challan_number ?? ''}
                                      onChange={e => setTruckEditValues(v => ({ ...v, challan_number: e.target.value }))}
                                      className="w-full px-2.5 py-1.5 bg-slate-900 border border-amber-500/40 text-amber-400 rounded-lg text-[10px] font-mono"
                                    />
                                    <input
                                      type="text"
                                      placeholder="Vehicle Number"
                                      value={truckEditValues.vehicle_number}
                                      onChange={e => setTruckEditValues(v => ({ ...v, vehicle_number: e.target.value }))}
                                      className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 text-white rounded-lg text-[10px] font-mono uppercase"
                                    />
                                    <input
                                      type="text"
                                      placeholder="Driver Phone"
                                      value={truckEditValues.driver_phone}
                                      onChange={e => setTruckEditValues(v => ({ ...v, driver_phone: e.target.value }))}
                                      className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 text-white rounded-lg text-[10px] font-mono"
                                    />
                                    <div className="flex gap-1.5 pt-1">
                                      <button
                                        onClick={async () => {
                                          try {
                                            await handleUpdateTruck(truck.id, truckEditValues);
                                            setEditingTruckId(null);
                                          } catch {
                                            // The update handler shows the error; retain edits for retry.
                                          }
                                        }}
                                        className="flex-1 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[9px] font-black uppercase rounded-lg transition"
                                      >
                                        Save
                                      </button>
                                      <button
                                        onClick={() => setEditingTruckId(null)}
                                        className="flex-1 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] font-black uppercase rounded-lg transition"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div
                                      onClick={() => setActiveTruckChallanId(truck.id)}
                                      className="cursor-pointer space-y-0.5 my-2"
                                    >
                                      {truck.challan_number && (
                                        <p className="text-[10px] font-mono font-black text-amber-400 truncate">
                                          {truck.challan_number}
                                        </p>
                                      )}
                                      <p className="text-[11px] font-mono font-bold text-white uppercase truncate">
                                        {truck.vehicle_number || <span className="text-slate-500 font-normal italic">No Vehicle Set</span>}
                                      </p>
                                      <p className="text-[10px] text-slate-400 font-mono truncate">
                                        {truck.driver_phone ? `📞 ${truck.driver_phone}` : <span className="text-slate-500 italic">No Driver Phone</span>}
                                      </p>
                                    </div>

                                    <div className="flex items-center gap-1.5 pt-2 border-t border-slate-800/60">
                                      <button
                                        onClick={() => setActiveTruckChallanId(truck.id)}
                                        className={`flex-1 py-1 text-[9px] font-black uppercase tracking-wider rounded-lg transition ${
                                          isActive ? 'bg-emerald-500 text-slate-950 font-extrabold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                                        }`}
                                      >
                                        {isActive ? 'Active' : 'View'}
                                      </button>
                                      {(user?.role === 'admin' || user?.role === 'godown_incharge' || user?.is_staff) && (
                                        <>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setEditingTruckId(truck.id);
                                              setTruckEditValues({ expected_revision: selectedBookingForChallan?.revision ?? 0, vehicle_number: truck.vehicle_number, driver_phone: truck.driver_phone, challan_number: truck.challan_number || '' });
                                            }}
                                            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-[9px] font-black uppercase transition"
                                            title="Edit Truck Details"
                                          >
                                            <i aria-hidden="true" className="fa-solid fa-pen"></i>
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              const other = trucks.find(t => t.id !== truck.id) || truck;
                                              setShowTruckTransferModal({ fromTruckId: other.id, toTruckId: truck.id });
                                              setTruckTransferSelection([]);
                                            }}
                                            className="px-2 py-1 bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 rounded-lg text-[9px] font-black uppercase tracking-wider transition"
                                            title="Transfer / Manage Items"
                                          >
                                            <i aria-hidden="true" className="fa-solid fa-right-left mr-1"></i> Items
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>)}

                  {/* ── TRUCK TRANSFER MODAL ───────────────────────────────── */}
                  {showTruckTransferModal && !conf.truck_manifest && (() => {
                    const { fromTruckId, toTruckId } = showTruckTransferModal;
                    const fromTruck = trucks.find(t => t.id === fromTruckId);
                    const toTruck = trucks.find(t => t.id === toTruckId);
                    if (!fromTruck || !toTruck) return null;

                    const getTruckAssetsWithQuantities = (truck: TruckChallan) => {
                      return (truck.assets || []).map(idStr => {
                        const id = String(idStr);
                        let found = pool.find(a => String(a.id) === id);
                        if (!found) found = knownAssetsMapRef.current.get(id);
                        if (!found && truck.assets_details) {
                          const raw = truck.assets_details.find((a: any) => String(a.id) === id);
                          if (raw) found = mapRawAsset(raw);
                        }
                        if (!found && (conf as any).challan_assets_details) {
                          const raw = (conf as any).challan_assets_details.find((a: any) => String(a.id) === id);
                          if (raw) found = mapRawAsset(raw);
                        }
                        const baseAsset = found || ({
                          id: id,
                          sku: `ITEM-${id}`,
                          aliasName: `Item #${id}`,
                          serialNumber: '',
                          type: 'Other',
                          quantity: 1,
                        } as Asset);

                        const truckAllocatedQty = truck.asset_quantities?.[id];
                        const finalQty = (truckAllocatedQty !== undefined && truckAllocatedQty !== null)
                          ? Number(truckAllocatedQty)
                          : (Number(baseAsset.quantity) || 1);

                        return {
                          ...baseAsset,
                          quantity: finalQty,
                        };
                      });
                    };

                    const fromAssets = getTruckAssetsWithQuantities(fromTruck);
                    const toAssets = getTruckAssetsWithQuantities(toTruck);

                    const totalUnitsToMove = truckTransferSelection.reduce((sum, aid) => {
                      const asset = fromAssets.find(a => String(a.id) === aid);
                      const maxQty = asset ? asset.quantity : 1;
                      const qty = truckTransferQuantities[aid] !== undefined ? truckTransferQuantities[aid] : maxQty;
                      return sum + Math.max(1, Math.min(maxQty, qty));
                    }, 0);

                    return (
                      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-200">
                        <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl" onClick={() => setShowTruckTransferModal(null)}></div>
                        <div className="relative w-full max-w-4xl bg-slate-900 border border-slate-800 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[85vh] pointer-events-auto">
                          {/* Header */}
                          <div className="p-6 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
                            <div>
                              <h3 className="text-xl font-black text-white uppercase tracking-tight flex items-center gap-2">
                                <i aria-hidden="true" className="fa-solid fa-truck-ramp-box text-emerald-400"></i>
                                Transfer Items Between Trucks
                              </h3>
                              <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-1">
                                Move items from <span className="text-amber-400 font-bold">{fromTruck.label}</span> into <span className="text-emerald-400 font-bold">{toTruck.label}</span>
                              </p>
                            </div>
                            <button onClick={() => setShowTruckTransferModal(null)} className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition">
                              <i aria-hidden="true" className="fa-solid fa-xmark text-lg"></i>
                            </button>
                          </div>

                          {/* Truck Selectors Bar */}
                          <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between gap-4 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Source Truck:</span>
                              <select
                                value={fromTruckId}
                                onChange={e => {
                                  setShowTruckTransferModal(prev => prev ? { ...prev, fromTruckId: e.target.value } : null);
                                  setTruckTransferSelection([]);
                                  setTruckTransferQuantities({});
                                }}
                                className="bg-slate-900 border border-slate-700 text-white font-bold text-xs rounded-xl px-3 py-1.5"
                              >
                                {trucks.map(t => (
                                  <option key={t.id} value={t.id} disabled={t.id === toTruckId}>
                                    {t.label} ({t.assets.length} items)
                                  </option>
                                ))}
                              </select>
                            </div>
                            <i aria-hidden="true" className="fa-solid fa-arrow-right text-slate-500 hidden md:block"></i>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Destination Truck:</span>
                              <select
                                value={toTruckId}
                                onChange={e => {
                                  setShowTruckTransferModal(prev => prev ? { ...prev, toTruckId: e.target.value } : null);
                                }}
                                className="bg-slate-900 border border-slate-700 text-white font-bold text-xs rounded-xl px-3 py-1.5"
                              >
                                {trucks.map(t => (
                                  <option key={t.id} value={t.id} disabled={t.id === fromTruckId}>
                                    {t.label} ({t.assets.length} items)
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          {/* Two Panels */}
                          <div className="flex flex-1 overflow-hidden divide-x divide-slate-800">
                            {/* Left Panel — Source Truck Items */}
                            <div className="flex-1 flex flex-col overflow-hidden bg-slate-900/30">
                              <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/20">
                                <div>
                                  <p className="text-[10px] font-black text-amber-400 uppercase tracking-widest">
                                    {fromTruck.label} Items ({fromAssets.length})
                                  </p>
                                  <p className="text-[9px] text-slate-500">Check items and specify quantity to move</p>
                                </div>
                                {fromAssets.length > 0 && (
                                  <button
                                    onClick={() => {
                                      if (truckTransferSelection.length === fromAssets.length) {
                                        setTruckTransferSelection([]);
                                        setTruckTransferQuantities({});
                                      } else {
                                        setTruckTransferSelection(fromAssets.map(a => String(a.id)));
                                        const allQtys: Record<string, number> = {};
                                        fromAssets.forEach(a => { allQtys[String(a.id)] = a.quantity; });
                                        setTruckTransferQuantities(allQtys);
                                      }
                                    }}
                                    className="text-[9px] font-black uppercase text-sky-400 hover:text-white transition"
                                  >
                                    {truckTransferSelection.length === fromAssets.length ? 'Deselect All' : 'Select All'}
                                  </button>
                                )}
                              </div>
                              <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
                                {fromAssets.length === 0 ? (
                                  <div className="text-center py-12 text-slate-600 text-xs italic">
                                    No items currently in {fromTruck.label}
                                  </div>
                                ) : (
                                  fromAssets.map(a => {
                                    const aid = String(a.id);
                                    const isChecked = truckTransferSelection.includes(aid);
                                    const maxQty = a.quantity ?? 1;
                                    const selectedQty = truckTransferQuantities[aid] !== undefined ? truckTransferQuantities[aid] : maxQty;

                                    return (
                                      <div
                                        key={a.id}
                                        className={`p-3 rounded-xl border transition-all ${
                                          isChecked
                                            ? 'bg-sky-500/15 border-sky-500/40 text-white'
                                            : 'bg-slate-950/40 border-slate-800/80 hover:border-slate-700 text-slate-300'
                                        }`}
                                      >
                                        <div className="flex items-center gap-3">
                                          <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={e => {
                                              if (e.target.checked) {
                                                setTruckTransferSelection(prev => [...prev, aid]);
                                                setTruckTransferQuantities(prev => ({ ...prev, [aid]: maxQty }));
                                              } else {
                                                setTruckTransferSelection(prev => prev.filter(x => x !== aid));
                                              }
                                            }}
                                            className="w-4 h-4 rounded accent-sky-500 cursor-pointer"
                                          />
                                          <div
                                            className="min-w-0 flex-1 cursor-pointer"
                                            onClick={() => {
                                              if (isChecked) {
                                                setTruckTransferSelection(prev => prev.filter(x => x !== aid));
                                              } else {
                                                setTruckTransferSelection(prev => [...prev, aid]);
                                                setTruckTransferQuantities(prev => ({ ...prev, [aid]: maxQty }));
                                              }
                                            }}
                                          >
                                            <p className="text-xs font-bold uppercase truncate">{a.aliasName || a.sku}</p>
                                            <p className="text-[9px] font-mono text-slate-400">{a.sku} • In Truck: <span className="font-bold text-amber-400">{maxQty}</span></p>
                                          </div>

                                          {/* Quantity Stepper when multiple quantity is available */}
                                          {isChecked && maxQty > 1 ? (
                                            <div className="flex items-center gap-1 bg-slate-900 px-2 py-1 rounded-lg border border-slate-700 shrink-0">
                                              <span className="text-[9px] text-slate-400 font-bold uppercase mr-1">Move:</span>
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  const next = Math.max(1, selectedQty - 1);
                                                  setTruckTransferQuantities(prev => ({ ...prev, [aid]: next }));
                                                }}
                                                className="w-5 h-5 rounded bg-slate-800 hover:bg-slate-700 text-white flex items-center justify-center text-xs font-bold"
                                              >
                                                -
                                              </button>
                                              <input
                                                type="number"
                                                min={1}
                                                max={maxQty}
                                                value={selectedQty}
                                                onClick={e => e.stopPropagation()}
                                                onChange={(e) => {
                                                  e.stopPropagation();
                                                  const val = Math.max(1, Math.min(maxQty, parseInt(e.target.value, 10) || 1));
                                                  setTruckTransferQuantities(prev => ({ ...prev, [aid]: val }));
                                                }}
                                                className="w-10 text-center bg-slate-950 border border-slate-700 rounded text-xs font-bold text-emerald-400 py-0.5"
                                              />
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  const next = Math.min(maxQty, selectedQty + 1);
                                                  setTruckTransferQuantities(prev => ({ ...prev, [aid]: next }));
                                                }}
                                                className="w-5 h-5 rounded bg-slate-800 hover:bg-slate-700 text-white flex items-center justify-center text-xs font-bold"
                                              >
                                                +
                                              </button>
                                              <span className="text-[9px] text-slate-500 ml-1">/ {maxQty}</span>
                                            </div>
                                          ) : isChecked ? (
                                            <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded text-[9px] font-black uppercase">
                                              1 unit
                                            </span>
                                          ) : null}
                                        </div>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                              {truckTransferSelection.length > 0 && (
                                <div className="p-4 border-t border-slate-800 bg-slate-950/50">
                                  <button
                                    onClick={async () => {
                                      const transfers = truckTransferSelection.map(aid => {
                                        const asset = fromAssets.find(a => String(a.id) === aid);
                                        const maxQty = asset ? asset.quantity : 1;
                                        const qty = truckTransferQuantities[aid] !== undefined ? truckTransferQuantities[aid] : maxQty;
                                        return { asset_id: parseInt(aid, 10), quantity: Math.max(1, Math.min(maxQty, qty)) };
                                      });
                                      await handleTransferToTruck(fromTruckId, toTruckId, transfers);
                                      setTruckTransferSelection([]);
                                      setTruckTransferQuantities({});
                                    }}
                                    className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs uppercase tracking-widest rounded-xl transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                                  >
                                    <i aria-hidden="true" className="fa-solid fa-arrow-right"></i>
                                    Move {truckTransferSelection.length} Item{truckTransferSelection.length > 1 ? 's' : ''} ({totalUnitsToMove} unit{totalUnitsToMove > 1 ? 's' : ''}) to {toTruck.label}
                                  </button>
                                </div>
                              )}
                            </div>

                            {/* Right Panel — Destination Truck Items */}
                            <div className="flex-1 flex flex-col overflow-hidden bg-slate-900/30">
                              <div className="p-4 border-b border-slate-800 bg-slate-950/20">
                                <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">
                                  {toTruck.label} Items ({toAssets.length})
                                </p>
                                <p className="text-[9px] text-slate-500">Currently loaded into {toTruck.label}</p>
                              </div>
                              <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
                                {toAssets.length === 0 ? (
                                  <div className="text-center py-12 text-slate-600 text-xs italic">
                                    {toTruck.label} has no items assigned yet.
                                  </div>
                                ) : (
                                  toAssets.map(a => (
                                    <div
                                      key={a.id}
                                      className="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/40 border border-slate-800"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <p className="text-xs font-bold text-white uppercase truncate">{a.aliasName || a.sku}</p>
                                        <p className="text-[9px] font-mono text-slate-400">{a.sku} • In Truck: <span className="font-bold text-emerald-400">{a.quantity ?? 1}</span></p>
                                      </div>
                                      <div className="flex items-center gap-1 shrink-0">
                                        {a.quantity > 1 && (
                                          <button
                                            onClick={() => handleTransferToTruck(toTruckId, fromTruckId, [{ asset_id: parseInt(String(a.id), 10), quantity: 1 }])}
                                            className="px-2 py-1 bg-slate-800 hover:bg-amber-500/20 text-slate-300 hover:text-amber-400 border border-slate-700 hover:border-amber-500/30 rounded-lg text-[9px] font-black uppercase transition flex items-center gap-1"
                                            title={`Return 1 unit back to ${fromTruck.label}`}
                                          >
                                            <i aria-hidden="true" className="fa-solid fa-arrow-left"></i> 1
                                          </button>
                                        )}
                                        <button
                                          onClick={() => handleTransferToTruck(toTruckId, fromTruckId, [{ asset_id: parseInt(String(a.id), 10), quantity: a.quantity ?? 1 }])}
                                          className="px-2 py-1 bg-slate-800 hover:bg-red-500/20 text-slate-400 hover:text-red-400 border border-slate-700 hover:border-red-500/30 rounded-lg text-[9px] font-black uppercase transition flex items-center gap-1"
                                          title={`Return all ${a.quantity ?? 1} back to ${fromTruck.label}`}
                                        >
                                          <i aria-hidden="true" className="fa-solid fa-arrow-left"></i> {a.quantity > 1 ? `All (${a.quantity})` : 'Return'}
                                        </button>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  <div className="bg-white p-8 min-h-screen container mx-auto rounded-3xl shadow-2xl challan-container">
                    {['admin', 'boss', 'godown_incharge', 'accounts'].includes(user?.role || '') && <ProgramDeliveries
                      key={`deliveries_${user?.user_id || user?.email || ''}_${conf.id}_${activeTruck?.id || 'master'}`}
                      accountId={String(user?.user_id || user?.email || '')}
                      conferenceId={String(conf.id)} truckId={activeTruck?.id}
                      canIssue={['admin', 'boss', 'godown_incharge'].includes(user?.role || '')}
                      apiFetch={apiFetch} apiBase={API_BASE}
                    />}

                    <ChallanView
                      key={`${conf.id}_${activeTruck ? activeTruck.id : 'master'}_${hasTransfers && challanDetailTab === 'return' ? 'return' : 'dispatch'}`}
                      draftAccountId={String(user?.user_id || user?.email || "")}
                      booking={effectiveBooking}
                      client={MOCK_CLIENTS[0]}
                      assets={effectiveAssets}
                      lockNumber={Boolean(conf.truck_manifest)}
                      canImportSources={confTicketSourceState.status === 'ready' && confTicketSourceState.eventId === conf.id}
                      requiresCorrectionReason={Boolean(conf.truck_manifest && conf.challan_documents?.some(doc => doc.truck_id && doc.state === 'issued'))}
                      sourcesReady={(hasTransfers && challanDetailTab === 'return') || challanSourcesReady(conf, activeTruck?.id)}
                      onRetrySources={() => fetchConferenceSubrentalTickets(conf.id)}
                      useSavedDocument={!(hasTransfers && challanDetailTab === 'return')}
                      onSaveDocument={(scope, payload) => handleSaveChallanDocument(conf.id, scope, payload)}
                      challanTitle={detailTitle}
                      companySettings={companySettings}


                      showScanToast={showScanToast}


                      localStorageSuffix={activeTruck ? `__truckId${activeTruck.id}` : undefined}
                      legacyStorageSuffix={activeTruck ? `__truck${activeTruck.truck_number}` : undefined}
                      
                      subrentalTickets={hasTransfers && challanDetailTab === 'return' ? [] : confSubrentalTickets}
                      readOnly={user?.role === 'accounts' || user?.role === 'technician' || Boolean(conf.truck_manifest && activeTruck) || (hasTransfers && challanDetailTab === 'return')}

                  />
                </div>
              </div>
            );
          })()}


        </div >
      </main >

      {/* Quick Scroller */}
      {showScrollTop && (
        <button
          onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-24 right-8 z-[100] w-14 h-14 bg-orange-500/20 hover:bg-orange-500 text-orange-400 hover:text-white rounded-full border border-orange-500/30 backdrop-blur-xl shadow-2xl flex items-center justify-center transition-all animate-in fade-in zoom-in duration-300"
          title="Scroll to Top"
        >
          <i aria-hidden="true" className="fa-solid fa-arrow-up text-xl" />
        </button>
      )}

      {/* ══════════════════════════════════════════════════════════════════
           ASSET TRANSFER MODAL
           Shows all packup assets for the current conference.
           Admin / Godown Incharge can: click-select, hardware-scan, or
           phone-camera-scan items, choose a destination conference, and
           confirm the transfer.
      ══════════════════════════════════════════════════════════════════ */}
      {showTransferModal && (() => {
        const packPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
        const onSiteAssets = packPool.filter(a =>
          new Set((conferenceFormData.assets || []).map(String)).has(String(a.id))
        );
        const modalPackupList = onSiteAssets.filter(a => !isBulkStock(a) && a.type !== 'Consumables');
        const excludedQuantities = onSiteAssets.length - modalPackupList.length;
        const otherConferences = backendConferences.filter(c =>
          c.id !== conferenceFormData.id && !c.isAudit
        );
        const targetConf = otherConferences.find(c => c.id === transferTargetConfId);
        const allSelected = modalPackupList.length > 0 && modalPackupList.every(a => transferSelectedIds.has(String(a.id)));

        const selectTransferScan = (code: string) => {
          const asset = findAssetFromScan(code);
          const ids = new Set(asset?.stock_kind === 'led_case'
            ? (asset.led_case?.panels || []).map(panel => String(panel.asset_id))
            : asset ? [String(asset.id)] : []);
          const found = modalPackupList.filter(row => ids.has(String(row.id)));
          if (!found.length) { showScanToast(`No registered equipment from "${code}" is on site for this program.`, 'warning'); return; }
          setTransferSelectedIds(previous => {
            const next = new Set(previous), remove = found.every(row => next.has(String(row.id)));
            found.forEach(row => remove ? next.delete(String(row.id)) : next.add(String(row.id)));
            return next;
          });
          showScanToast(`Reviewed ${found.length} individually tracked item(s) from this code.`, 'success');
        };
        const handleTransferScanKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter' && transferScanInput.trim()) { selectTransferScan(transferScanInput.trim()); setTransferScanInput(''); }
        };
        const handleTransferCameraScan = (code: string) => { setShowTransferScanner(false); selectTransferScan(code); };

        return (
          <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-full sm:max-w-lg bg-white sm:rounded-3xl rounded-t-3xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">

              {/* Header */}
              <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100 shrink-0">
                <div>
                  <h3 className="text-base font-black text-slate-900 uppercase tracking-tight flex items-center gap-2">
                    <span className="w-8 h-8 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center">
                      <i aria-hidden="true" className="fa-solid fa-arrow-right-arrow-left text-sm"></i>
                    </span>
                    Transfer Assets
                  </h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                    Select items → Choose destination → Confirm
                  </p>
                </div>
                <button
                  onClick={() => { setShowTransferModal(false); setTransferSelectedIds(new Set()); }}
                  className="w-10 h-10 bg-slate-100 hover:bg-slate-200 rounded-xl flex items-center justify-center transition-colors text-slate-600"
                >
                  <i aria-hidden="true" className="fa-solid fa-xmark"></i>
                </button>
              </div>

              {/* Scrollable body */}
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
                {excludedQuantities > 0 && <p role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Bulk stock and consumables cannot be moved through this transfer screen yet. This list contains individually tracked equipment only.</p>}

                {/* ── Step 1: Select Assets ─────────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                      Step 1 — Select Assets
                      {transferSelectedIds.size > 0 && (
                        <span className="ml-2 px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[9px]">
                          {transferSelectedIds.size} selected
                        </span>
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        if (allSelected) setTransferSelectedIds(new Set());
                        else setTransferSelectedIds(new Set(modalPackupList.map(a => String(a.id))));
                      }}
                      className="text-[10px] font-black text-purple-600 hover:text-purple-700 uppercase tracking-widest"
                    >
                      {allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>

                  {/* Scan input (hardware scanner or type) */}
                  <div className="relative mb-3 group">
                    <i aria-hidden="true" className="fa-solid fa-barcode absolute left-3.5 sm:left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-purple-500 transition-colors text-xs sm:text-sm pointer-events-none"></i>
                    <input
                      ref={transferScanRef}
                      type="text"
                      placeholder="Scan or type QR / Barcode..."
                      value={transferScanInput}
                      onChange={e => setTransferScanInput(e.target.value)}
                      onKeyDown={handleTransferScanKeyDown}
                      className="w-full bg-slate-50 rounded-2xl pl-10 sm:pl-11 pr-14 py-3 sm:py-3.5 text-xs sm:text-sm font-bold text-slate-800 border border-slate-200 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 outline-none transition-all placeholder:text-slate-400 placeholder:font-normal shadow-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowTransferScanner(true)}
                      className="absolute right-2.5 sm:right-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-purple-500 hover:bg-purple-600 text-white rounded-xl flex items-center justify-center shadow-md shadow-purple-500/30 transition-transform active:scale-90"
                      title="Scan with camera"
                    >
                      <i aria-hidden="true" className="fa-solid fa-camera text-xs"></i>
                    </button>
                  </div>

                  {/* Asset list */}
                  {modalPackupList.length === 0 ? (
                    <div className="py-8 text-center text-slate-400 text-sm">
                      No assets in the Packup list to transfer.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1 custom-scrollbar">
                      {modalPackupList.map(asset => {
                        const sid = String(asset.id);
                        const checked = transferSelectedIds.has(sid);
                        const inCrosscheck = new Set((conferenceFormData.crosscheck_assets || []).map(String)).has(sid);
                        return (
                          <button
                            key={sid}
                            type="button"
                            disabled={inCrosscheck}
                            onClick={() => {
                              if (inCrosscheck) return;
                              setTransferSelectedIds(prev => {
                                const next = new Set(prev);
                                if (next.has(sid)) next.delete(sid);
                                else next.add(sid);
                                return next;
                              });
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all text-left ${
                              inCrosscheck
                                ? 'opacity-40 cursor-not-allowed bg-slate-50 border-slate-100'
                                : checked
                                ? 'bg-purple-50 border-purple-300 shadow-sm'
                                : 'bg-white border-slate-100 hover:border-purple-200 hover:bg-purple-50/30'
                            }`}
                          >
                            <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                              checked ? 'bg-purple-600 border-purple-600' : 'border-slate-300'
                            }`}>
                              {checked && <i aria-hidden="true" className="fa-solid fa-check text-white text-[9px]"></i>}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-black text-[11px] text-slate-900 truncate uppercase">{asset.aliasName || asset.sku}</p>
                              <p className="text-[10px] text-slate-400 font-mono truncate">{asset.sku}{asset.serialNumber ? ` · ${asset.serialNumber}` : ''}</p>
                            </div>
                            {inCrosscheck && (
                              <span className="shrink-0 text-[9px] font-black text-orange-500 uppercase bg-orange-50 px-2 py-0.5 rounded-full border border-orange-200">
                                In Crosscheck
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ── Step 2: From Address ──────────────────────────── */}
                <div>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                    Step 2 — Dispatched from
                  </p>
                  <textarea
                    aria-label="Transfer dispatch venue"
                    readOnly
                    value={backendConferences.find(c => c.id === String(conferenceFormData.id))?.transportAddress || ''}
                    className="w-full bg-slate-50 rounded-2xl px-4 py-3.5 text-sm font-bold text-slate-800 border border-slate-200 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 outline-none transition-all placeholder:text-slate-300 placeholder:font-normal"
                  />
                  <p className="text-xs text-slate-700 mt-2">Uses this program’s saved delivery address. Save any address correction before transferring equipment.</p>
                </div>

                {/* ── Step 3: Choose Destination Conference ─────────── */}
                <div>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                    Step 3 — Destination Conference
                  </p>
                  <select
                    value={transferTargetConfId}
                    onChange={e => setTransferTargetConfId(e.target.value)}
                    className="w-full bg-slate-50 rounded-2xl px-4 py-3.5 text-sm font-bold text-slate-800 border border-slate-200 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 outline-none transition-all appearance-none"
                  >
                    <option value="">-- Select destination conference --</option>
                    {otherConferences.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.conferenceName || c.name} {c.transport_address ? `· ${c.transport_address}` : ''}
                      </option>
                    ))}
                  </select>

                  {/* Preview target venue */}
                  {targetConf && (
                    <div className="mt-2 px-4 py-2.5 bg-emerald-50 rounded-xl border border-emerald-200 text-[10px] text-emerald-700 font-bold flex items-center gap-2">
                      <i aria-hidden="true" className="fa-solid fa-location-dot text-emerald-500"></i>
                      Arriving at: {targetConf.transport_address || targetConf.billing_address || 'Address not set'}
                    </div>
                  )}

                  {/* ── Shortcut: Create New Conference for Same Venue ─ */}
                  <button
                    type="button"
                    onClick={() => {
                      setShowTransferModal(false);
                      // Pre-fill the new conference form with the current venue
                      openNewConferenceForm();
                      // Auto-fill the transport_address with current venue
                      setTimeout(() => {
                        setConferenceFormData((prev: any) => ({
                          ...prev,
                          transport_address: conferenceFormData.transport_address || '',
                          billing_address: conferenceFormData.billing_address || '',
                          name: `${conferenceFormData.name} — Next Program`
                        }));
                      }, 100);
                    }}
                    className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-purple-300 text-purple-600 hover:bg-purple-50 hover:border-purple-400 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all"
                  >
                    <i aria-hidden="true" className="fa-solid fa-plus-circle"></i>
                    Create New Conference for Same Venue
                  </button>
                </div>

              </div>

              {/* Footer — Confirm button */}
              <div className="px-6 py-4 border-t border-slate-100 shrink-0 space-y-3">
                {transferSelectedIds.size > 0 && transferTargetConfId && (
                  <div className="px-4 py-3 bg-amber-50 rounded-xl border border-amber-200 text-[10px] text-amber-700 font-bold">
                    <i aria-hidden="true" className="fa-solid fa-triangle-exclamation mr-1.5"></i>
                    The current challan will be frozen (if not already) and {transferSelectedIds.size} item(s) will be removed from this conference's Packup.
                  </div>
                )}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowTransferModal(false); setTransferSelectedIds(new Set()); }}
                    className="flex-1 py-3.5 bg-slate-100 hover:bg-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-600 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={transferSelectedIds.size === 0 || !transferTargetConfId || transferring}
                    onClick={handleAssetTransfer}
                    className="flex-1 py-3.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-lg shadow-purple-500/20 flex items-center justify-center gap-2"
                  >
                    {transferring ? (
                      <><i aria-hidden="true" className="fa-solid fa-spinner fa-spin"></i> Transferring...</>
                    ) : (
                      <><i aria-hidden="true" className="fa-solid fa-arrow-right-arrow-left"></i> Transfer {transferSelectedIds.size > 0 ? `(${transferSelectedIds.size})` : ''}</>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Phone Camera scanner inside transfer modal */}
            {showTransferScanner && (
              <Scanner key={`transfer-camera:${user?.user_id || user?.email}`} onScan={handleTransferCameraScan} onClose={() => setShowTransferScanner(false)} />
            )}
          </div>
        );
      })()}

      {/* Camera reads use the same add intent as Enter in Requirements; the
          Packup/Crosscheck branches still choose return/verification by tab. */}
      {showScanner && <Scanner key={`camera:${user?.user_id || user?.email}`} onScan={code => handleScan(code, true)} onClose={() => setShowScanner(false)} />}
      {ledCasePicker && <LedCasePicker source={ledCasePicker.asset} action={ledCasePicker.action} event={conferenceFormData}
        apiFetch={reportApiFetch} pending={pendingMovementCount > 0} onClose={() => setLedCasePicker(null)}
        onConfirm={ids => submitAssetCommand(ledCasePicker.action, ids)} />}

      {/* ── PRINT CHALLAN CHOICE MODAL ────────────────────────────── */}
      {printSelectConf && (() => {
        const conf = printSelectConf;
        const pool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
        const dispatchCount = masterQuantityPreview(conf, pool, 'dispatch').reduce((count, row) => count + row.quantity, 0);
        const returnCount = masterQuantityPreview(conf, pool, 'return').reduce((count, row) => count + row.quantity, 0);

        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 p-4">
            <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-5">
              <div className="flex justify-between items-start border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-base font-black text-slate-900 uppercase tracking-tight flex items-center gap-2">
                    <span className="w-8 h-8 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center">
                      <i aria-hidden="true" className="fa-solid fa-print text-sm"></i>
                    </span>
                    Select Challan Version
                  </h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-1 truncate max-w-[280px]">
                    {conf.conferenceName || (conf as any).name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPrintSelectConf(null)}
                  className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors"
                >
                  <i aria-hidden="true" className="fa-solid fa-xmark"></i>
                </button>
              </div>

              <p className="text-xs font-bold text-slate-600 leading-relaxed">
                Choose the original delivery or the current return quantities for this event:
              </p>

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => {
                    const c = printSelectConf;
                    setPrintSelectConf(null);
                    handlePrintChallan(c, 'dispatch', false);
                  }}
                  className="w-full flex items-center justify-between p-4 rounded-2xl border-2 border-sky-200 bg-sky-50/50 hover:bg-sky-100/70 transition-all text-left group shadow-sm active:scale-98"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-10 h-10 rounded-xl bg-sky-500 text-white flex items-center justify-center text-base shadow-md shrink-0">
                      📄
                    </span>
                    <div className="min-w-0">
                      <p className="font-black text-xs text-slate-900 uppercase tracking-tight">Original Dispatch Challan</p>
                      <p className="text-[10px] text-slate-500 font-medium mt-0.5">All items originally sent from godown</p>
                    </div>
                  </div>
                  <span className="shrink-0 px-2.5 py-1 bg-sky-500 text-white rounded-lg text-[10px] font-black">{dispatchCount} Items</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const c = printSelectConf;
                    setPrintSelectConf(null);
                    handlePrintChallan(c, 'return', false);
                  }}
                  className="w-full flex items-center justify-between p-4 rounded-2xl border-2 border-purple-200 bg-purple-50/50 hover:bg-purple-100/70 transition-all text-left group shadow-sm active:scale-98"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-10 h-10 rounded-xl bg-purple-600 text-white flex items-center justify-center text-base shadow-md shrink-0">
                      ↩️
                    </span>
                    <div className="min-w-0">
                      <p className="font-black text-xs text-slate-900 uppercase tracking-tight">Godown Return Challan</p>
                      <p className="text-[10px] text-slate-500 font-medium mt-0.5">Remaining items returning to godown</p>
                    </div>
                  </div>
                  <span className="shrink-0 px-2.5 py-1 bg-purple-600 text-white rounded-lg text-[10px] font-black">{returnCount} Items</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => setPrintSelectConf(null)}
                className="w-full py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}


      {updating && <div className="fixed inset-0 z-[100] bg-slate-950/95 flex items-center justify-center text-white">Updating the app… Please keep this page open.</div>}
      {/* QR Label Modal */}
      {qrTarget && (
        <QRLabelModal
          assetId={qrTarget.id}
          sku={qrTarget.sku}
          assetName={qrTarget.name}
          assetType={qrTarget.assetType}
          onPrint={handlePrintAsset}
          onClose={() => setQrTarget(null)}
          companySettings={companySettings}
          subrentalCompanies={subrentalCompanies}
        />
      )}

      {/* Pending Sub-Asset Checklist Modal */}
      {pendingParentAsset && pendingAction && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 backdrop-blur-xl p-4 animate-in fade-in duration-300">
          <div className="bg-slate-900 border border-slate-700 max-w-lg w-full rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col">
            <div className="p-8 border-b border-slate-800 flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-orange-500/20 text-orange-400 rounded-full flex items-center justify-center mb-6 border border-orange-500/30">
                <i aria-hidden="true" className="fa-solid fa-boxes-stacked text-2xl" />
              </div>
              <h3 className="text-2xl font-black text-white uppercase tracking-tighter mb-2">
                Scan Required Components
              </h3>
              <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">
                {pendingAction === 'add' ? 'Adding to Conference' : 'Removing from Conference'}
              </p>
            </div>

            <div className="p-6 bg-slate-950/50">
              <div className="flex items-center gap-4 bg-slate-900 border border-slate-800 p-4 rounded-2xl mb-6">
                <div className="flex-1">
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Main Asset</p>
                  <p className="text-sm font-black text-sky-400 uppercase">{pendingParentAsset.aliasName || pendingParentAsset.sku}</p>
                </div>
                <i aria-hidden="true" className="fa-solid fa-check-circle text-emerald-500 text-xl" />
              </div>

              <p className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] mb-4 pl-2">Tracked Components ({scannedSubAssetIds.length}/{pendingParentAsset.sub_assets?.length})</p>

              <div className="space-y-3">
                {pendingParentAsset.sub_assets?.map(sub => {
                  const subIdStr = sub.id.toString();
                  const isScanned = scannedSubAssetIds.includes(subIdStr);
                  return (
                    <div
                      key={subIdStr}
                      onClick={() => {
                        if (!isScanned) {
                          const newScanned = [...scannedSubAssetIds, subIdStr];
                          setScannedSubAssetIds(newScanned);
                          showScanToast(`✅ Clicked Component: "${sub.alias_name || sub.sku}"`, 'success');

                          if (newScanned.length >= (pendingParentAsset.sub_assets?.length || 0)) { completeParentMovement(); }
                        }
                      }}
                      className={`flex items-center justify-between p-4 rounded-2xl border transition-all cursor-pointer ${isScanned ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900 border-slate-700 hover:border-sky-500/50'}`}
                    >
                      <div>
                        <p className={`text-xs font-black uppercase ${isScanned ? 'text-emerald-400' : 'text-slate-300'}`}>{sub.alias_name || sub.sku}</p>
                        <p className="text-[9px] text-slate-500 font-mono tracking-wider">{sub.serial_number}</p>
                      </div>
                      {isScanned ? (
                        <i aria-hidden="true" className="fa-solid fa-circle-check text-emerald-500 text-lg animate-in zoom-in" />
                      ) : (
                        <div className="w-5 h-5 rounded-full border-2 border-slate-600 animate-pulse" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-6 border-t border-slate-800 bg-slate-900 flex gap-4">
              <button
                onClick={() => {
                  setPendingParentAsset(null);
                  setPendingAction(null);
                  setScannedSubAssetIds([]);
                }}
                className="flex-[1] py-4 bg-slate-800/80 text-slate-400 rounded-2xl font-black uppercase text-[10px] tracking-wider hover:bg-slate-700 hover:text-white transition"
              >
                Cancel {pendingAction === 'add' ? 'Addition' : 'Removal'}
              </button>
              {isMobilePhone && (
                <button
                  onClick={() => setShowScanner(true)}
                  className="flex-[2] py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-[10px] tracking-wider hover:bg-sky-400 transition shadow-[0_0_20px_rgba(14,165,233,0.3)]"
                >
                  Open Scanner
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Scan Toast */}
      {scanToast && (
        <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-50 px-6 py-4 rounded-2xl font-black text-sm uppercase tracking-wide shadow-2xl transition-all animate-in slide-in-from-bottom-4 duration-300 ${scanToast.type === 'success' ? 'bg-emerald-500 text-white' :
          scanToast.type === 'warning' ? 'bg-amber-500 text-white' :
            'bg-red-500 text-white'
          }`}>
          {scanToast.message}
        </div>
      )}

      {/* Unrecognized QR Linking Modal */}
      {unrecognizedScan && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95 backdrop-blur-md p-4 animate-in fade-in duration-300">
          <div className="bg-slate-900 w-full max-w-xl rounded-[2.5rem] border border-slate-700 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-8 border-b border-slate-800">
              <p className="text-[10px] font-black text-orange-400 uppercase tracking-widest mb-1">Unrecognized Scan</p>
              <h3 className="text-2xl font-black text-white uppercase tracking-tight mb-4">Link QR to Asset</h3>
              <div className="bg-orange-500/10 border border-orange-500/20 p-4 rounded-2xl flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Scanned Code</p>
                  <p className="text-lg font-mono text-white font-black">{unrecognizedScan}</p>
                </div>
                <button onClick={() => setUnrecognizedScan(null)} className="text-slate-500 hover:text-white transition uppercase text-[10px] font-black">Dismiss</button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-6">
              {linkingAsset && viewingAsset && linkingAsset.id === viewingAsset.id ? (
                <div className="space-y-4">
                  <div className="bg-sky-500/10 border-2 border-sky-500 p-6 rounded-3xl animate-in zoom-in duration-300">
                    <p className="text-[10px] font-black text-sky-500 uppercase tracking-widest mb-3">Suggested Linkage</p>
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-sky-500 text-white rounded-2xl flex items-center justify-center text-xl shadow-lg">
                        <i aria-hidden="true" className="fa-solid fa-link"></i>
                      </div>
                      <div>
                        <p className="text-sm font-black text-white uppercase">{viewingAsset.aliasName || viewingAsset.sku}</p>
                        <p className="text-[9px] text-slate-400 font-bold uppercase">{viewingAsset.type} • ID: {viewingAsset.id}</p>
                      </div>
                    </div>
                    <p className="mt-4 text-[10px] text-slate-400 leading-relaxed font-bold uppercase italic">
                      You were already viewing this asset. Click "Confirm Linkage" below to associate this QR code with it.
                    </p>
                  </div>
                  <button
                    onClick={() => setLinkingAsset(null)}
                    className="w-full py-3 bg-slate-800/50 hover:bg-slate-800 text-slate-500 hover:text-slate-300 rounded-xl text-[10px] font-black uppercase tracking-widest transition"
                  >
                    OR SEARCH FOR ANOTHER ASSET
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Search for target asset:</p>
                  <div className="relative">
                    <i aria-hidden="true" className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                    <input
                      type="text"
                      placeholder="SEARCH BY NAME, SKU OR SN..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-12 pr-4 py-4 text-white uppercase font-black text-xs tracking-wider focus:border-sky-500 outline-none transition"
                      onChange={(e) => setSearchQuery(e.target.value)}
                      autoFocus
                    />
                  </div>

                  <div className="space-y-2">
                    {assets
                      .filter(a => !searchQuery ||
                        (a.aliasName && a.aliasName.toLowerCase().includes(searchQuery.toLowerCase())) ||
                        (a.sku && a.sku.toLowerCase().includes(searchQuery.toLowerCase())) ||
                        (a.type && a.type.toLowerCase().includes(searchQuery.toLowerCase())) ||
                        (a.serialNumber && a.serialNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                      )
                      .slice(0, 5)
                      .map(a => (
                        <button
                          key={a.id}
                          onClick={() => setLinkingAsset(a)}
                          className={`w-full p-4 rounded-2xl border text-left transition flex items-center justify-between ${linkingAsset?.id === a.id
                            ? 'bg-sky-500/10 border-sky-500'
                            : 'bg-slate-950/50 border-slate-800 hover:border-slate-700'
                            }`}
                        >
                          <div>
                            <p className="text-xs font-black text-white uppercase">{a.aliasName || a.sku} • <span className="text-sky-400 font-mono text-[9px]">{a.type}</span></p>
                            <p className="text-[10px] text-slate-500">SN: {a.serialNumber} • SKU: {a.sku}</p>
                          </div>
                          {linkingAsset?.id === a.id && <i aria-hidden="true" className="fa-solid fa-circle-check text-sky-500 text-xl"></i>}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>

            <div className="p-8 border-t border-slate-800 bg-slate-950/50 flex gap-4">
              <button
                onClick={() => setUnrecognizedScan(null)}
                className="flex-1 py-4 bg-slate-800 text-slate-400 rounded-2xl font-black uppercase text-xs hover:bg-slate-700 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                disabled={!linkingAsset}
                onClick={handleLinkQR}
                className="flex-[2] py-4 bg-sky-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition"
              >
                Confirm Linkage
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Consumables Picker Modal */}
      {showConsumablesPicker && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl animate-in fade-in duration-300"></div>
          <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-8 border-b border-slate-800 bg-slate-950/30 flex justify-between items-center">
              <div>
                <h3 className="text-2xl font-black text-white uppercase tracking-tighter">Select Consumable</h3>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1 underline decoration-amber-500 underline-offset-4">
                  Picking from global stock
                </p>
              </div>
              <button onClick={() => setShowConsumablesPicker(false)} className="w-10 h-10 flex items-center justify-center rounded-xl bg-slate-800 text-slate-400 hover:text-white transition">
                <i aria-hidden="true" className="fa-solid fa-times text-xl"></i>
              </button>
            </div>

            <div className="p-4 sm:p-8 space-y-6">
              <div className="relative group w-full">
                <i aria-hidden="true" className="fa-solid fa-magnifying-glass absolute left-3.5 sm:left-4 md:left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-amber-500 transition-colors text-xs md:text-sm pointer-events-none"></i>
                <input
                  type="text"
                  placeholder="Search consumables..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl py-3 sm:py-3.5 md:py-4 pl-9 sm:pl-11 md:pl-12 pr-12 text-xs font-black text-white uppercase tracking-wider focus:border-amber-500 focus:ring-2 focus:ring-amber-500/10 outline-none transition shadow-sm"
                  value={consumablesPickerSearchQuery}
                  onChange={(e) => setConsumablesPickerSearchQuery(e.target.value)}
                  autoFocus
                />
                {consumablesPickerSearchQuery.trim() && (
                  <button
                    type="button"
                    onClick={() => setConsumablesPickerSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 flex items-center justify-center transition active:scale-95"
                    title="Clear search"
                  >
                    <i aria-hidden="true" className="fa-solid fa-xmark text-xs" />
                  </button>
                )}
              </div>

              <div className="max-h-[40vh] overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                {assets
                  .filter(a => a.type === AssetCategory.CONSUMABLES && a.status === 'Available' && (a.quantity || 0) > 0)
                  .filter(a => {
                    const q = normalizeSearch(consumablesPickerSearchQuery);
                    return normalizeSearch(a.aliasName || a.sku || '').includes(q);
                  })
                  .map(a => {
                    const currentReq = Number(conferenceFormData.consumable_data?.[String(a.id)]?.requested || 0);
                    const availableStock = Math.max(0, (a.quantity || 0) - currentReq);

                    return (
                      <button
                        key={a.id}
                        disabled={availableStock <= 0}
                        onClick={() => {
                          if (availableStock <= 0) return;
                          setQuantityAsset(a);
                          setSelectedQuantity(Math.min(1, availableStock));
                          setShowConsumablesPicker(false);
                          setShowQuantityModal(true);
                        }}
                        className={`w-full flex items-center justify-between p-6 bg-slate-950/50 border rounded-2xl transition animate-in fade-in slide-in-from-left-4 ${
                          availableStock <= 0
                            ? 'border-slate-800/50 opacity-40 cursor-not-allowed'
                            : 'border-slate-800 hover:border-amber-500 group cursor-pointer'
                        }`}
                      >
                        <div className="text-left">
                          <p className="text-sm font-black text-white uppercase group-hover:text-amber-500 transition">{a.aliasName || a.sku}</p>
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">
                            Available Stock: <span className="text-amber-400 font-extrabold">{availableStock} Units</span>
                            {currentReq > 0 && <span className="text-slate-400 font-medium ml-2">({currentReq} in this request)</span>}
                          </p>
                        </div>
                        {availableStock > 0 ? (
                          <i aria-hidden="true" className="fa-solid fa-chevron-right text-slate-700 group-hover:text-amber-500 group-hover:translate-x-1 transition"></i>
                        ) : (
                          <span className="px-3 py-1 bg-red-500/10 border border-red-500/20 text-red-400 text-[9px] font-black rounded-full uppercase">All Assigned</span>
                        )}
                      </button>
                    );
                  })}

                {assets.filter(a => a.type === AssetCategory.CONSUMABLES && a.status === 'Available' && (a.quantity || 0) > 0).length === 0 && (
                  <div className="py-12 text-center space-y-4">
                    <i aria-hidden="true" className="fa-solid fa-box-open text-4xl text-slate-800"></i>
                    <p className="text-xs font-black text-slate-600 uppercase tracking-widest">No available consumables found.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="p-8 border-t border-slate-800 bg-slate-950/50">
              <button
                onClick={() => setShowConsumablesPicker(false)}
                className="w-full py-4 bg-slate-800 text-slate-400 rounded-2xl font-black uppercase text-xs hover:bg-slate-700 hover:text-white transition"
              >
                Close Picker
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Partial Quantity Selection Modal */}
      {showQuantityModal && quantityAsset && (() => {
        const isConsumableAsset = quantityAsset.type === AssetCategory.CONSUMABLES;
        const currentReqQty = isConsumableAsset
          ? Number(conferenceFormData.consumable_data?.[String(quantityAsset.id)]?.requested || 0)
          : 0;
        const effectiveMax = isConsumableAsset
          ? Math.max(0, consumableLimit(quantityAsset, conferenceFormData.consumable_ledger?.[String(quantityAsset.id)]) - currentReqQty)
          : quantityLimit(quantityAsset, conferenceFormData, quantityAction);

        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl animate-in fade-in duration-300"></div>
            <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
              <div className="p-8 border-b border-slate-800 bg-slate-950/30 flex justify-between items-center">
                <div>
                  <h3 className="text-2xl font-black text-white uppercase tracking-tighter">Select Quantity</h3>
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">
                    Item: <span className="text-amber-500">{quantityAsset.aliasName || quantityAsset.sku}</span>
                  </p>
                </div>
                <button onClick={() => setShowQuantityModal(false)} className="w-10 h-10 flex items-center justify-center rounded-xl bg-slate-800 text-slate-400 hover:text-white transition">
                  <i aria-hidden="true" className="fa-solid fa-times text-xl"></i>
                </button>
              </div>

              <div className="p-10 space-y-10">
                <div className="bg-slate-950/50 p-8 rounded-3xl border border-slate-800 text-center space-y-2">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{isConsumableAsset ? 'Available to Request' : `${quantityAction.replace('_', ' ')} units available`}</p>
                  <p className="text-6xl font-black text-amber-400 tracking-widest">{effectiveMax}</p>
                  {isConsumableAsset && currentReqQty > 0 && (
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                      (Total Stock: {quantityAsset.quantity} • Already Requested: {currentReqQty})
                    </p>
                  )}
                </div>

                <div className="space-y-6">
                  <div className="flex justify-between items-center">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Quantity</label>
                    <span className="px-4 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-full text-[10px] font-black uppercase">
                      Stock Assignment
                    </span>
                  </div>

                  <div className="flex items-center gap-6">
                    <button
                      type="button"
                      onClick={() => setSelectedQuantity(Math.max(1, selectedQuantity - 1))}
                      className="w-20 h-20 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-white rounded-2xl border border-slate-700 transition text-2xl"
                    >
                      <i aria-hidden="true" className="fa-solid fa-minus"></i>
                    </button>

                    <input
                      type="number"
                      min="1"
                      max={effectiveMax}
                      value={selectedQuantity > effectiveMax ? (effectiveMax > 0 ? effectiveMax : 1) : selectedQuantity}
                      onChange={(e) => setSelectedQuantity(Math.min(effectiveMax, Math.max(1, parseInt(e.target.value) || 1)))}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-3xl p-6 text-center text-4xl font-black text-white outline-none focus:border-amber-500 transition"
                    />

                    <button
                      type="button"
                      onClick={() => setSelectedQuantity(Math.min(effectiveMax, selectedQuantity + 1))}
                      className="w-20 h-20 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-white rounded-2xl border border-slate-700 transition text-2xl"
                    >
                      <i aria-hidden="true" className="fa-solid fa-plus"></i>
                    </button>
                  </div>
                </div>

                <div className="flex gap-4 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowQuantityModal(false)}
                    className="flex-1 py-5 bg-slate-800 text-slate-400 rounded-2xl font-black uppercase text-[10px] hover:bg-slate-700 hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitQuantityAssignment}
                    disabled={quantitySaving || consumableSaving || effectiveMax <= 0 || pendingMovementCount > 0}
                    className="flex-[2] py-5 bg-amber-500 text-white rounded-2xl font-black uppercase text-[10px] hover:bg-amber-400 transition shadow-lg shadow-amber-500/20"
                  >
                    {quantitySaving ? 'Saving' : isConsumableAsset ? 'Add' : quantityAction.replace('_', ' ')} <span className="mx-1 opacity-50">•</span> {Math.min(selectedQuantity, effectiveMax)} {Math.min(selectedQuantity, effectiveMax) === 1 ? 'Unit' : 'Units'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Executive AI Assistant (Admin & Boss Only) */}
      <AIChatbotModal apiFetch={apiFetch} user={user} />

      <style>{`
        .form-input-night { width: 100%; background: #0f172a; border: 1px solid #1e293b; border-radius: 1rem; padding: 1.25rem; color: #fff; font-weight: 900; text-transform: uppercase; outline: none; transition: border-color 0.2s; }
        .form-input-night:focus { border-color: #0ea5e9; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #020617; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #334155; }
        .scroll-smooth { scroll-behavior: smooth; }

        @media print {
          @page { margin: 0; size: auto; }
          
          /* CRITICAL: Force white background on everything effectively disabling dark mode for print */
          :root, body, html, #root, main, .min-h-screen, .bg-slate-900, .bg-slate-950 {
             background-color: white !important;
             background: white !important;
             color: black !important;
             height: auto !important;
             overflow: visible !important;
          }

          /* Hide UI elements */
          .no-print, aside, nav, button, .form-input-night { 
            display: none !important; 
          }

          /* Position Challan Container */
          .challan-container {
             position: absolute;
             top: 0;
             left: 0;
             width: 100%;
             margin: 0;
             padding: 0;
             background: white !important;
             color: black !important;
             z-index: 9999;
             box-shadow: none !important;
             border: none !important;
          }
           
          /* Force text color reset */
          * {
            color: black !important;
            text-shadow: none !important;
            box-shadow: none !important;
          }

          /* Force headers to be white */
          .challan-header-target th, .challan-header-target th * {
            color: white !important;
          }
        }
      `}</style>
    </div >
  );
};

export default App;
