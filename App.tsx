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
  SubrentalTicketItem
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

const ScanPrompt: React.FC<{ title?: string, subtitle?: string }> = ({
  title = "Ready to Scan",
  subtitle = "Type a SKU or scan a QR code to see results"
}) => (
  <div className="col-span-full py-32 flex flex-col items-center justify-center text-center space-y-6 animate-in fade-in zoom-in duration-700">
    <div className="relative">
      <div className="absolute inset-0 bg-sky-500/20 blur-3xl rounded-full scale-150 animate-pulse"></div>
      <div className="relative w-24 h-24 bg-gradient-to-br from-sky-500 to-blue-600 rounded-3xl flex items-center justify-center text-white text-4xl shadow-2xl shadow-sky-500/20 ring-4 ring-white">
        <i className="fa-solid fa-qrcode animate-bounce"></i>
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
import { useRegisterSW } from 'virtual:pwa-register/react';
import { QRLabelModal } from './components/QRLabelModal';
import jsPDF from 'jspdf';

type Page = 'Dashboard' | 'Assets' | 'Employees' | 'Conferences' | 'Billing' | 'Reports' | 'Settings' | 'Subrentals';
type AssetView = 'List' | 'Form' | 'Details';
type EmployeeView = 'List' | 'Form';
type ConferenceView = 'List' | 'Form' | 'Details';

const GlobalQRPreview: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, GLOBAL_CONSUMABLES_SKU, {
        width: 120,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(console.error);
    }
  }, []);
  return <canvas ref={canvasRef} className="rounded-lg shadow-md" style={{ width: '60px', height: '60px' }} />;
};

const App: React.FC = () => {
  const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
    ? 'http://127.0.0.1:8000' 
    : window.location.origin;

  const showUnknownError = true;
  const isMobilePhone = useMemo(() => {
    const ua = navigator.userAgent;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isPDA = /Zebra|TC21|TC26|MC33|MC93|Scanner|Honeywell|Datalogic/i.test(ua);
    return isMobile && !isPDA;
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
  const [ticketItemSearch, setTicketItemSearch] = useState('');
  const [editingTicketItem, setEditingTicketItem] = useState<any>(null);
  const [bookings, setBookings] = useState<Booking[]>(MOCK_BOOKINGS);
  const [clients] = useState<Client[]>(MOCK_CLIENTS);
  const [challans, setChallans] = useState<DeliveryChallanRecord[]>([]);
  const [showScanner, setShowScanner] = useState(false);
  const [selectedBookingForChallan, setSelectedBookingForChallan] = useState<Booking | null>(null);
  const [selectedConferenceDetails, setSelectedConferenceDetails] = useState<Booking | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // PWA Update Logic
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      console.log('SW Registered: ' + r);
    },
    onRegisterError(error) {
      console.log('SW registration error', error);
    },
  });

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
          if (res.ok) {
            const profileData = await res.json();
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
          if (storedUser) setUser(JSON.parse(storedUser));
        });

      // Fetch company settings
      fetch(`${API_BASE}/api/company-settings/`, {
        headers: { 'Authorization': `Token ${token}` }
      })
        .then(res => res.json())
        .then(data => setCompanySettings(data))
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
    const headers: any = {
      ...options.headers,
    };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers['Authorization'] = `Token ${token}`;
    }

    try {
      const response = await fetch(url, { ...options, headers });
      if (response.status === 401) {
        handleLogout();
        return response;
      }
      return response;
    } catch (error) {
      console.error('API Fetch Error:', error);
      throw error;
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
  };

  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [employeeView, setEmployeeView] = useState<EmployeeView>('List');
  const [conferenceView, setConferenceView] = useState<ConferenceView>('List');
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
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeSearchQuery, setEmployeeSearchQuery] = useState('');
  const [backendConferences, setBackendConferences] = useState<Booking[]>([]);
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
  const [quantityAsset, setQuantityAsset] = useState<Asset | null>(null);
  const [selectedQuantity, setSelectedQuantity] = useState(1);

  // Global Consumables Picker State
  const [showConsumablesPicker, setShowConsumablesPicker] = useState(false);
  const [consumablesPickerSearchQuery, setConsumablesPickerSearchQuery] = useState('');

  const [quickSubAssetData, setQuickSubAssetData] = useState({ sku: '', serialNumber: '', type: 'Other', itemPrice: 0, generateQR: false });

  const [viewingAsset, setViewingAsset] = useState<Asset | null>(null);
  const [nextPageUrl, setNextPageUrl] = useState<string | null>(null);
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
    depreciationPercentage: 0,
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


  const fetchAssets = (search: string = ''): Promise<Asset[]> => {
    const url = `${API_BASE}/api/assets/?search=${encodeURIComponent(search)}&_t=${Date.now()}`;
    return apiFetch(url)
      .then(async res => {
        const data = await res.json();
        const results = data.results !== undefined ? data.results : data;
        
        if (!search && data.next !== undefined) {
          setNextPageUrl(data.next);
        } else if (search) {
          // Fresh search: always reset pagination anchor
          setNextPageUrl(data.next ?? null);
        }

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
            quantity: parseInt(asset.quantity, 10) || 1,
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
          // Always overwrite atomically — no blank flash
          setAssets(mappedAssets);
          return mappedAssets; // Return so callers can use fresh data immediately
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

  const loadMoreAssets = () => {
    if (!nextPageUrl) return;
    const secureUrl = nextPageUrl.replace('http://', 'https://');
    return apiFetch(secureUrl)
      .then(async res => {
        const data = await res.json();
        const results = data.results || data;

        if (data.next !== undefined) {
          setNextPageUrl(data.next);
        }

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
            quantity: parseInt(asset.quantity, 10) || 1,
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
      })
      .catch(err => console.error("Failed to load more assets:", err));
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

  const fetchSubrentalAssets = (companyId: string) => {
    apiFetch(`${API_BASE}/api/assets/?subrental_company_id=${companyId}`)
      .then(async res => {
        const data = await res.json();
        if (Array.isArray(data)) {
          const mapped = data.map((asset: any) => ({
            ...asset,
            id: asset.id.toString(),
            aliasName: asset.alias_name,
            serialNumber: asset.serial_number,
            quantity: parseInt(asset.quantity, 10) || 1,
            itemPrice: parseFloat(asset.item_price),
            purchasedDate: asset.purchased_date,
            flag: asset.flag || AssetFlag.NONE,
            isTemporary: asset.is_temporary
          }));
          setSubrentalAssets(mapped.filter((a: any) => !a.isTemporary));
        }
      })
      .catch(err => console.error("Failed to fetch subrental assets:", err));
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
    apiFetch(`${API_BASE}/api/subrental-tickets/?conference_id=${confId}&_t=${Date.now()}`)
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          setConfSubrentalTickets(mapTicketData(data));
        }
      })
      .catch(err => console.error("Failed to fetch conference subrental tickets:", err));
  };

  const fetchDashboardStats = () => {
    apiFetch(`${API_BASE}/api/asset-stats/`)
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          setDashboardStats(data);
        }
      })
      .catch(err => console.error("Failed to fetch dashboard stats:", err));
  };

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
  const fetchAllAssetsForScan = () => {
    apiFetch(`${API_BASE}/api/assets/?all=true`)
      .then(async res => {
        if (!res.ok) return;
        const data = await res.json();
        const results: any[] = Array.isArray(data) ? data : (data.results ?? []);
        allAssetsRef.current = results.map((asset: any) => ({
          ...asset,
          id: asset.id.toString(),
          aliasName: asset.alias_name,
          macAddress: asset.mac_address,
          imeiNumber1: asset.imei_number_1,
          imeiNumber2: asset.imei_number_2,
          serialNumber: asset.serial_number,
          isBarcodeAdded: asset.is_barcode_added,
          quantity: parseInt(asset.quantity, 10) || 1,
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
      })
      .catch(err => console.error('Scan index refresh failed:', err));
  };

  // Fetch data on load
  React.useEffect(() => {
    fetchAssets();
    fetchAllAssetsForScan(); // Build complete scan-index on mount
    fetchDashboardStats();
    fetchAliases();
    fetchEmployees();
    fetchSubrentalCompanies();

    // Refresh scan-index every 2 minutes silently in background
    const scanRefreshInterval = setInterval(fetchAllAssetsForScan, 120000);
    return () => clearInterval(scanRefreshInterval);
  }, []);

  const handleCreateSubrentalTicket = async () => {
    if (!selectedSubrentalCompany) return;
    
    let conferenceId = ticketFormData.conference_id;
    
    if (ticketFormData.is_custom) {
      if (!ticketFormData.custom_conference_name) return;
      const confRes = await apiFetch(`${API_BASE}/api/conferences/`, {
        method: 'POST',
        body: JSON.stringify({ 
          name: ticketFormData.custom_conference_name,
          start_date: ticketFormData.available_from || new Date().toISOString().split('T')[0]
        })
      });
      if (confRes.ok) {
        const confData = await confRes.json();
        conferenceId = confData.id;
        fetchConferences();
      } else {
        showScanToast("Failed to create custom conference", "error");
        return;
      }
    }

    if (!conferenceId) return;
    
    apiFetch(`${API_BASE}/api/subrental-tickets/`, {
      method: 'POST',
      body: JSON.stringify({
        company: selectedSubrentalCompany.id,
        conference: conferenceId,
        available_from: ticketFormData.available_from,
        available_till: ticketFormData.available_till
      })
    }).then(async res => {
      if (res.ok) {
        setIsTicketFormOpen(false);
        setTicketFormData({ conference_id: '', custom_conference_name: '', available_from: '', available_till: '', is_custom: false });
        fetchSubrentalTickets(selectedSubrentalCompany.id);
        showScanToast("Ticket Created Successfully", "success");
      }
    });
  };

  const handleAddTicketItem = () => {
    if (!selectedTicket) return;
    
    const url = editingTicketItem 
      ? `${API_BASE}/api/subrental-ticket-items/${editingTicketItem.id}/`
      : `${API_BASE}/api/subrental-tickets/${selectedTicket.id}/add-item/`;
    
    const method = editingTicketItem ? 'PATCH' : 'POST';

    apiFetch(url, {
      method: method,
      body: JSON.stringify(ticketItemForm)
    }).then(async res => {
      if (res.ok) {
        setIsAddingTicketItem(false);
        setEditingTicketItem(null);
        setTicketItemForm({ name: '', price: 0, depreciation: 0, quantity: 1, rental_price: 0, asset_id: '' });
        
        // Refresh selected ticket
        apiFetch(`${API_BASE}/api/subrental-tickets/${selectedTicket.id}/?_t=${Date.now()}`)
          .then(async r => {
            if (r.ok) {
              const updatedTicketData = await r.json();
              // Wrap in array for mapper, then take first
              const mapped = mapTicketData([updatedTicketData])[0];
              setSelectedTicket(mapped);
              fetchSubrentalTickets(selectedTicket.company);
              
              // Also refresh conference tickets if in a booking view
              if (selectedBookingForChallan) {
                fetchConferenceSubrentalTickets(selectedBookingForChallan.id);
              }
            }
          });
          
        showScanToast(editingTicketItem ? "Item Updated" : "Item Added to Ticket", "success");
      }
    });
  };

  const handleDeleteTicketItem = (itemId: string | number) => {
    if (!confirm("Are you sure you want to remove this item from the ticket?")) return;
    apiFetch(`${API_BASE}/api/subrental-ticket-items/${itemId}/`, { method: 'DELETE' })
      .then(res => {
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
      });
  };

  const handleEditTicketItem = (item: any) => {
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
    if (targetId) {
      fetchConferenceSubrentalTickets(targetId);
    } else if (!isPrintMode) {
      setConfSubrentalTickets([]);
    }
  }, [selectedBookingForChallan?.id, isPrintMode, printConfId]);

  // Performance optimizations: Debounced Search & Pagination
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  // Poll every 5 seconds to keep asset statuses in sync (reduced from 30s to prevent scanning conflicts)
  // BUG J-19: Do NOT re-fetch conferences while the user is in the conference form —
  // it causes a race condition that can overwrite unsaved staged asset state.
  React.useEffect(() => {
    const interval = setInterval(() => {
      if (!nextPageUrl && !debouncedSearchQuery) {
        fetchAssets();
      }
      fetchDashboardStats();
      if (conferenceView !== 'Form') {
        fetchConferences();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [conferenceView, nextPageUrl, debouncedSearchQuery]);


  const [inventoryCategoryFilter, setInventoryCategoryFilter] = useState<string>('All');
  const [inventoryPage, setInventoryPage] = useState(1);
  const itemsPerPage = 20; 

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
    setNextPageUrl(null);
    fetchAssets(debouncedSearchQuery);
  }, [debouncedSearchQuery]);
  // Compute filtered assets once
  const filteredInventoryAssets = useMemo(() => {
    const filtered = assets.filter(asset => {
      // Don't show ticket-only transient items in main inventory
      if (asset.isTemporary) return false;

      // Grouping Logic: Filter by UI Category
      if (inventoryCategoryFilter !== 'All') {
        const assetUICat = getUICategory(asset.type);
        if (assetUICat !== inventoryCategoryFilter) return false;
      }
      
      return true;
    });
    return filtered.sort((a, b) => {
      const nameA = (a.aliasName || a.sku || '').toLowerCase();
      const nameB = (b.aliasName || b.sku || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [assets, inventoryCategoryFilter]);
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
  // QR Label modal state
  const [qrTarget, setQrTarget] = useState<{ id?: string; sku: string; name: string } | null>(null);

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

  // SCAN INDEX: Complete asset list kept in a ref (no re-renders).
  // Used exclusively by findAssetFromScan so scanning works on ALL pages
  // regardless of which 50-item page is currently displayed in the inventory.
  const allAssetsRef = useRef<Asset[]>([]);

  // Diagnostic Logs
  const [systemLogs, setSystemLogs] = useState<string[]>([]);
  const addLog = (msg: string) => setSystemLogs(prev => [new Date().toLocaleTimeString() + ': ' + msg, ...prev].slice(0, 10));

  const handleSystemRecovery = async () => {
    if (!window.confirm("ARE YOU SURE? THIS WILL RUN DATABASE MIGRATIONS AND REPAIR CORE ASSET ASSIGNMENTS.")) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/system-recovery/`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || "System repair complete!");
        window.location.reload();
      } else {
        alert("Repair failed: " + (data.error || "Unknown error"));
      }
    } catch (e) {
      alert("Connection error during system repair.");
    }
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

  // Add fetchConferences to initial load
  useEffect(() => {
    fetchConferences();
  }, []);

  // --- CONFERENCE STATE & HANDLERS ---
  const [editingConference, setEditingConference] = useState<Booking | null>(null);
  const [expandedConferenceId, setExpandedConferenceId] = useState<string | number | null>(null);
  const [assetTab, setAssetTab] = useState<'available' | 'assigned' | 'packup' | 'crosscheck'>('available');
  const [conferenceSearchTerm, setConferenceSearchTerm] = useState("");
  const [conferenceStatusFilter, setConferenceStatusFilter] = useState("ALL");
  const loadCachedArray = (key: string) => {
    try {
      const cached = localStorage.getItem(key);
      return cached ? JSON.parse(cached) : [];
    } catch (e) {
      return [];
    }
  };

  const [conferenceFormData, setConferenceFormData] = useState<any>(() => ({
    name: '',
    association_name: '',
    billing_address: '',
    transport_address: '',
    gst_number: '',
    vehicle_number: '',
    driver_phone: '',
    contact_person: '',
    contact_phone: '',
    contact_email: '',
    start_date: '',
    end_date: '',
    conference_type: 'Medical Conference',
    requirements: loadCachedArray('techtrolley_requirements'),
    staged_assets: loadCachedArray('techtrolley_staged'),
    crosscheck_assets: loadCachedArray('techtrolley_crosscheck'),
    assets: loadCachedArray('techtrolley_assets'),
    assigned_employees: [],
    pdf_document: null
  }));

  // Session Lifeline for Scanner Arrays
  useEffect(() => {
    if (conferenceFormData.requirements) {
      localStorage.setItem('techtrolley_requirements', JSON.stringify(conferenceFormData.requirements));
    }
    if (conferenceFormData.staged_assets) {
      localStorage.setItem('techtrolley_staged', JSON.stringify(conferenceFormData.staged_assets));
    }
    if (conferenceFormData.crosscheck_assets) {
      localStorage.setItem('techtrolley_crosscheck', JSON.stringify(conferenceFormData.crosscheck_assets));
    }
    if (conferenceFormData.assets) {
      localStorage.setItem('techtrolley_assets', JSON.stringify(conferenceFormData.assets));
    }
  }, [
    conferenceFormData.requirements, 
    conferenceFormData.staged_assets, 
    conferenceFormData.crosscheck_assets, 
    conferenceFormData.assets
  ]);

  const fetchConferences = () => {
    return apiFetch(`${API_BASE}/api/conferences/?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          const mapped = data.map((c: any) => ({
            id: c.id.toString(),
            name: c.name, // Keep for legacy
            conferenceName: c.name,
            association: c.association_name, // Keep for legacy
            associationName: c.association_name,
            billingAddress: c.billing_address,
            transportAddress: c.transport_address,
            venue: c.transport_address, // Map transport to venue
            gstNumber: c.gst_number,
            vehicleNumber: c.vehicle_number,
            driverPhone: c.driver_phone,
            startDate: c.start_date,
            endDate: c.end_date,
            type: c.conference_type as any,
            conferenceType: c.conference_type as any,
            contactPerson: c.contact_person,
            contactPhone: c.contact_phone,
            contactEmail: c.contact_email,
            challanNumber: c.challan_number || (1000 + parseInt(c.id)).toString(),
            assets: (c.assets || []).map((id: any) => id.toString()),
            requirements: (c.requirements || []).map((id: any) => id.toString()),
            staged_assets: (c.staged_assets || []).map((id: any) => id.toString()),
            crosscheckAssets: (c.crosscheck_assets || []).map((id: any) => id.toString()),
            challanAssets: (c.challan_assets || []).map((id: any) => id.toString()),
            assigned_employees: (c.assigned_employees || []).map((id: any) => parseInt(id, 10)),
            pdf_document: c.pdf_document
          }));
          setBackendConferences(mapped);
          
          // CRITICAL FIX: Also refresh the active challan view if it matches an updated conference
          if (selectedBookingForChallan) {
            const updatedActive = mapped.find(b => b.id === selectedBookingForChallan.id);
            if (updatedActive) setSelectedBookingForChallan(updatedActive);
          }

          // If in print mode, set the selected booking immediately after fetching
          if (isPrintMode && printConfId) {
            const found = mapped.find((b: { id: string; }) => b.id === printConfId);
            if (found) {
              setSelectedBookingForChallan(found);
            }
          }
        } else {
          console.error("Failed to fetch conferences: Invalid data format", data);
          setBackendConferences([]);
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

  const handleChallanAssetUpdate = async (assetId: string, updates: Partial<Asset> & { alias_name?: string; item_price?: number; serial_number?: string }) => {
    // Optimistic Update so Challan View updates instantly without flashing old state
    setAssets(prev => prev.map(a => String(a.id) === String(assetId) ? { 
      ...a, 
      aliasName: updates.alias_name !== undefined ? updates.alias_name : a.aliasName,
      sku: updates.sku !== undefined ? updates.sku : a.sku,
      quantity: updates.quantity !== undefined ? updates.quantity : a.quantity,
      itemPrice: updates.item_price !== undefined ? updates.item_price : a.itemPrice,
      serialNumber: updates.serial_number !== undefined ? updates.serial_number : a.serialNumber
    } : a));

    try {
      const res = await apiFetch(`${API_BASE}/api/assets/${assetId}/`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        showScanToast(`✅ Asset Synchronized`, 'success');
        await fetchAssets();
      } else {
        const err = await res.json().catch(() => ({}));
        console.error("Challan asset update failed with status:", res.status, err);
        showScanToast(`❌ Asset update failed. See console.`, 'error');
        // Revert optimistic update
        await fetchAssets();
      }
    } catch (err) {
      console.error("Challan asset update network error", err);
      showScanToast(`❌ Network error saving asset`, 'error');
      await fetchAssets(); // Revert
    }
  };

  const handleAddAdhocChallanItem = async (item: Partial<Asset>) => {
    if (!selectedBookingForChallan) return;
    try {
      // 1. Create the asset
      const res = await apiFetch(`${API_BASE}/api/assets/`, {
        method: 'POST',
        body: JSON.stringify({
          ...item,
          status: 'Available', // Start as available, marking as 'In Use' happens via assignment
          is_temporary: true,
          condition: 'Good',
          purchased_date: new Date().toISOString().split('T')[0]
        })
      });
      
      if (res.ok) {
        const newAsset = await res.json();
        showScanToast(`✅ New Ad-hoc Asset Created: ${newAsset.sku}`, 'success');
        
        // 2. Assign to conference (only to challan_assets, not main assets)
        const currentChallanAssets = (selectedBookingForChallan.challanAssets || []).map(String);
        const updatedChallanAssets = Array.from(new Set([...currentChallanAssets, String(newAsset.id)]));
        
        const confRes = await apiFetch(`${API_BASE}/api/conferences/${selectedBookingForChallan.id}/`, {
          method: 'PATCH',
          body: JSON.stringify({
            challan_assets: updatedChallanAssets.map(id => parseInt(id, 10))
          })
        });

        if (confRes.ok) {
          showScanToast(`✅ Asset Assigned to Challan`, 'success');
          // Update local state to reflect change in ChallanView
          setSelectedBookingForChallan(prev => prev ? { ...prev, challanAssets: updatedChallanAssets } : null);
          await fetchAssets();
          await fetchConferences();
          return String(newAsset.id);
        }
      }
    } catch (err) {
      console.error("Failed to add ad-hoc item", err);
      showScanToast(`⚠️ Failed to create ad-hoc item`, 'error');
    }
  };
  
  const handleSaveFullChallan = async (conferenceId: string, assetIds: string[]) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/conferences/${conferenceId}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          challan_assets: assetIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id))
        })
      });
      if (res.ok) {
        showScanToast('✅ Challan State Frozen/Saved Successfully', 'success');
        fetchConferences();
      }
    } catch (err) {
      console.error("Failed to save full challan", err);
    }
  };

  const handleUpdateConferenceValue = async (conferenceId: string, value: number) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/conferences/${conferenceId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ approximate_value: value })
      });
      if (res.ok) {
        showScanToast(`✅ Goods Value Updated: ₹${value.toLocaleString()}`, 'success');
        fetchConferences();
        setSelectedBookingForChallan(prev => prev ? { ...prev, approximate_value: value } : null);
      }
    } catch (err) {
      console.error("Failed to update conference value", err);
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
      if (res.ok) {
        fetchSubrentalCompanies();
        showScanToast(`✅ Company Deleted`, 'success');
      }
    } catch (err) {
      console.error("Failed to delete company", err);
    }
  };

  const handleUpdateChallanNumber = async (conferenceId: string, challanNumber: string) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/conferences/${conferenceId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ challan_number: challanNumber })
      });
      if (res.ok) {
        showScanToast(`✅ Challan No Updated: ${challanNumber}`, 'success');
        fetchConferences();
        setSelectedBookingForChallan(prev => prev ? { ...prev, challanNumber: challanNumber } : null);
      }
    } catch (err) {
      console.error("Failed to update challan number", err);
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
          value.forEach((v: any) => body.append(key, v));
        } else if (value !== null && value !== undefined) {
          body.append(key, value);
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
          fetchConferences();
          fetchAssets();
          setConferenceView('List');
          setScanToast({ message: "Conference saved successfully!", type: 'success' });
          setPdfFile(null); // Clear pending file
          setEditingConference(null);
          setConferenceFormData({
            name: '', association_name: '', billing_address: '', transport_address: '', gst_number: '',
            vehicle_number: '', driver_phone: '',
            contact_person: '', contact_phone: '', contact_email: '', start_date: '', end_date: '', conference_type: 'Medical Conference', 
            assets: [], requirements: [], staged_assets: [], crosscheck_assets: [], assigned_employees: [], pdf_document: null
          });
          setPdfFile(null);
          setAssetTab((user?.role === 'technician' || user?.role === 'godown_incharge') ? 'assigned' : 'available'); // Smart default tab
        } else {
          const errData = await res.json().catch(() => ({}));
          alert(`Failed to save conference. Status: ${res.status}\n${JSON.stringify(errData)}`);
        }
      })
      .catch(err => alert(`Failed to connect to server: ${err}`));
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

  const handleUpdateLogistics = async () => {
    const { id, vehicle_number, driver_phone, assets: assetIds, requirements, crosscheck_assets, assigned_employees, staged_assets, pdf_document, ...restConferenceData } = conferenceFormData;
    
    if (!id) {
      handleSaveConference();
      return;
    }

    try {
      let body: any;
      if (pdfFile) {
        body = new FormData();
        body.append('vehicle_number', vehicle_number || '');
        body.append('driver_phone', driver_phone || '');
        body.append('pdf_document', pdfFile);
        
        // Append remaining core text fields so edits don't get lost
        Object.entries(restConferenceData).forEach(([k, v]) => {
          if (v !== undefined && v !== null) {
            body.append(k, typeof v === 'string' ? v : v.toString());
          }
        });

        // Append collections properly for FormData compatibility
        (assetIds || []).forEach((assetId: any) => body.append('assets', assetId));
        (requirements || []).forEach((reqId: any) => body.append('requirements', reqId));
        (crosscheck_assets || []).forEach((cId: any) => body.append('crosscheck_assets', cId));
        (assigned_employees || []).forEach((empId: any) => body.append('assigned_employees', empId));
      } else {
        body = JSON.stringify({
          ...restConferenceData,
          start_date: restConferenceData.start_date || null,
          end_date: restConferenceData.end_date || null,
          vehicle_number,
          driver_phone,
          assets: (assetIds || []).map((aid: any) => parseInt(aid, 10)).filter((aid: number) => !isNaN(aid)),
          requirements: (requirements || []).map((aid: any) => parseInt(aid, 10)).filter((aid: number) => !isNaN(aid)),
          crosscheck_assets: (crosscheck_assets || []).map((aid: any) => parseInt(aid, 10)).filter((aid: number) => !isNaN(aid)),
          assigned_employees: (assigned_employees || []).map((aid: any) => parseInt(aid, 10)).filter((aid: number) => !isNaN(aid))
        });
      }

      const res = await apiFetch(`${API_BASE}/api/conferences/${id}/`, {
        method: 'POST',
        body: body
      });
      if (res.ok) {
        const updatedData = await res.json();
        fetchConferences();
        setPdfFile(null); // Clear the pending file after successful upload
        // Update local state immediately to show the new link
        setConferenceFormData(prev => ({ ...prev, pdf_document: updatedData.pdf_document }));
        setScanToast({ message: "Conference state and logistics saved!", type: 'success' });
        alert("SAVE SUCCESSFUL: Assets and logistics are now synced with the server.");
      } else {
        const errData = await res.json().catch(() => ({}));
        console.error("Save Error Details:", errData);
        setScanToast({ message: `Failed to save: ${JSON.stringify(errData)}`, type: 'error' });
        alert(`SAVE FAILED: Status ${res.status}. Server Error: ${JSON.stringify(errData)}`);
      }
    } catch (err) {
      console.error("Conference Update Network Error:", err);
      alert(`NETWORK ERROR: Could not connect to backend. Details: ${err}`);
      setScanToast({ message: "Network error while saving", type: 'error' });
    }
  };

  const openNewConferenceForm = () => {
    fetchAssets();      // Always get fresh statuses before interacting with conference
    fetchConferences(); // Refresh backend conference data too
    setEditingConference(null);
    setAssetTab((user?.role === 'technician' || user?.role === 'godown_incharge') ? 'assigned' : 'available'); // Smart default tab
    setConferenceFormData({
      name: '', association_name: '', billing_address: '', transport_address: '', gst_number: '',
      vehicle_number: '', driver_phone: '',
      contact_person: '', contact_phone: '', contact_email: '', start_date: '', end_date: '', conference_type: 'Medical Conference',
      assets: [], requirements: [], staged_assets: [], crosscheck_assets: [], assigned_employees: [], pdf_document: null
    });
    setConferenceView('Form');
  };


  const openEditConferenceForm = (conf: any) => {
    fetchAssets();      // Always get fresh statuses before interacting with conference
    fetchConferences(); // Refresh backend conference data too
    fetchEmployees();   // Ensure technician names are loaded
    setEditingConference(conf);
    setAssetTab((user?.role === 'technician' || user?.role === 'godown_incharge') ? 'assigned' : 'available'); // Reset to default tab based on role
    setConferenceFormData({
      id: conf.id,
      name: conf.name,
      association_name: conf.association,
      billing_address: conf.billingAddress,
      transport_address: conf.transportAddress || '',
      gst_number: conf.gstNumber || '',
      vehicle_number: conf.vehicleNumber || '',
      driver_phone: conf.driverPhone || '',
      contact_person: conf.contactPerson || '',
      contact_phone: conf.contactPhone || '',
      contact_email: conf.contactEmail || '',
      start_date: conf.startDate,
      end_date: conf.endDate,
      conference_type: conf.type,
      assets: conf.assets || [],
      requirements: conf.requirements || [],
      // BUG J-5: Restore staged_assets from server so auto-saved staged items
      // are not lost when the form is opened or the page reloads.
      staged_assets: conf.staged_assets || [],
      crosscheck_assets: conf.crosscheckAssets || [],
      assigned_employees: conf.assigned_employees || [],
      pdf_document: conf.pdf_document
    });

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
    const total = assets.reduce((sum, a) => sum + Number(a.quantity || 1), 0);
    const inUse = assets.filter(a => a.status === AssetStatus.IN_USE || a.status === AssetStatus.CROSSCHECK).reduce((sum, a) => sum + Number(a.quantity || 1), 0);
    const available = assets.filter(a => a.status === AssetStatus.AVAILABLE).reduce((sum, a) => sum + Number(a.quantity || 1), 0);
    const damaged = assets.filter(a => a.status === AssetStatus.DAMAGED).reduce((sum, a) => sum + Number(a.quantity || 1), 0);
    return { total, inUse, available, damaged };
  }, [assets, dashboardStats]);

  // Bar Graph Data: Status Situation
  const statusData = useMemo(() => [
    { name: 'Available', value: stats.available, fill: '#10b981' },
    { name: 'In Use', value: stats.inUse, fill: '#f97316' },
    { name: 'Damaged', value: stats.damaged, fill: '#ef4444' }
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
    const scanned = (decodedText || '').trim();
    if (!scanned) return null;

    // Always search the COMPLETE scan-index (allAssetsRef) first — this contains
    // ALL assets regardless of which page is displayed in the inventory UI.
    // Fall back to the paginated `assets` state only if the index hasn't loaded yet.
    const searchPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;

    // A. FIRST: Check full string exact match (highest priority)
    const exactMatch = searchPool.find(a =>
      (a.sku && a.sku === scanned) ||
      (a.barcode && a.barcode === scanned) ||
      (a.qrCode && a.qrCode === scanned) ||
      (a.serialNumber && a.serialNumber === scanned) ||
      String(a.id) === scanned
    );
    if (exactMatch) return exactMatch;

    // B. SECOND: Check normalized full string
    const normScanned = normalizeId(scanned);
    const normMatch = searchPool.find(a =>
      normalizeId(a.sku) === normScanned ||
      normalizeId(a.barcode) === normScanned ||
      (a.qrCode && normalizeId(a.qrCode) === normScanned) ||
      normalizeId(a.serialNumber) === normScanned ||
      normalizeId(a.id) === normScanned
    );
    if (normMatch) return normMatch;

    // C. THIRD: Split logic for multipart scans (legacy/special)
    const scanParts = scanned.split(/[ ,;]+/).map(p => p.trim()).filter(Boolean);
    const normalizedParts = scanParts.map(p => normalizeId(p));

    const asset = searchPool.find(a => {
      const aSkuNorm = normalizeId(a.sku);
      const aBarcodeNorm = normalizeId(a.barcode);
      const aQrCodeNorm = a.qrCode ? normalizeId(a.qrCode) : '';
      const aSerialNorm = normalizeId(a.serialNumber);

      for (let i = 0; i < scanParts.length; i++) {
        const part = scanParts[i];
        const partNorm = normalizedParts[i];
        if (a.id === part || a.sku === part || a.barcode === part || (a.qrCode && a.qrCode === part) || a.serialNumber === part) return true;
        if (normalizeId(a.id) === partNorm || aSkuNorm === partNorm || aBarcodeNorm === partNorm || (aQrCodeNorm && aQrCodeNorm === partNorm) || aSerialNorm === partNorm) return true;
      }
      return false;
    });

    return asset || null;
  };

  const triggerAssetConferenceAction = (asset: Asset, action: 'add' | 'remove' | 'unassign', qty: number = 1) => {
    const assetIdStr = asset.id.toString();
    const existingAssets = conferenceFormData.assets.map((id: any) => id.toString());
    const crosscheckIds = new Set((conferenceFormData.crosscheck_assets || []).map((id: any) => id.toString()));
    const currentConfId = editingConference?.id ? String(editingConference.id) : null;

    if (action === 'add') {
      // LOCK 1: Already assigned to THIS conference
      if (existingAssets.includes(assetIdStr)) {
        // Optimization for Technician: Scrolling/Removing without switching tabs
        if (!user?.is_staff && user?.role !== 'godown_incharge') {
          if (confirm(`Asset "${asset.aliasName || asset.sku}" is already assigned. Move to Godown Crosscheck?`)) {
            triggerAssetConferenceAction(asset, 'remove');
          }
        } else {
          showScanToast(`⚠️ Already Assigned: "${asset.aliasName || asset.sku}" is already in this conference.`, 'warning');
        }
        return;
      }

      // LOCK 2: Asset is in Godown Crosscheck (returning from a conference, not yet verified)
      // Check BOTH local status AND backendConferences crosscheck data for reliability
      const isInCrosscheck = asset.status === AssetStatus.CROSSCHECK ||
        backendConferences.some(c => String(c.id) !== currentConfId && (c.crosscheckAssets || []).some(id => String(id) === assetIdStr));
      if (isInCrosscheck) {
        const confName = asset.current_conference_name ? ` (from ${asset.current_conference_name})` : '';
        showScanToast(`🔒 Locked — Crosscheck Pending: "${asset.aliasName || asset.sku}"${confName}. Godown Incharge must verify first.`, 'error');
        return;
      }

      // LOCK 3: Asset is In Use — check BOTH local status AND backendConferences assets data
      const isInUseElsewhere = asset.status === AssetStatus.IN_USE ||
        backendConferences.some(c => String(c.id) !== currentConfId && (c.assets || []).some(id => String(id) === assetIdStr));
      if (isInUseElsewhere) {
        const confName = asset.current_conference_name ? ` — locked by: ${asset.current_conference_name}` : '';
        showScanToast(`🔒 In Use: "${asset.aliasName || asset.sku}"${confName}. Cannot assign until released.`, 'error');
        return;
      }

      // LOCK 4: Asset is in Crosscheck queue of THIS conference already (pending move-back)
      if (crosscheckIds.has(assetIdStr)) {
        showScanToast(`⚠️ "${asset.aliasName || asset.sku}" is awaiting Godown Crosscheck for this conference. Verify it first.`, 'warning');
        return;
      }

      // Check for Consumables to show Quantity Modal
      if (asset.type === AssetCategory.CONSUMABLES && asset.status === AssetStatus.AVAILABLE) {
        setQuantityAsset(asset);
        setSelectedQuantity(asset.quantity);
        setShowQuantityModal(true);
        return;
      }

      if (asset.sub_assets && asset.sub_assets.length > 0) {
        setPendingParentAsset(asset);
        setPendingAction('add');
        setScannedSubAssetIds([]);
        showScanToast(`⚠️ Please scan ${asset.sub_assets.length} component(s) to add "${asset.aliasName || asset.sku}"`, 'warning');
      } else {
        if (user?.role === 'technician') {
          // Technician adds to REQUIREMENTS
          setConferenceFormData((prev: any) => ({
            ...prev,
            requirements: Array.from(new Set([...(prev.requirements || []), ...Array(qty).fill(assetIdStr)]))
          }));
          showScanToast(`📋 Requirement Added: ${qty}x "${asset.aliasName || asset.sku}"`, 'success');
        } else {
          // Admin/Godown: Items go to STAGED first in Requirements/Packing tab
          setConferenceFormData((prev: any) => {
            const updatedRequirements = (prev.requirements || []).filter((id: any) => id.toString() !== assetIdStr);
            // If we are in the 'assigned' (Requirements) tab, it stages. Otherwise (Select) it might go direct or stage.
            // Let's make it stage by default for consistency during packing.
            return {
              ...prev,
              staged_assets: Array.from(new Set([...(prev.staged_assets || []), assetIdStr])),
              requirements: updatedRequirements
            };
          });
          showScanToast(`📦 Staged for Packing: "${asset.aliasName || asset.sku}"`, 'success');
        }
      }
    } else if (action === 'remove') {
      if (!existingAssets.includes(assetIdStr)) {
        showScanToast(`⚠️ Not In Conference: "${asset.aliasName || asset.sku}" is not currently assigned to this conference.`, 'warning');
        return;
      }

      if (asset.sub_assets && asset.sub_assets.length > 0) {
        setPendingParentAsset(asset);
        setPendingAction('remove');
        setScannedSubAssetIds([]);
        showScanToast(`⚠️ Please scan ${asset.sub_assets.length} component(s) to remove "${asset.aliasName || asset.sku}"`, 'warning');
      } else {
        setConferenceFormData((prev: any) => ({
          ...prev,
          assets: prev.assets.filter((id: any) => id.toString() !== assetIdStr),
          crosscheck_assets: Array.from(new Set([...(prev.crosscheck_assets || []), assetIdStr]))
        }));
        showScanToast(`✅ Moved to Godown Crosscheck: "${asset.aliasName || asset.sku}"`, 'success');
      }
    } else if (action === 'unassign') {
      if (user?.role === 'technician') {
        // Technician removes from REQUIREMENTS
        setConferenceFormData((prev: any) => {
          const reqs = prev.requirements || [];
          const idx = reqs.findIndex((id: any) => id.toString() === assetIdStr);
          if (idx > -1) {
            const newReqs = [...reqs];
            newReqs.splice(idx, 1);
            return { ...prev, requirements: newReqs };
          }
          return prev;
        });
        showScanToast(`🗑️ Requirement Removed: "${asset.aliasName || asset.sku}"`, 'success');
      } else {
        // Admin/Godown unassigns from ACTUAL ASSETS or STAGED
        setConferenceFormData((prev: any) => ({
          ...prev,
          assets: prev.assets.filter((id: any) => id.toString() !== assetIdStr),
          staged_assets: (prev.staged_assets || []).filter((id: any) => id.toString() !== assetIdStr),
          crosscheck_assets: (prev.crosscheck_assets || []).filter((id: any) => id.toString() !== assetIdStr)
        }));
        showScanToast(`🗑️ Removed Accident: "${asset.aliasName || asset.sku}"`, 'success');
      }
    }

    // AUTO-SAVE to backend if we have a conference ID
    if (editingConference?.id) {
      setTimeout(() => {
        setConferenceFormData((current: any) => {
          const payload = {
            assets: (current.assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
            requirements: (current.requirements || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
            staged_assets: (current.staged_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
            crosscheck_assets: (current.crosscheck_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
          };
          apiFetch(`${API_BASE}/api/conferences/${editingConference.id}/`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
          }).then(res => {
            if (res.ok) fetchConferences();
          });
          return current;
        });
      }, 0);
    }
  };

  const verifyCrosscheckAsset = (asset: Asset) => {
    // Role Lock: Only Godown Incharge or Admin can verify
    if (user?.role !== 'godown_incharge' && !user?.is_staff) {
      showScanToast(`❌ Only Godown Incharge can verify assets in crosscheck.`, 'error');
      return;
    }

    const assetIdStr = asset.id.toString();
    const crosscheckIds = new Set((conferenceFormData.crosscheck_assets || []).map((id: any) => id.toString()));
    if (!crosscheckIds.has(assetIdStr)) {
      showScanToast(`❌ "${asset.aliasName || asset.sku}" is not in the Godown Crosscheck queue for this conference.`, 'error');
      return;
    }

    if (asset.sub_assets && asset.sub_assets.length > 0) {
      setPendingParentAsset(asset);
      setPendingAction('verify_crosscheck');
      setScannedSubAssetIds([]);
      showScanToast(`⚠️ Please scan ${asset.sub_assets.length} component(s) to verify "${asset.aliasName || asset.sku}"`, 'warning');
    } else {
      setConferenceFormData((prev: any) => ({
        ...prev,
        crosscheck_assets: (prev.crosscheck_assets || []).filter((id: any) => id.toString() !== assetIdStr)
      }));
      showScanToast(`✅ Verified locally: "${asset.aliasName || asset.sku}" (Click Submit to release)`, 'success');
    }
  };

  const submitQuantityAssignment = () => {
    if (!quantityAsset || !conferenceFormData.id) return;

    apiFetch(`${API_BASE}/api/assets/${quantityAsset.id}/assign-quantity/`, {
      method: 'POST',
      body: JSON.stringify({
        quantity: selectedQuantity,
        conference_id: conferenceFormData.id
      })
    })
      .then(async res => {
        const data = await res.json();
        if (res.ok) {
          const newAsset = data;
          showScanToast(`✅ Assigned ${selectedQuantity} unit(s) of "${quantityAsset.aliasName || quantityAsset.sku}"`, 'success');

          // Update current conference details so challan reflects it immediately
          if (selectedConferenceDetails && Number(selectedConferenceDetails.id) === Number(conferenceFormData.id)) {
            setSelectedConferenceDetails((prev: any) => prev ? {
              ...prev,
              assets: [...(prev.assets || []), newAsset.id.toString()]
            } : null);
          }

          // Also update conferenceFormData which is used for scanning list
          setConferenceFormData((prev: any) => ({
            ...prev,
            assets: [...(prev.assets || []), newAsset.id.toString()]
          }));

          // Instantly update local assets state for perfectly real-time feedback
          setAssets(prevAssets => {
            if (newAsset.id.toString() === quantityAsset.id) {
              return prevAssets.map(a => a.id.toString() === quantityAsset.id ? { ...a, ...newAsset, id: newAsset.id.toString(), quantity: selectedQuantity } : a);
            }
            const updated = prevAssets.map(a => {
              if (a.id.toString() === quantityAsset.id) {
                return { ...a, quantity: a.quantity - selectedQuantity };
              }
              return a;
            });
            return [...updated, {
              id: newAsset.id.toString(),
              sku: newAsset.sku,
              aliasName: newAsset.alias_name,
              serialNumber: newAsset.serial_number,
              type: newAsset.type,
              quantity: newAsset.quantity,
              status: newAsset.status,
              barcode: newAsset.barcode,
              qrCode: newAsset.qr_code,
              itemPrice: parseFloat(newAsset.item_price || '0'),
              depreciationPercentage: parseFloat(newAsset.depreciation_percentage || '0')
            } as Asset];
          });

          // FORCE SAVE CONFERENCE to ensure the new asset ID is persisted to this conference immediately
          const updatedAssetsList = [...(conferenceFormData.assets || []), newAsset.id.toString()];
          const payload = {
            ...conferenceFormData,
            start_date: conferenceFormData.start_date || null,
            end_date: conferenceFormData.end_date || null,
            assets: updatedAssetsList.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
            crosscheck_assets: (conferenceFormData.crosscheck_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id))
          };

          apiFetch(`${API_BASE}/api/conferences/${conferenceFormData.id}/`, {
            method: 'PUT',
            body: JSON.stringify(payload)
          }).then(confRes => {
            if (!confRes.ok) {
              console.error("Failed to automatically save conference after assigning partial quantity");
            }
          });

          fetchAssets(); // Refresh inventory
          fetchConferences(); // Refresh conferences list
          setShowQuantityModal(false);
        } else {
          showScanToast(`❌ ${data.error || 'Failed to assign quantity'}`, 'error');
        }
      })
      .catch(() => showScanToast('❌ Network error during quantity assignment', 'error'));
  };

  const handleScan = (decodedText: string, isAddingVal: boolean | null = null) => {
    // setShowScanner(false); // REMOVED: Allow continuous scanning
    const scanned = (decodedText || '').trim();
    if (!scanned) return;

    // 0. DEDUPLICATION (Safety for hardware scanners and continuous camera scanning)
    const now = Date.now();
    const upperScanned = scanned.toUpperCase();
    if (upperScanned === lastScannedCode.current.toUpperCase() && (now - lastScannedTime.current) < 2000) {
      console.log('Skipping duplicate scan within 2s window:', scanned);
      return;
    }
    lastScannedCode.current = upperScanned;
    lastScannedTime.current = now;

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

    const asset = findAssetFromScan(scanned);

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

            if (newScanned.length >= (pendingParentAsset.sub_assets?.length || 0)) {
              // All components scanned! Execute the action.
              const allIdsToProcess = [pendingParentAsset.id, ...(pendingParentAsset.sub_assets?.map(s => s.id.toString()) || [])];

              if (pendingAction === 'add') {
                if (user?.role === 'technician') {
                  setConferenceFormData((prev: any) => ({
                    ...prev,
                    requirements: Array.from(new Set([...(prev.requirements || []), ...allIdsToProcess]))
                  }));
                  showScanToast(`📋 Requirement Added: "${pendingParentAsset.aliasName || pendingParentAsset.sku}" and components`, 'success');
                } else {
                  // Admin/Godown: Move to STAGED and clear from requirements
                  setConferenceFormData((prev: any) => ({
                    ...prev,
                    staged_assets: Array.from(new Set([...(prev.staged_assets || []), ...allIdsToProcess.map(String)])),
                    requirements: (prev.requirements || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString()))
                  }));
                  showScanToast(`📦 Staged for Packing: "${pendingParentAsset.aliasName || pendingParentAsset.sku}" and components`, 'success');
                }
              } else if (pendingAction === 'remove') {
                setConferenceFormData((prev: any) => ({
                  ...prev,
                  assets: (prev.assets || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString())),
                  staged_assets: (prev.staged_assets || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString())),
                  crosscheck_assets: Array.from(new Set([...(prev.crosscheck_assets || []), ...allIdsToProcess.map(String)]))
                }));
                showScanToast(`✅ Moved "${pendingParentAsset.aliasName || pendingParentAsset.sku}" and components to Crosscheck`, 'success');
              } else if (pendingAction === 'verify_crosscheck') {
                setConferenceFormData((prev: any) => ({
                  ...prev,
                  crosscheck_assets: (prev.crosscheck_assets || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString()))
                }));
                showScanToast(`✅ Verified locally: "${pendingParentAsset.aliasName || pendingParentAsset.sku}" (Click Submit to release)`, 'success');
              }

              // Reset pending state
              setPendingParentAsset(null);
              setPendingAction(null);
              setScannedSubAssetIds([]);

              // AUTO-SAVE to backend
              if (editingConference?.id) {
                setTimeout(() => {
                  setConferenceFormData((current: any) => {
                    const payload = {
                      assets: (current.assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                      requirements: (current.requirements || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                      staged_assets: (current.staged_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                      crosscheck_assets: (current.crosscheck_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                    };
                    apiFetch(`${API_BASE}/api/conferences/${editingConference.id}/`, {
                      method: 'PATCH',
                      body: JSON.stringify(payload)
                    }).then(res => {
                      if (res.ok) fetchConferences();
                    });
                    return current;
                  });
                }, 0);
              }
            }
          } else {
            showScanToast(`⚠️ Component "${asset.aliasName || asset.sku}" already scanned.`, 'warning');
          }
        } else {
          showScanToast(`❌ "${asset.aliasName || asset.sku}" is not a required component`, 'error');
        }
        return;
      }

      const strId = String(asset.id);
      
      if (assetTab === 'packup') {
        if ((conferenceFormData.crosscheck_assets || []).some((id: any) => String(id) === strId)) {
          alert("This specific item has already been scanned/added!");
          setQuickAddInput('');
          setQuickRemoveInput('');
          return;
        }
        triggerAssetConferenceAction(asset, 'remove');
      } else if (assetTab === 'assigned') {
        const scanAction = (isAddingVal === true || user?.role === 'technician' || user?.role === 'godown_incharge') ? 'add' : 'remove';
        
        if (scanAction === 'add') {
          const isDuplicate = user?.role === 'technician' 
            ? (conferenceFormData.requirements || []).some((id: any) => String(id) === strId)
            : (conferenceFormData.staged_assets || []).some((id: any) => String(id) === strId);
            
          if (isDuplicate) {
            alert("This specific item has already been scanned/added!");
            setQuickAddInput('');
            setQuickRemoveInput('');
            return;
          }

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
                 // Fall through to triggerAssetConferenceAction
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
        if (user?.role === 'godown_incharge' || user?.is_staff) {
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
        if (res.ok || data.created !== undefined) {
          setUploadResult({ created: data.created ?? 0, skipped: data.skipped ?? 0, errors: data.errors ?? [] });
          setUploadFeedback({ type: 'success', text: 'Success: Inventory updated perfectly!' });
          setTimeout(() => setUploadFeedback(null), 5000);
          if (companyId) {
            fetchSubrentalAssets(companyId);
          } else {
            fetchAssets();
          }
        } else {
          setUploadResult({ created: 0, skipped: 0, errors: [data.error || 'Upload failed'] });
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
    apiFetch(`${API_BASE}/api/export-inventory/?type=${mode}&token=${encodeURIComponent(token || '')}`)
      .then(res => res.arrayBuffer())
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
    apiFetch(`${API_BASE}/api/download-template/?token=${encodeURIComponent(token || '')}`)
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

    const payload = {
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
      qr_code: isConsumable ? GLOBAL_CONSUMABLES_SKU : (assetFormData.qrCode || ''),
      flag: assetFormData.flag || '',
      quantity: assetFormData.quantity || 1,
      assigned_to: assetFormData.assigned_to,
      subrental_company: assetFormData.subrental_company
    };

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
          // J-94: Read the created/updated asset from the response and immediately
          // inject it into the shadow DB so the SKU auto-suggest is up-to-date
          // for the NEXT item without requiring a page refresh.
          const savedData = await res.json();

          // Mirror the exact mapping used in fetchAllAssetsForScan
          const mappedAsset: Asset = {
            ...savedData,
            id: savedData.id.toString(),
            aliasName: savedData.alias_name,
            macAddress: savedData.mac_address,
            imeiNumber1: savedData.imei_number_1,
            imeiNumber2: savedData.imei_number_2,
            serialNumber: savedData.serial_number,
            isBarcodeAdded: savedData.is_barcode_added,
            quantity: parseInt(savedData.quantity, 10) || 1,
            itemPrice: parseFloat(savedData.item_price),
            depreciationPercentage: parseFloat(savedData.depreciation_percentage),
            purchasedDate: savedData.purchased_date,
            availableFrom: savedData.available_from,
            availableTill: savedData.available_till,
            createdAt: savedData.created_at,
            barcode: savedData.barcode,
            barcodeType: savedData.barcode_type,
            qrCode: savedData.qr_code,
            lastMaintained: savedData.last_maintained,
            isTemporary: savedData.is_temporary,
            returnDate: savedData.return_date,
            flag: savedData.flag || AssetFlag.NONE,
            currentVenue: savedData.current_venue,
            assigned_to: savedData.assigned_to,
            assigned_to_name: savedData.assigned_to_name,
            parent_asset: savedData.parent_asset,
            current_conference_name: savedData.current_conference_name,
            sub_assets: savedData.sub_assets?.map((s: any) => ({ ...s, id: s.id.toString() }))
          };

          if (isNew) {
            // CREATE — prepend to both shadow DB and paginated state
            allAssetsRef.current = [mappedAsset, ...allAssetsRef.current];
            setAssets(prev => [mappedAsset, ...prev]);
          } else {
            // UPDATE — replace the stale entry in place
            allAssetsRef.current = allAssetsRef.current.map(a => a.id === mappedAsset.id ? mappedAsset : a);
            setAssets(prev => prev.map(a => a.id === mappedAsset.id ? mappedAsset : a));
          }

          // Background refetch keeps pagination counts accurate
          fetchAssets();
          handleViewChange('Assets', 'List');
          if ( (isNew || assetFormData.generateQR) && finalSku) {
            setQrTarget({ sku: finalSku as string, name: assetFormData.aliasName || finalSku as string });
          }
          setEditingAsset(null);
          setAssetFormData({ sku: '', aliasName: '', macAddress: '', imeiNumber1: '', imeiNumber2: '', serialNumber: '', description: '', isBarcodeAdded: false, type: AssetCategory.OTHER, purchasedDate: '', itemPrice: 0, depreciationPercentage: 0, availableFrom: '', available_till: '', status: AssetStatus.AVAILABLE, flag: AssetFlag.NONE, condition: 'Good', barcode: '', barcodeType: '', qrCode: '', quantity: 1, assigned_to: undefined, subrental_company: undefined, generateQR: false });
          
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
    if (!confirm("Are you sure you want to delete this asset?")) return;

    console.log("Attempting to delete asset with ID:", id);
    const url = `${API_BASE}/api/assets/${id}/`;
    console.log("DELETE URL:", url);

    apiFetch(url, {
      method: 'DELETE'
    })
      .then(async res => {
        if (res.ok) {
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
        alert(`Failed to connect to server for deletion: ${err.message}`);
      });
  };

  const openEditAssetForm = (asset: Asset) => {
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
      depreciationPercentage: 0,
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
      body: JSON.stringify(employeeFormData)
    })
      .then(async res => {
        if (res.ok) {
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
      <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex justify-between items-center">
          <h2 className="text-5xl font-black text-white uppercase tracking-tighter">Asset Details</h2>
          <button onClick={() => { handleViewChange('Assets', 'List'); setSearchQuery(''); }} className="px-6 py-3 bg-slate-800 text-white rounded-xl font-black uppercase text-xs hover:bg-slate-700 transition">Back to List</button>
        </div>

        <div className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-slate-800/50 space-y-8 shadow-2xl">
          <div className="flex items-start justify-between border-b border-slate-800/50 pb-8">
            <div className="min-w-0 flex-1">
              <h3 className="text-3xl font-black text-white uppercase truncate">{viewingAsset.aliasName || viewingAsset.sku}</h3>
              <p className="text-sky-400 font-mono text-sm mt-2">{viewingAsset.type}</p>
            </div>
            <div className="flex gap-4">
              <div className={`px-6 py-2 rounded-full font-black uppercase text-xs ${viewingAsset.isBarcodeAdded ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                Barcode: {viewingAsset.isBarcodeAdded ? 'Yes' : 'No'}
              </div>
              <div className={`px-6 py-2 rounded-full font-black uppercase text-xs ${viewingAsset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' :
                viewingAsset.status === AssetStatus.IN_USE ? 'bg-orange-500/10 text-orange-400' :
                  viewingAsset.status === AssetStatus.CROSSCHECK ? 'bg-indigo-500/10 text-indigo-400' :
                    'bg-red-500/10 text-red-400'}`}>
                {viewingAsset.status}
              </div>
            </div>
          </div>
          {viewingAsset.current_conference_name && (
            <div className="bg-orange-500/5 border border-orange-500/10 px-6 py-3 rounded-2xl flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <i className="fa-solid fa-calendar-check text-orange-400 text-xs"></i>
                <p className="text-[10px] font-black text-orange-400 uppercase tracking-widest">Currently at: {viewingAsset.current_conference_name}</p>
              </div>
              {viewingAsset.flag && (
                <div className="flex items-center gap-2 px-3 py-1 bg-red-500/20 rounded-lg">
                  <i className="fa-solid fa-flag text-red-500 text-[10px]"></i>
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 pb-8 border-b border-slate-800/50">
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
                <i className="fa-solid fa-clock-rotate-left text-slate-800 text-3xl mb-4"></i>
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
                    <i className="fa-solid fa-plus" /> New
                  </button>
                  <button onClick={() => setAddingSubAssetMode(true)} className="text-[10px] bg-sky-500/10 px-3 py-1.5 rounded-lg font-black uppercase tracking-wider text-sky-400 hover:bg-sky-500 hover:text-white transition flex items-center gap-1">
                    <i className="fa-solid fa-link" /> Link
                  </button>
                </div>
              )}
            </div>

            {creatingSubAssetMode && (
              <div className="bg-slate-950/50 p-6 rounded-2xl border border-emerald-500/30 mb-6 animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="flex justify-between items-center mb-4">
                  <p className="text-xs text-emerald-400 font-bold uppercase tracking-wider">Create & Link New Component</p>
                  <button onClick={() => setCreatingSubAssetMode(false)} className="text-slate-500 hover:text-white transition">
                    <i className="fa-solid fa-xmark text-lg" />
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
                      {quickSubAssetData.generateQR ? <><i className="fa-solid fa-check-circle mr-2"></i> Yes, Generate</> : <><i className="fa-solid fa-circle mr-2"></i> No, Skip</>}
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
                    <i className="fa-solid fa-xmark text-lg" />
                  </button>
                </div>

                <div className="relative mb-4">
                  <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
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
                        {selectedSubAssetToLink?.id === a.id && <i className="fa-solid fa-circle-check text-sky-500"></i>}
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
                        <i className="fa-solid fa-microchip text-xs" />
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
                      <i className="fa-solid fa-link-slash" />
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
                onClick={() => viewingAsset.sku && setQrTarget({ sku: viewingAsset.sku, name: viewingAsset.aliasName || viewingAsset.sku })}
                className="flex-1 py-5 bg-violet-500/10 text-violet-400 border border-violet-500/20 rounded-xl font-black uppercase text-xs hover:bg-violet-500 hover:text-white transition flex items-center justify-center gap-2"
              >
                <i className="fa-solid fa-qrcode" /> Print QR
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
    let list = backendConferences;
    if (!user?.is_staff && user?.role !== 'godown_incharge') {
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

    if (conferenceStatusFilter !== 'ALL') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      list = list.filter(c => {
        const start = new Date(c.startDate);
        const end = new Date(c.endDate);
        if (conferenceStatusFilter === 'UPCOMING') return today < start;
        if (conferenceStatusFilter === 'COMPLETED') return today > end;
        return today >= start && today <= end;
      });
    }

    return list.sort((a, b) => Number(b.id) - Number(a.id));
  }, [backendConferences, user, conferenceSearchTerm, conferenceStatusFilter]);

  const renderDashboard = () => (
    <div className="space-y-12 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          {!user?.is_staff && (
            <div className="inline-flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 px-4 py-2 rounded-full mb-4 w-fit">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
              </span>
              <p className="text-[9px] font-black text-orange-400 uppercase tracking-widest">Employee Portal • Assigned Views</p>
            </div>
          )}
          <h2 className="text-6xl font-black text-orange-500 uppercase tracking-tighter shrink-0 mb-6">
            Dashboard
          </h2>
          {user?.is_staff && (
            <div className="flex flex-wrap items-center gap-4 mb-8 bg-sky-500/10 border border-sky-500/20 p-6 rounded-[1.5rem] backdrop-blur-md">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-sky-500/20 flex items-center justify-center text-sky-400">
                  <i className="fa-solid fa-database" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">System Audit Log</p>
                  <p className="text-xs font-bold text-sky-400 uppercase">
                    {backendConferences.length} Total Conferences • {assets.length} Assets in DB • {stats.total} Total Quantity
                  </p>
                </div>
              </div>
              <div className="ml-auto">
                <button
                  onClick={handleSystemRecovery}
                  className="px-6 py-3 bg-orange-500 text-white rounded-xl font-black uppercase text-[10px] hover:bg-orange-400 transition shadow-lg shadow-orange-500/20 flex items-center gap-2"
                >
                  <i className="fa-solid fa-wrench" /> Repair & Recover Assets
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


      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { key: 'total_assets', label: companySettings?.dashboard_config?.total_assets_label || 'Total Assets', val: stats.total, icon: 'fa-boxes-stacked', color: 'text-sky-400' },
          { key: 'in_use', label: companySettings?.dashboard_config?.in_use_label || 'Currently In Use', val: stats.inUse, icon: 'fa-truck-fast', color: 'text-orange-400' },
          { key: 'available', label: companySettings?.dashboard_config?.available_label || 'Ready / Available', val: stats.available, icon: 'fa-warehouse', color: 'text-emerald-400' },
          { key: 'active_conferences', label: companySettings?.dashboard_config?.active_conferences_label || 'Active Conferences', val: activeConferencesCount, icon: 'fa-calendar-check', color: 'text-violet-400' }
        ].filter(item => isEditingDashboard || companySettings?.dashboard_config?.[item.key] !== false).map((item, i) => (
          <div key={i} className={`bg-slate-900/40 backdrop-blur-xl p-8 rounded-[2rem] border border-slate-800/60 shadow-xl relative group ${isEditingDashboard && companySettings?.dashboard_config?.[item.key] === false ? 'opacity-40 grayscale' : ''}`}>
            {isEditingDashboard && (
              <div className="absolute top-4 right-4 flex gap-2">
                <button
                  onClick={() => {
                    const nl = prompt("Enter new label for " + item.label, item.label);
                    if (nl) handleUpdateLabel(item.key, nl);
                  }}
                  className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
                  title="Edit Label"
                >
                  <i className="fa-solid fa-pen text-[10px]" />
                </button>
                <button
                  onClick={() => toggleCardVisibility(item.key)}
                  className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
                >
                  <i className={`fa-solid ${companySettings?.dashboard_config?.[item.key] === false ? 'fa-eye-slash' : 'fa-eye'} text-xs`} />
                </button>
              </div>
            )}
            <i className={`fa-solid ${item.icon} ${item.color} text-2xl mb-6`}></i>
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1">{item.label}</p>
            <h3 className="text-4xl font-black text-white">{item.val}</h3>
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
                <i className="fa-solid fa-pen text-[10px]" />
              </button>
              <button
                onClick={() => toggleCardVisibility('active_conferences_table')}
                className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
              >
                <i className={`fa-solid ${companySettings?.dashboard_config?.active_conferences_table === false ? 'fa-eye-slash' : 'fa-eye'} text-xs`} />
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
                  <tr key={conf.id} className="text-xs font-bold text-slate-300">
                    <td className="py-4 text-white uppercase">{conf.name}</td>
                    <td className="py-4 opacity-70 uppercase">{conf.association}</td>
                    <td className="py-4 font-mono text-sky-400">{new Date(conf.startDate).toLocaleDateString()} - {new Date(conf.endDate).toLocaleDateString()}</td>
                    <td className="py-4">
                      <span className="px-3 py-1 rounded-full text-[9px] font-black uppercase bg-violet-500/10 text-violet-400">Live</span>
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
                      <td colSpan={4} className="py-8 text-center text-slate-600 uppercase tracking-widest text-[10px]">No active conferences</td>
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
                <i className="fa-solid fa-pen text-[10px]" />
              </button>
              <button
                onClick={() => toggleCardVisibility('active_allocations_table')}
                className="w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center text-white hover:bg-sky-500 transition-colors z-10"
              >
                <i className={`fa-solid ${companySettings?.dashboard_config?.active_allocations_table === false ? 'fa-eye-slash' : 'fa-eye'} text-xs`} />
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/20">
                {assets.filter(a => a.assigned_to).map(asset => {
                  const emp = employees.find(e => e.id.toString() === asset.assigned_to?.toString());
                  return (
                    <tr key={asset.id} className="text-xs font-bold text-slate-300">
                      <td className="py-4 font-mono text-sky-400">{asset.aliasName || asset.sku} <span className="opacity-50">({asset.serialNumber})</span></td>
                      <td className="py-4 text-white uppercase">{emp?.name || 'Unknown'}</td>
                      <td className="py-4 opacity-70 uppercase">{emp?.department || '-'}</td>
                      <td className="py-4">
                        <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase ${asset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' :
                          asset.status === AssetStatus.IN_USE ? 'bg-orange-500/10 text-orange-400' : 'bg-red-500/10 text-red-400'
                          }`}>{asset.status}</span>
                      </td>
                    </tr>
                  );
                })}
                {assets.filter(a => a.assigned_to).length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-600 uppercase tracking-widest text-[10px]">No active allocations</td>
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
            accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
          />
          <button
            onClick={handleDownloadTemplate}
            className="flex-1 md:flex-none px-4 md:px-6 py-3 md:py-4 bg-slate-800/60 text-slate-300 border border-slate-700 rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-slate-700 transition flex items-center justify-center gap-2"
          >
            <i className="fa-solid fa-file-arrow-down" /> Template
          </button>
          <button
            onClick={() => { setUploadResult(null); fileInputRef.current?.click(); }}
            className="flex-1 md:flex-none px-4 md:px-6 py-3 md:py-4 bg-slate-800 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-slate-700 transition flex items-center justify-center gap-2"
          >
            <i className="fa-solid fa-file-csv" /> Import
          </button>
          <button
            onClick={() => handleExportInventory('master')}
            className="flex-1 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 hover:from-emerald-500/30 hover:to-teal-500/30 text-emerald-400 font-bold py-3 px-4 rounded-xl border border-emerald-500/20 hover:border-emerald-500/50 transition-all text-xs shadow-lg shadow-emerald-500/10 flex items-center justify-center gap-2 group whitespace-nowrap"
          >
            <i className="fa-solid fa-file-excel" /> Export Stocks
          </button>

          <button
            onClick={handleDownloadInventoryPDF}
            className="flex-1 md:flex-none px-4 md:px-6 py-3 md:py-4 bg-orange-600 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-orange-500 transition flex items-center justify-center gap-2 shadow-lg shadow-orange-500/20"
          >
            <i className="fa-solid fa-file-pdf" /> PDF
          </button>
          <div className="flex gap-2">
            <div className="relative" ref={registerDropdownRef}>
              <button
                onClick={() => setIsRegisterDropdownOpen(!isRegisterDropdownOpen)}
                className="px-4 md:px-6 py-3 md:py-4 bg-emerald-500 text-white rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs hover:bg-emerald-400 transition flex items-center gap-2"
              >
                Register New <i className={`fa-solid fa-chevron-${isRegisterDropdownOpen ? 'up' : 'down'} text-[8px]`} />
              </button>

              {isRegisterDropdownOpen && (
                <div className="absolute top-full right-0 mt-2 w-48 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                  <button
                    onClick={() => { openNewAssetForm(); setIsRegisterDropdownOpen(false); }}
                    className="w-full text-left px-6 py-4 text-xs font-black text-white uppercase hover:bg-slate-800 transition flex items-center gap-3"
                  >
                    <i className="fa-solid fa-plus-circle text-emerald-500" /> Standard Asset
                  </button>
                  <div className="h-[1px] bg-slate-800" />
                  <button
                    onClick={() => { openConsumableForm(); setIsRegisterDropdownOpen(false); }}
                    className="w-full text-left px-6 py-4 text-xs font-black text-white uppercase hover:bg-slate-800 transition flex items-center gap-3"
                  >
                    <i className="fa-solid fa-cubes text-amber-500" /> Consumable
                  </button>
                </div>
              )}
            </div>
          </div>
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
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
      )}
      <div className="bg-slate-900/30 rounded-[1.5rem] md:rounded-[2rem] border border-slate-800/50 overflow-hidden">
        <div className="p-4 md:p-8 border-b border-slate-800/40 flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative group">
            <i className="fa-solid fa-search absolute left-6 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-sky-500 transition-colors" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                const val = e.target.value;
                setSearchQuery(val);
                // PDA Auto-trigger: Detect full matches immediately
                const asset = findAssetFromScan(val);
                if (asset) handleScan(val);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const code = searchQuery.trim();
                  if (!code) return;
                  // allAssetsRef always has the full dataset — instant lookup, no fetch needed
                  handleScan(code);
                }
              }}
              placeholder="SEARCH OR SCAN EQUIPMENT..."
              ref={inventorySearchRef}
              className={`w-full pl-14 ${isMobilePhone ? 'pr-16' : 'pr-6'} py-4 md:py-5 rounded-2xl border border-slate-800 bg-slate-950/40 text-white font-black text-xs md:text-sm uppercase focus:border-sky-500/50 outline-none transition-all placeholder:text-slate-600`}
            />
            {isMobilePhone && (
              <button
                onClick={() => setShowScanner(true)}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 md:w-12 md:h-12 bg-sky-500/10 text-sky-400 rounded-xl flex items-center justify-center hover:bg-sky-500 hover:text-white transition group/btn"
              >
                <i className="fa-solid fa-camera text-sm md:text-base group-hover/btn:scale-110 transition-transform" />
              </button>
            )}
          </div>
          <div className="md:w-64">
            <select
              value={inventoryCategoryFilter}
              onChange={(e) => {
                setInventoryCategoryFilter(e.target.value);
                setInventoryPage(1);
              }}
              className="w-full h-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 md:py-0 text-white font-black text-xs uppercase outline-none focus:border-sky-500 transition-all cursor-pointer appearance-none"
              style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%2364748b\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'%3E%3C/path%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1.5rem center', backgroundSize: '1rem' }}
            >
              <option value="All">All Categories</option>
              {Object.values(UICategory).map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
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
                      <h4 className="text-base font-black text-white uppercase truncate flex-1">{asset.aliasName || 'Untitled Asset'}</h4>
                      {asset.sub_assets && asset.sub_assets.length > 0 && (
                        <span className="w-5 h-5 bg-sky-500/20 text-sky-400 rounded-lg flex items-center justify-center text-[8px]" title="Main Asset with Components">
                          <i className="fa-solid fa-boxes-stacked" />
                        </span>
                      )}
                      {asset.parent_asset && (
                        <span className="w-5 h-5 bg-emerald-500/20 text-emerald-400 rounded-lg flex items-center justify-center text-[8px]" title="Component / Sub-Asset">
                          <i className="fa-solid fa-link" />
                        </span>
                      )}
                      {asset.flag && asset.flag !== '' && (
                        <span className="w-5 h-5 bg-red-500/20 text-red-500 rounded-lg flex items-center justify-center text-[8px]" title={`Flagged: ${asset.flag}`}>
                          <i className="fa-solid fa-flag" />
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
                    {asset.current_conference_name && (
                      <span className="text-[7px] font-black text-orange-500/70 uppercase tracking-tighter truncate max-w-[80px]">
                        {asset.current_conference_name}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex justify-between items-center text-[10px]">
                  <p className="text-slate-500 font-bold uppercase">{asset.type}</p>
                  <div className="flex gap-4">
                    <button onClick={(e) => { e.stopPropagation(); openEditAssetForm(asset); }} className="text-sky-400"><i className="fa-solid fa-pen"></i></button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteAsset(asset.id); }} className="text-red-400"><i className="fa-solid fa-trash"></i></button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="py-20 text-center w-full">
              <i className="fa-solid fa-magnifying-glass text-4xl text-slate-800 mb-4 scale-x-[-1]"></i>
              <p className="text-xs font-black text-slate-600 uppercase tracking-widest">No assets found</p>
            </div>
          )}
        </div>
        <div className="hidden md:block overflow-x-auto custom-scrollbar">
          <table className="w-full text-left min-w-[1000px]">
            <thead className="bg-slate-950/40 text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
              <tr>
                <th className="px-6 py-6">SKU</th>
                <th className="px-6 py-6">Alias Name</th>
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
                          <p className="font-black text-white text-base uppercase truncate max-w-[200px]">{asset.aliasName || '-'}</p>
                          <p className="text-[9px] text-slate-500 font-black mt-1 uppercase truncate">MAC: {asset.macAddress || 'N/A'}</p>
                        </div>
                        {asset.sub_assets && asset.sub_assets.length > 0 && (
                          <div className="px-2 py-1 bg-sky-500/10 border border-sky-500/20 rounded-md flex items-center gap-1.5" title="Main Asset">
                            <i className="fa-solid fa-boxes-stacked text-[8px] text-sky-400" />
                            <span className="text-[8px] font-black text-sky-400 uppercase tracking-tighter">{asset.sub_assets.length}</span>
                          </div>
                        )}
                        {asset.parent_asset && (
                          <div className="px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-md flex items-center gap-1" title="Sub-Asset / Component">
                            <i className="fa-solid fa-link text-[8px] text-emerald-400" />
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
                      <p className="text-xs font-black text-white">{asset.quantity || 1}</p>
                    </td>
                    <td className="px-6 py-6 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <span className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase ${asset.status === AssetStatus.AVAILABLE ? 'bg-emerald-500/10 text-emerald-400' :
                          asset.status === AssetStatus.IN_USE ? 'bg-orange-500/10 text-orange-400' :
                            asset.status === AssetStatus.CROSSCHECK ? 'bg-indigo-500/10 text-indigo-400' :
                              'bg-red-500/10 text-red-400'
                          }`}>{asset.status}</span>
                        {asset.current_conference_name && (
                          <span className="text-[8px] font-black text-orange-500/70 uppercase tracking-tight">
                            {asset.current_conference_name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-6 text-right space-x-4">
                      <button onClick={() => openEditAssetForm(asset)} className="text-sky-400 hover:text-white"><i className="fa-solid fa-pen"></i></button>
                      <button onClick={() => handleDeleteAsset(asset.id)} className="text-red-400 hover:text-white"><i className="fa-solid fa-trash"></i></button>
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
        {totalInventoryPages > 1 && (
          <div className="p-6 border-t border-slate-800 bg-slate-950/20 flex items-center justify-between">
            <p className="text-[10px] font-black text-slate-500 uppercase">
              Showing {(inventoryPage - 1) * itemsPerPage + 1} to {Math.min(inventoryPage * itemsPerPage, filteredInventoryAssets.length)} of {filteredInventoryAssets.length}
            </p>
            <div className="flex gap-2">
              <button disabled={inventoryPage === 1} onClick={() => setInventoryPage(p => p - 1)} className="w-10 h-10 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 disabled:opacity-30 hover:text-white transition"><i className="fa-solid fa-chevron-left"></i></button>
              <button disabled={inventoryPage === totalInventoryPages} onClick={() => setInventoryPage(p => p + 1)} className="w-10 h-10 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 disabled:opacity-30 hover:text-white transition"><i className="fa-solid fa-chevron-right"></i></button>
            </div>
          </div>
        )}
        
        {nextPageUrl && (
          <div className="p-6 border-t border-slate-800 bg-slate-950/40 flex items-center justify-center">
            <button onClick={loadMoreAssets} className="px-8 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-black uppercase text-xs tracking-widest transition flex items-center gap-2">
              <i className="fa-solid fa-cloud-arrow-down" /> Load More Assets
            </button>
          </div>
        )}

      </div>
    </div>
  );

  const renderSubrentals = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
        <h2 className="text-4xl md:text-5xl font-black text-sky-500 tracking-tighter uppercase">Subrentals</h2>
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
                <i className="fa-solid fa-building"></i>
              </div>
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
                  <i className="fa-solid fa-pencil text-[10px]"></i>
                </button>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteSubrentalCompany(company.id);
                  }}
                  className="w-8 h-8 bg-slate-800 text-slate-400 rounded-lg flex items-center justify-center hover:text-red-400 transition"
                >
                  <i className="fa-solid fa-trash text-[10px]"></i>
                </button>
              </div>
            </div>
            <h3 className="text-xl font-black text-white uppercase mb-2 group-hover:text-sky-400 transition-colors">{company.name}</h3>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-4 line-clamp-1">{company.address || 'No Address'}</p>
            <div className="pt-4 border-t border-slate-800/60 flex items-center justify-between">
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">GST: {company.gst_number || 'N/A'}</span>
              <div className="flex items-center gap-1 text-sky-400">
                <span className="text-[9px] font-black uppercase tracking-tighter">View Inventory</span>
                <i className="fa-solid fa-chevron-right text-[8px]"></i>
              </div>
            </div>
          </div>
        ))}
        {subrentalCompanies.length === 0 && (
          <div className="col-span-full py-20 text-center border-2 border-dashed border-slate-800 rounded-[2rem]">
            <i className="fa-solid fa-building-circle-exclamation text-4xl text-slate-800 mb-4"></i>
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
              <i className="fa-solid fa-arrow-left"></i>
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
              <i className="fa-solid fa-boxes-stacked"></i> View Inventory
            </button>
            <button 
              onClick={() => setIsTicketFormOpen(true)}
              className="px-8 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition"
            >
              Create Ticket
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {subrentalTickets.map(ticket => (
            <div key={ticket.id} onClick={() => setSelectedTicket(ticket)} className="bg-slate-900/40 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-800/60 shadow-xl group hover:border-sky-500/30 transition-all cursor-pointer">
              <div className="flex justify-between items-start mb-6">
                <div className="w-14 h-14 bg-sky-500/10 rounded-2xl flex items-center justify-center text-sky-400 text-2xl border border-sky-500/20">
                  <i className="fa-solid fa-ticket"></i>
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
              <i className="fa-solid fa-ticket-simple text-4xl text-slate-800 mb-4"></i>
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
        <h3 className="text-3xl font-black text-white uppercase tracking-tighter mb-10">Create Rental Ticket</h3>
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
                value={ticketFormData.custom_conference_name}
                onChange={(e) => setTicketFormData({...ticketFormData, custom_conference_name: e.target.value})}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
              />
            ) : (
              <select 
                value={ticketFormData.conference_id}
                onChange={(e) => setTicketFormData({...ticketFormData, conference_id: e.target.value})}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all appearance-none"
              >
                <option value="">Select Conference</option>
                {backendConferences.filter(c => c.status !== 'Completed').map(c => (
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
          <button onClick={handleCreateSubrentalTicket} className="flex-1 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition">Create Ticket</button>
        </div>
      </div>
    </div>
  );

  const renderTicketItems = (ticket: SubrentalTicket) => {
    return (
      <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
          <div className="flex items-center gap-6">
            <button 
              onClick={() => setSelectedTicket(null)}
              className="w-12 h-12 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center text-slate-400 hover:text-white transition"
            >
              <i className="fa-solid fa-arrow-left"></i>
            </button>
            <div>
              <h2 className="text-4xl md:text-5xl font-black text-white tracking-tighter uppercase">{ticket.conference_name}</h2>
              <p className="text-[10px] text-sky-400 font-bold uppercase tracking-[0.2em] mt-1">Ticket #{ticket.id} • {selectedSubrentalCompany?.name}</p>
            </div>
          </div>
          <button 
            onClick={() => setIsAddingTicketItem(true)}
            className="px-8 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition"
          >
            Add Items
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-4">
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
                  <div className="flex flex-col gap-2 ml-6 pl-6 border-l border-slate-800/60">
                    <button 
                      onClick={() => handleEditTicketItem(item)}
                      className="w-8 h-8 bg-slate-800 rounded-lg flex items-center justify-center text-slate-400 hover:text-sky-400 transition"
                      title="Edit Item"
                    >
                      <i className="fa-solid fa-pen-to-square text-[10px]"></i>
                    </button>
                    <button 
                      onClick={() => handleDeleteTicketItem(item.id)}
                      className="w-8 h-8 bg-slate-800 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-400 transition"
                      title="Remove Item"
                    >
                      <i className="fa-solid fa-trash text-[10px]"></i>
                    </button>
                  </div>
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
                    <i className="fa-solid fa-calendar-check"></i>
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
              <div className="p-10 overflow-y-auto custom-scrollbar">
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
                              {ticketItemForm.asset_id === a.id && <i className="fa-solid fa-check-circle"></i>}
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
                          value={ticketItemForm.name}
                          onChange={(e) => setTicketItemForm({...ticketItemForm, name: e.target.value})}
                          className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Cost Price (Optional)</label>
                        <input 
                          type="number" 
                          value={ticketItemForm.price}
                          onChange={(e) => setTicketItemForm({...ticketItemForm, price: parseFloat(e.target.value)})}
                          className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Depreciation %</label>
                        <input 
                          type="number" 
                          value={ticketItemForm.depreciation}
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
                        value={ticketItemForm.rental_price}
                        onChange={(e) => setTicketItemForm({...ticketItemForm, rental_price: parseFloat(e.target.value)})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Quantity</label>
                      <input 
                        type="number" 
                        value={ticketItemForm.quantity}
                        onChange={(e) => setTicketItemForm({...ticketItemForm, quantity: parseInt(e.target.value)})}
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
                  <button onClick={handleAddTicketItem} className="flex-1 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition">Add Item to Ticket</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSubrentalInventory = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
        <div className="flex items-center gap-6">
          <button 
            onClick={() => {
              if (showSubrentalInventory) setShowSubrentalInventory(false);
              else setSelectedSubrentalCompany(null);
            }}
            className="w-12 h-12 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <i className="fa-solid fa-arrow-left"></i>
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
            <i className="fa-solid fa-download"></i> Template
          </button>
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="px-6 py-4 bg-amber-500 text-white rounded-2xl font-black uppercase text-[10px] hover:bg-amber-400 transition flex items-center gap-2"
          >
            <i className="fa-solid fa-file-import"></i> Bulk Import
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={(e) => handleFileUpload(e, selectedSubrentalCompany.id)} 
            className="hidden" 
            accept=".xlsx"
          />
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
        <div className="relative flex-1">
          <i className="fa-solid fa-magnifying-glass absolute left-6 top-1/2 -translate-y-1/2 text-slate-500"></i>
          <input 
            type="text"
            placeholder="Search Subrental Inventory (SKU, Name, Serial)..."
            value={subrentalSearchQuery}
            onChange={(e) => setSubrentalSearchQuery(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-2xl pl-16 pr-8 py-4 text-white font-black text-xs uppercase focus:border-sky-500 outline-none transition-all"
          />
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
                         <button onClick={() => {
                           setEditingAsset(asset);
                           setAssetFormData({ ...asset, subrental_company: selectedSubrentalCompany.id });
                           setAssetView('Form');
                           setCurrentPage('Assets');
                         }} className="text-sky-400"><i className="fa-solid fa-pen"></i></button>
                         <button onClick={() => setQrTarget({ sku: asset.sku, name: asset.aliasName || asset.sku })} className="text-emerald-400">
                           <i className="fa-solid fa-qrcode"></i>
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
            className="w-full px-4 md:px-6 py-3 md:py-4 rounded-xl border border-slate-800 bg-slate-950/40 text-white font-black text-[10px] md:text-xs uppercase"
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
                    <button onClick={() => openEditEmployeeForm(emp)} className="text-sky-400 hover:text-white"><i className="fa-solid fa-pen"></i></button>
                    <button onClick={() => handleDeleteEmployee(emp.id)} className="text-red-400 hover:text-white"><i className="fa-solid fa-trash"></i></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const handlePrintChallan = (conf: Booking | null) => {
    // BUG J-1: Guard against null conference (e.g. unsaved editing state)
    if (!conf) {
      alert('Please save the conference first before printing the challan.');
      return;
    }
    // Store locally to persist exact current state across the new tab boundary
    localStorage.setItem('print_conf_data', JSON.stringify(conf));
    const challanPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
    const relevantAssets = challanPool.filter(a => {
      const historicalList = (conf.challanAssets && conf.challanAssets.length > 0) 
                             ? conf.challanAssets 
                             : [...(conf.assets || []), ...(conf.staged_assets || [])];
      return historicalList.map(String).includes(String(a.id));
    });
    localStorage.setItem('print_assets_data', JSON.stringify(relevantAssets));

    // Open in new tab
    const url = `${window.location.protocol}//${window.location.host}${window.location.pathname}?print=true&confId=${conf.id}`;
    window.open(url, '_blank');
  };

  const renderChallanList = () => {
    // Sort challans by number descending
    const sortedChallans = [...filteredConferences]
      .filter(conf => !challanSearchQuery ||
        (conf.challanNumber && conf.challanNumber.toString().toLowerCase().includes(challanSearchQuery.toLowerCase())) ||
        (conf.conferenceName && conf.conferenceName.toLowerCase().includes(challanSearchQuery.toLowerCase())) ||
        (conf.associationName && conf.associationName.toLowerCase().includes(challanSearchQuery.toLowerCase()))
      )
      // BUG J-29: parseInt can return NaN for empty challanNumber; use fallback '0'
      .sort((a, b) =>
        parseInt(b.challanNumber || '0') - parseInt(a.challanNumber || '0')
      );

    return (
      <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
          <h2 className="text-4xl md:text-5xl font-black text-orange-500 tracking-tighter uppercase">Delivery Challans</h2>
        </div>
        <div className="bg-slate-900/30 rounded-[1.5rem] md:rounded-[2rem] border border-slate-800/50 overflow-hidden">
          <div className="p-4 md:p-8 border-b border-slate-800/40">
            <input
              type="text" value={challanSearchQuery} onChange={(e) => setChallanSearchQuery(e.target.value)}
              placeholder="Search challans..."
              className="w-full px-4 md:px-6 py-3 md:py-4 rounded-xl border border-slate-800 bg-slate-950/40 text-white font-black text-[10px] md:text-xs uppercase"
            />
          </div>
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left min-w-[1000px]">
              <thead className="bg-slate-950/40 text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
                <tr>
                  <th className="px-6 py-6">Challan #</th>
                  <th className="px-6 py-6">Date</th>
                  <th className="px-6 py-6">Conference</th>
                  <th className="px-6 py-6">Assets</th>
                  <th className="px-6 py-6 text-center">Status</th>
                  <th className="px-6 py-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/20">
                {sortedChallans.map((conf) => {
                  const historicalCount = (conf.challanAssets && conf.challanAssets.length > 0) 
                    ? conf.challanAssets.length 
                    : ((conf.assets?.length || 0) + (conf.staged_assets?.length || 0));
                  const hasAssets = historicalCount > 0;
                  
                  return (
                    <tr key={conf.id} className="hover:bg-slate-800/10 transition">
                      <td className="px-10 py-6">
                        <p className="font-black text-white text-base uppercase">#{conf.challanNumber}</p>
                      </td>
                      <td className="px-10 py-6">
                        <p className="text-xs text-slate-300 font-bold uppercase">{new Date().toLocaleDateString('en-GB')}</p>
                      </td>
                      <td className="px-10 py-6">
                        <p className="font-bold text-white text-xs uppercase">{conf.conferenceName}</p>
                        <p className="text-[10px] text-slate-500 uppercase mt-1">{conf.associationName}</p>
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
                      <td className="px-10 py-6 text-right space-x-4">
                        <button
                          onClick={() => { setSelectedBookingForChallan(conf); setChallanViewMode('Detail'); }}
                          className="text-sky-400 hover:text-white text-[10px] font-black uppercase tracking-widest"
                        >
                          <i className="fa-solid fa-eye mr-2"></i> View
                        </button>
                        <button
                          onClick={() => handlePrintChallan(conf)}
                          className="text-violet-400 hover:text-white text-[10px] font-black uppercase tracking-widest"
                        >
                          <i className="fa-solid fa-print mr-2"></i> Print
                        </button>
                        {(user?.is_staff || user?.role === 'admin') && (
                          <button
                            onClick={() => handleDeleteChallan(conf.id)}
                            className="text-red-400 hover:text-white text-[10px] font-black uppercase tracking-widest"
                            title="Delete Challan"
                          >
                            <i className="fa-solid fa-trash mr-2"></i> Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const renderConferences = () => (
    <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
      <div className="flex justify-between items-center">
        <h2 className="text-5xl font-black text-orange-500 tracking-tighter uppercase">Conferences</h2>
        {user?.is_staff && (
          <button onClick={openNewConferenceForm} className="w-full md:w-auto px-8 py-4 bg-violet-600 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-lg shadow-violet-500/20">Add Conference</button>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-4 bg-slate-900/30 p-4 rounded-3xl border border-slate-800/50">
         <input
            type="text"
            value={conferenceSearchTerm}
            onChange={(e) => setConferenceSearchTerm(e.target.value)}
            placeholder="Search conference name or venue..."
            className="flex-1 bg-slate-950/50 border border-slate-800 rounded-2xl px-6 py-4 text-white font-bold placeholder-slate-500 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
         />
         <select
            value={conferenceStatusFilter}
            onChange={(e) => setConferenceStatusFilter(e.target.value)}
            className="md:w-64 bg-slate-950/50 border border-slate-800 rounded-2xl px-6 py-4 text-white font-bold focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
         >
            <option value="ALL">All Statuses</option>
            <option value="UPCOMING">Upcoming</option>
            <option value="ONGOING">Ongoing</option>
            <option value="COMPLETED">Completed</option>
         </select>
      </div>

      {/* Mobile Card View for Conferences */}
      <div className="md:hidden space-y-4">
        {filteredConferences.map((conf) => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const start = new Date(conf.startDate);
          const end = new Date(conf.endDate);
          let statusLabel = 'Ongoing';
          let statusStyle = 'bg-emerald-500/10 text-emerald-400';
          if (today < start) { statusLabel = 'Upcoming'; statusStyle = 'bg-blue-500/10 text-blue-400'; }
          else if (today > end) { statusLabel = 'Ended'; statusStyle = 'bg-slate-800/50 text-slate-500'; }

          return (
            <div key={conf.id} onClick={() => openEditConferenceForm(conf)} className="bg-slate-900/30 border border-slate-800/50 rounded-2xl p-5 space-y-4 active:bg-slate-800/20 transition-colors">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="text-lg font-black text-white uppercase leading-tight">{conf.conferenceName || conf.name}</h4>
                  <p className="text-[10px] text-slate-500 font-black uppercase mt-1">{conf.association}</p>
                  {conf.pdf_document && (
                    <a
                      href={`${API_BASE}/api/conferences/${conf.id}/download-pdf/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-2 mt-3 px-3 py-1.5 bg-sky-500/10 text-sky-400 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-sky-500/20 transition-all border border-sky-500/10"
                    >
                      <i className="fa-solid fa-file-pdf"></i>
                      Download PDF
                    </a>
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
                  {user?.role !== 'godown_incharge' && (
                    <button onClick={(e) => { e.stopPropagation(); handlePrintChallan(conf); }} className="w-10 h-10 bg-emerald-500/10 text-emerald-400 rounded-xl flex items-center justify-center"><i className="fa-solid fa-print"></i></button>
                  )}
                  {user?.is_staff && (
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteConference(conf.id); }} className="w-10 h-10 bg-red-500/10 text-red-500 rounded-xl flex items-center justify-center"><i className="fa-solid fa-trash"></i></button>
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

              let status = 'Ongoing';
              let statusColor = 'bg-emerald-500/10 text-emerald-400 animate-pulse';

              if (today < start) {
                status = 'Upcoming';
                statusColor = 'bg-blue-500/10 text-blue-400';
              } else if (today > end) {
                status = 'Ended';
                statusColor = 'bg-slate-800/50 text-slate-500';
              }

              return (
                <tr key={conf.id} className="hover:bg-slate-800/10 transition">
                  <td className="px-10 py-6 min-w-0">
                    <p className="font-black text-white text-base uppercase truncate max-w-xs">{conf.conferenceName || conf.name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <p className="text-[9px] text-slate-500 font-black uppercase">ID: {conf.id}</p>
                      {conf.pdf_document && (
                        <a
                          href={`${API_BASE}/api/conferences/${conf.id}/download-pdf/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1.5 px-2 py-1 bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-md hover:bg-sky-500 hover:text-white transition-all group/pdf"
                          title="Download Logistics PDF"
                        >
                          <i className="fa-solid fa-file-pdf text-[10px] group-hover/pdf:scale-110"></i>
                          <span className="text-[9px] font-black uppercase tracking-widest">Download PDF</span>
                        </a>
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
                    <span className="inline-flex items-center gap-2 mr-2 text-[10px] font-black text-violet-400">
                      <i className="fa-solid fa-box"></i> {(conf.assets || []).length}
                    </span>
                    {(conf.crosscheckAssets || []).length > 0 && (
                      <span className="inline-flex items-center gap-1.5 mr-2 text-[10px] font-black text-indigo-400" title="Awaiting Godown Crosscheck">
                        <i className="fa-solid fa-arrows-to-dot"></i> {(conf.crosscheckAssets || []).length}
                      </span>
                    )}
                    {user?.role !== 'godown_incharge' && (
                      <button onClick={() => handlePrintChallan(conf)} className="text-emerald-400 hover:text-white" title="Print Challan"><i className="fa-solid fa-print"></i></button>
                    )}
                    {user?.is_staff ? (
                      <>
                        <button onClick={() => openEditConferenceForm(conf)} className="text-sky-400 hover:text-white"><i className="fa-solid fa-pen"></i></button>
                        <button onClick={() => handleDeleteConference(conf.id)} className="text-red-400 hover:text-white"><i className="fa-solid fa-trash"></i></button>
                      </>
                    ) : (
                      <button onClick={() => openEditConferenceForm(conf)} className="text-sky-400 hover:text-white text-[10px] font-black uppercase tracking-widest pl-4">View Execution <i className="fa-solid fa-arrow-right ml-1"></i></button>
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
    return (
      <div className="min-h-screen bg-white p-8 print:p-0 print:m-0 print:min-h-0 relative">
        <button
          onClick={() => window.print()}
          className="no-print fixed bottom-8 right-8 z-[100] w-16 h-16 bg-sky-500 text-white rounded-full shadow-2xl flex items-center justify-center hover:bg-sky-400 active:scale-95 transition-all"
          title="Print / Save PDF"
        >
          <i className="fa-solid fa-print text-2xl"></i>
        </button>

        <ChallanView
          booking={printConf}
          client={MOCK_CLIENTS[0]}
          assets={printAssets}
          companySettings={companySettings}
          subrentalTickets={confSubrentalTickets}
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
              ...((user?.is_staff || user?.role === 'godown_incharge') ? [
                { id: 'Assets', icon: 'fa-boxes-stacked', label: 'Inventory' },
              ] : []),
              { id: 'Conferences', icon: 'fa-user-md', label: 'Conference' },
              ...(user?.role !== 'godown_incharge' ? [
                { id: 'Billing', icon: 'fa-receipt', label: 'Challans' },
              ] : []),
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
                <i className={`fa-solid ${item.icon} w-8 text-xl`}></i>
                <span className="uppercase tracking-widest text-[10px] ml-2">{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="mt-auto p-10">
          <button onClick={handleLogout} className="w-full py-4 bg-slate-900/50 text-white/30 rounded-2xl font-black uppercase text-xs hover:text-white hover:bg-slate-800 transition flex items-center justify-center gap-3 border border-white/5">
            <i className="fa-solid fa-power-off"></i>
            System Logout
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
              <i className={`fa-solid ${isMobileMenuOpen ? 'fa-xmark' : 'fa-bars'}`}></i>
            </button>
            <div className="px-5 py-2 bg-slate-900/80 rounded-full border border-slate-800">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">
                {companySettings?.name || 'TECH TROLLEY'}
              </span>
            </div>

            {/* PWA Update Notifications */}
            {offlineReady && (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-xl animate-in fade-in zoom-in duration-300">
                <i className="fa-solid fa-cloud-arrow-down text-emerald-400 text-xs"></i>
                <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest">Offline Ready</span>
                <button onClick={closeUpdatePrompt} className="ml-2 text-emerald-400/50 hover:text-emerald-400 transition">
                  <i className="fa-solid fa-xmark text-[10px]"></i>
                </button>
              </div>
            )}

            {needRefresh && (
              <div className="flex items-center gap-3 bg-orange-500/10 border border-orange-500/20 px-4 py-2 rounded-xl animate-in slide-in-from-left-4 duration-500">
                <div className="flex flex-col">
                  <span className="text-[9px] font-black text-orange-400 uppercase tracking-widest leading-none mb-1">Update Available</span>
                  <span className="text-[8px] font-bold text-slate-500 uppercase leading-none">New version is ready to install</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => updateServiceWorker(true)}
                    className="px-3 py-1.5 bg-orange-500 text-white rounded-lg text-[9px] font-black uppercase hover:bg-orange-400 transition shadow-lg shadow-orange-500/20"
                  >
                    Restart to Update
                  </button>
                  <button onClick={closeUpdatePrompt} className="w-7 h-7 flex items-center justify-center text-slate-500 hover:text-white transition">
                    <i className="fa-solid fa-xmark text-xs"></i>
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            {user && <span className="text-[10px] font-bold text-slate-500 uppercase hidden lg:block">{user.email}</span>}
            <div className="w-10 h-10 md:w-12 md:h-12 bg-slate-900 rounded-xl border-2 border-slate-800 flex items-center justify-center text-sky-500"><i className="fa-solid fa-user-shield"></i></div>
            <button onClick={handleLogout} className="w-10 h-10 md:w-12 md:h-12 bg-slate-900 rounded-xl border-2 border-slate-800 flex items-center justify-center text-red-400 hover:bg-slate-800 hover:text-red-300 transition" title="Logout">
              <i className="fa-solid fa-power-off"></i>
            </button>
          </div>
        </header>
        <div className="p-6 md:p-12 max-w-7xl mx-auto">
          {currentPage === 'Dashboard' && renderDashboard()}
          {currentPage === 'Settings' && <SettingsView apiFetch={apiFetch} user={user} />}
          {currentPage === 'Subrentals' && (
            selectedSubrentalCompany 
              ? (showSubrentalInventory ? renderSubrentalInventory() : renderSubrentalTickets()) 
              : renderSubrentals()
          )}
          {currentPage === 'Reports' && <ReportsView apiFetch={apiFetch} user={user} onEditAsset={openEditAssetForm} />}
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
              const matchedItem = aliasDictionary.find(a => a.alias_name === selectedAlias);
              if (matchedItem) {
                setAssetFormData(prev => ({ ...prev, aliasName: selectedAlias, type: matchedItem.type }));
              } else {
                setAssetFormData(prev => ({ ...prev, aliasName: selectedAlias }));
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
                        <input list="alias-dictionary-list" autoComplete="off" value={assetFormData.aliasName} onChange={handleAliasChange} className="form-input-night" placeholder="e.g. Batteries AAA" required />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Unit Rate / Price</label>
                        <input type="number" value={assetFormData.itemPrice} onChange={e => setAssetFormData({ ...assetFormData, itemPrice: parseFloat(e.target.value) || 0 })} className="form-input-night" required />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
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
                        <GlobalQRPreview />
                      </div>
                      <div className="flex-1 space-y-3">
                        <div>
                          <p className="text-[11px] font-black text-white uppercase tracking-wider">Shared Global QR Identity</p>
                          <p className="text-[10px] font-bold text-sky-400/80 uppercase tracking-widest leading-relaxed">
                            All consumables reuse this QR code: <span className="text-white font-mono bg-white/10 px-2 py-0.5 rounded">{GLOBAL_CONSUMABLES_SKU}</span>.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setQrTarget({ sku: GLOBAL_CONSUMABLES_SKU, name: 'Global Consumables QR' })}
                          className="px-4 py-2.5 bg-sky-500/10 border border-sky-500/20 text-sky-400 rounded-xl text-[10px] font-black uppercase hover:bg-sky-500 hover:text-white transition flex items-center gap-2"
                        >
                          <i className="fa-solid fa-print"></i> Print QR Label
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
                            <i className="fa-solid fa-spinner fa-spin text-[9px]"></i> Verifying availability…
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
                            <i className="fa-solid fa-circle-exclamation text-red-400 text-xs mt-0.5 shrink-0"></i>
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
                          onChange={(e) => setAssetFormData({ ...assetFormData, type: mapUIToDBType(e.target.value) })}
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

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
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
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Available From</label>
                        <input type="date" value={assetFormData.availableFrom} onChange={e => setAssetFormData({ ...assetFormData, availableFrom: e.target.value })} className="form-input-night" />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Available Till</label>
                        <input type="date" value={assetFormData.availableTill} onChange={e => setAssetFormData({ ...assetFormData, availableTill: e.target.value })} className="form-input-night" />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="flex items-center gap-4 bg-slate-950/40 p-6 rounded-[1.5rem] border border-slate-800/50">
                        <div className="flex-1">
                          <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-1 block">Barcode Status</label>
                          <p className="text-[9px] text-slate-600 font-bold uppercase tracking-widest">Has a physical barcode sticker been added?</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAssetFormData({ ...assetFormData, isBarcodeAdded: !assetFormData.isBarcodeAdded })}
                          className={`px-6 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition ${assetFormData.isBarcodeAdded ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-500'}`}
                        >
                          {assetFormData.isBarcodeAdded ? 'Yes, Added' : 'Not Added'}
                        </button>
                      </div>

                      <div className="flex items-center gap-4 bg-slate-950/40 p-6 rounded-[1.5rem] border border-slate-800/50">
                        <div className="flex-1">
                          <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-1 block">QR Generation</label>
                          <p className="text-[9px] text-slate-600 font-bold uppercase tracking-widest">Show QR print modal after saving?</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAssetFormData({ ...assetFormData, generateQR: !assetFormData.generateQR })}
                          className={`px-6 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition ${assetFormData.generateQR ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-500'}`}
                        >
                          {assetFormData.generateQR ? 'Yes, Generate' : 'No'}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">System Status</label>
                        <select value={assetFormData.status} onChange={e => setAssetFormData({ ...assetFormData, status: e.target.value as AssetStatus })} className="form-input-night">
                          {Object.values(AssetStatus).map(stat => <option key={stat} value={stat}>{stat}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-2 block">Internal Condition</label>
                        <input value={assetFormData.condition} onChange={e => setAssetFormData({ ...assetFormData, condition: e.target.value })} className="form-input-night" />
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
                <div className="flex gap-4 pt-4">
                  <button type="button" onClick={() => setEmployeeView('List')} className="flex-1 py-6 bg-slate-800 text-white rounded-2xl font-black uppercase hover:bg-slate-700 transition">Cancel</button>
                  <button type="submit" className="flex-1 py-6 bg-indigo-500 text-white rounded-2xl font-black uppercase hover:bg-indigo-600 transition">Save Employee</button>
                </div>
              </form>
            </div>
          )}

          {currentPage === 'Conferences' && conferenceView === 'Form' && (
            <div className="max-w-7xl mx-auto space-y-10 pb-20">
              {/* Top Banner Header */}
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div className="space-y-4">
                  <button
                    onClick={() => setConferenceView('List')}
                    className="flex items-center gap-2 text-slate-500 hover:text-sky-500 font-black uppercase text-[10px] tracking-widest transition"
                  >
                    <i className="fa-solid fa-arrow-left"></i> Back to list
                  </button>
                  <div className="space-y-1">
                    <h2 className="text-5xl md:text-7xl font-black text-orange-500 uppercase tracking-tighter leading-none">
                      {conferenceFormData.name || "UNNAMED CONFERENCE"}
                    </h2>
                    <p className="text-sm md:text-lg font-bold text-slate-500 uppercase tracking-wide">
                      {conferenceFormData.association_name || "Association Not Specified"}
                    </p>
                    {conferenceFormData.pdf_document && (
                      <div className="pt-2">
                        <a
                          href={`${API_BASE}/api/conferences/${conferenceFormData.id}/download-pdf/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-3 bg-sky-500 text-white px-6 py-3.5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-sky-500/30 hover:bg-sky-400 hover:scale-105 active:scale-95 transition-all"
                        >
                          <i className="fa-solid fa-file-pdf text-base"></i>
                          Download Logistics PDF
                        </a>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {(() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const start = new Date(conferenceFormData.start_date);
                    const end = new Date(conferenceFormData.end_date);
                    
                    let statusLabel = 'Ongoing';
                    let statusClass = 'bg-emerald-100 text-emerald-600 border-emerald-200';
                    
                    if (today < start) {
                      statusLabel = 'Upcoming';
                      statusClass = 'bg-blue-100 text-blue-600 border-blue-200';
                    } else if (today > end) {
                      statusLabel = 'Ended';
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
              {(user?.is_staff || (user?.role !== 'godown_incharge' && user?.role !== 'technician')) && (
                <div className="space-y-10">
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-10">
                    {/* Conference Identity & Schedule */}
                    <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 shadow-xl shadow-sky-500/5 space-y-6">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-orange-50 text-orange-500 rounded-xl flex items-center justify-center text-lg border border-orange-100">
                          <i className="fa-solid fa-calendar-days"></i>
                        </div>
                        <h3 className="font-black text-slate-800 uppercase tracking-[0.2em] text-[10px]">Conference Identity & Schedule</h3>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Conference Name <span className="text-red-500">*</span></label>
                          <input value={conferenceFormData.name} onChange={e => setConferenceFormData({ ...conferenceFormData, name: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Conference Name" required />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 block ml-1">Association Name <span className="text-red-500">*</span></label>
                          <input value={conferenceFormData.association_name} onChange={e => setConferenceFormData({ ...conferenceFormData, association_name: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Association Name" required />
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
                    </div>

                    {/* Billing & Contact Details */}
                    <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 shadow-xl shadow-sky-500/5 space-y-6">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-indigo-50 text-indigo-500 rounded-xl flex items-center justify-center text-lg border border-indigo-100">
                          <i className="fa-solid fa-file-invoice-dollar"></i>
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
                            <input value={conferenceFormData.transport_address} onChange={e => setConferenceFormData({ ...conferenceFormData, transport_address: e.target.value })} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-xs font-bold focus:ring-2 focus:ring-sky-500/20" placeholder="Transport / Delivery Address" />
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
                          <i className="fa-solid fa-user-gear"></i>
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
                      {employees.length === 0 ? (
                        <div className="col-span-full py-6 text-center">
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest italic">No Technicians Loaded. Try refreshing.</p>
                        </div>
                      ) : employees.map(emp => {
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
                            <i className={`fa-solid ${isAssigned ? 'fa-check-circle' : 'fa-circle-user'}`}></i>
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
                        <i className="fa-solid fa-truck"></i>
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

                      {user?.is_staff && (
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
                                <i className="fa-solid fa-cloud-arrow-up text-xl"></i>
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
                                  <i className="fa-solid fa-times-circle"></i>
                                </button>
                              )}
                            </label>
                          </div>
                        </div>
                      )}


                      <div className="pt-4 grid grid-cols-1 gap-3">
                        <button 
                          type="button"
                          onClick={() => handlePrintChallan(editingConference)}
                          className="w-full py-4 md:py-5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl font-black uppercase text-[10px] md:text-xs tracking-widest flex items-center justify-center gap-3 shadow-lg shadow-emerald-500/20 transition-all active:scale-95 leading-tight"
                        >
                          <i className="fa-solid fa-print"></i> <span>Print Delivery Challan</span>
                        </button>
                        {(user?.is_staff || user?.role === 'technician' || user?.role === 'godown_incharge') && (
                          <button 
                            type="button"
                            onClick={() => handleUpdateLogistics()}
                            className="w-full py-4 md:py-5 bg-sky-600 hover:bg-sky-700 text-white rounded-2xl font-black uppercase text-[10px] md:text-xs tracking-widest flex items-center justify-center gap-3 shadow-lg shadow-sky-600/20 transition-all active:scale-95 leading-tight text-center"
                          >
                            <i className="fa-solid fa-cloud-arrow-up"></i>
                            <span>{user?.role === 'technician' ? 'Submit Requirements' : 'Update Logistics & PDF'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column: Asset Scanning Card */}
                <div className="xl:col-span-8">
                  <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 md:p-10 shadow-xl shadow-sky-500/5 h-full flex flex-col space-y-8 relative">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-orange-500/10 text-orange-500 rounded-2xl flex items-center justify-center text-xl shadow-inner border border-orange-500/20">
                          <i className="fa-solid fa-qrcode"></i>
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
                        {(!user?.is_staff && (user?.role !== 'godown_incharge' && user?.role !== 'technician')) && (
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

                        {/* 4. CROSSCHECK TAB (Admin/Godown Only) */}
                        {(user?.is_staff || user?.role === 'godown_incharge' || (user?.role !== 'godown_incharge' && user?.role !== 'technician')) && (
                          <button
                            onClick={() => setAssetTab('crosscheck')}
                            className={`flex-1 py-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${assetTab === 'crosscheck' ? 'bg-white text-orange-500 shadow-md shadow-sky-900/5' : 'text-slate-400 hover:text-slate-600 hover:bg-sky-100/30'}`}
                          >
                            Crosscheck
                          </button>
                        )}
                      </div>

                      {/* Scanner visibility logic per role */}
                      {((assetTab === 'available') || 
                        ((user?.is_staff || (user?.role !== 'godown_incharge' && user?.role !== 'technician')) && assetTab === 'assigned') || 
                        (assetTab === 'packup') ||
                        ((user?.role === 'godown_incharge' || user?.is_staff) && assetTab === 'crosscheck')) && (
                          <div className="relative group">
                            <div className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors">
                              <i className="fa-solid fa-magnifying-glass"></i>
                            </div>
                            <input
                              type="text"
                              placeholder={assetTab === 'available' ? "SCAN OR TYPE SKU..." : "SCAN TO REMOVE/VERIFY..."}
                              value={assetTab === 'available' ? quickAddInput : quickRemoveInput}
                              onChange={(e) => assetTab === 'available' ? setQuickAddInput(e.target.value) : setQuickRemoveInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const val = (e.target as HTMLInputElement).value.trim();
                                  if (val) handleScan(val, true);
                                  if (assetTab === 'available') setQuickAddInput(''); else setQuickRemoveInput('');
                                }
                              }}
                              className="w-full bg-sky-50 border-none rounded-2xl pl-14 pr-6 py-6 text-sm font-black text-slate-800 focus:ring-4 focus:ring-sky-500/10 transition-all placeholder:text-slate-300 placeholder:font-bold"
                            />
                            {isMobilePhone && (
                              <button
                                onClick={() => setShowScanner(true)}
                                className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-sky-500 text-white rounded-xl shadow-lg shadow-sky-500/30 flex items-center justify-center transition-transform active:scale-90"
                              >
                                <i className="fa-solid fa-camera"></i>
                              </button>
                            )}
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
                                              <i className="fa-solid fa-check-double"></i>
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              <p className="font-black uppercase text-xs text-slate-800 truncate">{asset.aliasName || asset.sku}</p>
                                              <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5 truncate">{asset.type} • ALLOCATED</p>
                                            </div>
                                            <button
                                              onClick={() => triggerAssetConferenceAction(asset, 'unassign')}
                                              className="w-10 h-10 bg-white border border-slate-100 rounded-xl text-slate-400 hover:text-red-500 hover:border-red-500/50 transition-all flex items-center justify-center"
                                              title="Unassign Asset"
                                            >
                                              <i className="fa-solid fa-trash-can text-xs"></i>
                                            </button>
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
                                            <i className="fa-solid fa-check-double"></i>
                                          </div>
                                          <div className="min-w-0 flex-1">
                                            <p className="font-black uppercase text-xs text-slate-800 truncate">{asset.aliasName || asset.sku}</p>
                                            <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5 truncate">{asset.type}</p>
                                          </div>
                                          <button
                                            onClick={() => triggerAssetConferenceAction(asset, 'unassign')}
                                            className="w-10 h-10 bg-white border border-slate-100 rounded-xl text-slate-400 hover:text-red-500 hover:border-red-500/50 transition-all flex items-center justify-center"
                                            title="Hard Remove (Accidental Scan)"
                                          >
                                            <i className="fa-solid fa-trash-can text-xs"></i>
                                          </button>
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
                              const notInCurrentConf = !selectedIds.has(String(a.id)) && !crosscheckIds.has(String(a.id));
                              const notInOtherConf = !bookedInOtherConferences.has(String(a.id));
                              const notDamaged = a.status !== AssetStatus.DAMAGED;
                              return matchesSearch && notInCurrentConf && notInOtherConf && notDamaged;
                            });

                            if (availableFiltered.length === 0) {
                              return (
                                <div className="col-span-2 py-20 text-center space-y-4">
                                  <div className="text-slate-200 text-6xl"><i className="fa-solid fa-layer-group"></i></div>
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
                                  <i className="fa-solid fa-box-open"></i>
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="font-black uppercase text-xs text-slate-800 group-hover:text-sky-600 transition truncate">{asset.aliasName || asset.sku}</p>
                                  <p className="text-[9px] text-slate-400 font-bold uppercase mt-1 truncate">{asset.type} • {asset.serialNumber || 'No SN'}</p>
                                </div>
                                <i className="fa-solid fa-circle-plus text-slate-200 group-hover:text-sky-500 transition-colors"></i>
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
                                   <div className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors">
                                     <i className="fa-solid fa-magnifying-glass"></i>
                                   </div>
                                   <input 
                                     type="text"
                                     placeholder="SEARCH ASSETS TO ADD AS REQUIREMENT..."
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
                                     className="w-full bg-sky-50 border-none rounded-2xl pl-14 pr-6 py-6 text-sm font-black text-slate-800 focus:ring-4 focus:ring-sky-500/10 transition-all placeholder:text-slate-300 placeholder:font-bold"
                                   />
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
                                               <i className="fa-solid fa-plus-circle text-sky-500 group-hover:scale-110 transition-transform"></i>
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
                                     <div className="text-slate-200 text-4xl mb-4"><i className="fa-solid fa-clipboard-list"></i></div>
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
                                     // F-3: Cart view — group by aliasName
                                      const groups = filteredReqs.reduce((acc: Record<string, Asset[]>, a) => {
                                        const key = a.aliasName || a.sku || 'Unknown';
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
                                                    <i className="fa-solid fa-list-check"></i>
                                                  </div>
                                                  <span className="truncate flex-1 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                                  <div className="shrink-0 flex items-center bg-gray-200 rounded-full text-[10px] font-black overflow-hidden mr-2">
                                                    <button 
                                                      onClick={(e) => { e.stopPropagation(); triggerAssetConferenceAction(items[0], 'unassign'); }} 
                                                      className="px-2.5 py-1 hover:bg-gray-300 hover:text-red-600 transition-colors"
                                                    >
                                                      <i className="fa-solid fa-minus"></i>
                                                    </button>
                                                    <span className="text-gray-900 font-bold px-3 min-w-[2rem] text-center">{items.length}</span>
                                                    <button 
                                                      onClick={(e) => { 
                                                        e.stopPropagation();
                                                        const targetName = name;
                                                        const gPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                                                        const availableAsset = gPool.find(a => 
                                                          (a.aliasName || a.sku || 'Unknown') === targetName && 
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
                                                      <i className="fa-solid fa-plus"></i>
                                                    </button>
                                                  </div>
                                                  <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                                </button>
                                                {isOpen && (
                                                  <div className="border-t border-sky-100 divide-y divide-sky-50">
                                                    {items.map(asset => (
                                                      <div key={asset.id} className="flex items-center gap-3 px-4 py-2.5">
                                                        <span className="font-mono text-[10px] text-slate-500 truncate flex-1">{asset.sku || asset.serialNumber}</span>
                                                        <button onClick={() => triggerAssetConferenceAction(asset, 'unassign')} className="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 transition-all flex items-center justify-center shrink-0" title="Remove">
                                                          <i className="fa-solid fa-trash-can text-[9px]"></i>
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
                                       const key = a.aliasName || a.sku || 'Unknown';
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
                                                   <i className="fa-solid fa-hourglass-start"></i>
                                                 </div>
                                                 <span className="truncate flex-1 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                                 <span className="shrink-0 px-2 py-0.5 bg-orange-500 text-white text-[9px] font-black rounded-full">x {items.length}</span>
                                                 <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                               </button>
                                               {isOpen && (
                                                 <div className="border-t border-orange-100 divide-y divide-orange-50">
                                                   {items.map(asset => (
                                                     <div key={asset.id} className="flex items-center gap-3 px-4 py-2.5">
                                                       <span className="font-mono text-[10px] text-slate-500 truncate flex-1">{asset.sku || asset.serialNumber}</span>
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

                                {/* 2. Godown Search/Scan Bar */}
                                <div className="space-y-4">
                                  <div className="relative group">
                                    <div className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-sky-500 transition-colors">
                                      <i className="fa-solid fa-magnifying-glass"></i>
                                    </div>
                                    <input 
                                      type="text"
                                      placeholder="SCAN OR SEARCH ASSETS TO PACK..."
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
                                      className="w-full bg-sky-50 border-none rounded-2xl pl-14 pr-6 py-6 text-sm font-black text-slate-800 focus:ring-4 focus:ring-sky-500/10 transition-all placeholder:text-slate-300 placeholder:font-bold"
                                    />
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
                                           const notUsed = !new Set((conferenceFormData.assets || []).map(String)).has(String(a.id)) && !new Set((conferenceFormData.staged_assets || []).map(String)).has(String(a.id));
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
                                             <i className="fa-solid fa-plus-circle text-sky-500"></i>
                                           </div>
                                         ));
                                      })()}
                                    </div>
                                  )}
                                </div>

                                {/* 3. Staged / Assigned Items */}
                                <div className="space-y-6">
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
                                            <i className="fa-solid fa-lock mr-1"></i>Dispatched — Read Only
                                          </span>
                                        ) : null;
                                      })()}
                                    </div>
                                    <span className="text-[10px] font-black text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full">{(conferenceFormData.assets || []).length + (conferenceFormData.staged_assets || []).length} READY</span>
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
                                         const key = item.asset.aliasName || item.asset.sku || 'Unknown';
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
                                                 <i className={`fa-solid ${colors.icon}`}></i>
                                               </div>
                                               <span className="truncate flex-1 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                               <span className={`shrink-0 px-2 py-0.5 ${colors.badge} text-white text-[9px] font-black rounded-full`}>x {items.length}</span>
                                               <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                             </button>
                                             {isOpen && (
                                               <div className={`border-t ${colors.border} divide-y divide-slate-100/50`}>
                                                 {items.map(({ asset, type }) => (
                                                   <div key={`${type}-${asset.id}`} className="flex items-center gap-3 px-4 py-2.5">
                                                     <span className="font-mono text-[10px] text-slate-500 truncate flex-1">{asset.sku || asset.serialNumber}</span>
                                                     <span className={`shrink-0 px-1.5 py-0.5 text-white text-[8px] font-black rounded-full ${colors.badge}`}>
                                                       {type === 'staged' ? 'STAGED' : type === 'extra' ? 'EXTRA' : 'PACKED'}
                                                     </span>
                                                     {!isConferenceEnded && (
                                                       <button onClick={() => triggerAssetConferenceAction(asset, 'unassign')} className="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 transition-all flex items-center justify-center shrink-0" title="Remove">
                                                         <i className="fa-solid fa-xmark text-[9px]"></i>
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

                                  {(conferenceFormData.staged_assets || []).length > 0 && (
                                    <div className="pt-8 border-t border-slate-200 mt-4">
                                      <button 
                                        onClick={async () => {
                                          const itemCount = (conferenceFormData.staged_assets || []).length;
                                          if (confirm(`⚠️ FINAL DISPATCH CHECK:\n\nAre you sure you want to finalize and submit these ${itemCount} item(s) for dispatch? \n\nThis will officially move them to the Packup phase and notify the team.`)) {
                                            const newAssets = [...(conferenceFormData.assets || []), ...(conferenceFormData.staged_assets || [])];
                                            const newStaged = [];
                                            
                                            const newChallanAssets = Array.from(new Set([
                                              ...(conferenceFormData.challanAssets || []), 
                                              ...newAssets
                                            ]));
                                            
                                            // Update local state
                                            setConferenceFormData((prev: any) => ({
                                              ...prev,
                                              assets: newAssets,
                                              challanAssets: newChallanAssets,
                                              staged_assets: newStaged
                                            }));

                                            // Trigger save to backend immediately
                                            try {
                                              const res = await apiFetch(`${API_BASE}/api/conferences/${conferenceFormData.id}/`, {
                                                method: 'PATCH', // BUG J-7: Use PATCH (not POST) when updating an existing conference
                                                body: JSON.stringify({
                                                  assets: newAssets.map(id => parseInt(String(id), 10)).filter(id => !isNaN(id)),
                                                  challan_assets: newChallanAssets.map(id => parseInt(String(id), 10)).filter(id => !isNaN(id)),
                                                  requirements: (conferenceFormData.requirements || []).map(id => parseInt(String(id), 10)).filter(id => !isNaN(id))
                                                })
                                              });
                                              
                                              if (res.ok) {
                                                showScanToast('🚚 DISPATCHED: Items moved to Packup!', 'success');
                                                setAssetTab('packup'); // Switch to view the list
                                                fetchConferences();
                                              } else {
                                                showScanToast('⚠️ FAILED: Could not save to server.', 'error');
                                              }
                                            } catch (err) {
                                              console.error("Auto-save failed", err);
                                            }
                                          }
                                        }}
                                        className="w-full py-6 bg-emerald-600 text-white rounded-3xl font-black uppercase text-sm tracking-[0.2em] shadow-xl shadow-emerald-500/20 hover:bg-emerald-500 hover:-translate-y-1 active:scale-[0.98] transition-all flex items-center justify-center gap-3"
                                      >
                                        <i className="fa-solid fa-paper-plane"></i> Submit Dispatch to Show
                                      </button>
                                      <p className="text-center text-[10px] text-slate-400 font-bold uppercase mt-4 tracking-widest italic animate-pulse">Finalize items to clear current packing station</p>
                                    </div>
                                  )}
                                </div>
                             </div>
                          ) : (
                            // Admin Role View: Show BOTH Pending Requirements and Extra Scans
                            (() => {
                              const requirementIds = new Set((conferenceFormData.requirements || []).map(String));
                              const assignedIds = new Set((conferenceFormData.assets || []).map(String));

                              if (requirementIds.size === 0 && assignedIds.size === 0) {
                                return (
                                  <div className="col-span-2 py-20 text-center space-y-4">
                                    <div className="text-slate-200 text-6xl"><i className="fa-solid fa-clipboard-list"></i></div>
                                    <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">No requirements or assignments</p>
                                  </div>
                                );
                              }

                              return (
                                <>
                                  {/* F-3: Cart view — Admin: Staged + Pending + Assigned grouped by alias */}
                                  {(() => {
                                    const aPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                                    const stagedList = aPool.filter(a => new Set((conferenceFormData.staged_assets || []).map(String)).has(String(a.id)));
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
                                                  <i className={`fa-solid ${colors.icon}`}></i>
                                                </div>
                                                <span className="truncate flex-1 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                                <span className={`shrink-0 px-2 py-0.5 ${colors.badge} text-white text-[9px] font-black rounded-full`}>x {items.length}</span>
                                                <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                              </button>
                                              {isOpen && (
                                                <div className={`border-t ${colors.border} divide-y divide-slate-100/50`}>
                                                  {items.map(({ asset, type }) => (
                                                    <div key={`${type}-${asset.id}`} className="flex items-center gap-3 px-4 py-2.5">
                                                      <span className="font-mono text-[10px] text-slate-500 truncate flex-1">{asset.sku || asset.serialNumber}</span>
                                                      <span className={`shrink-0 px-1.5 py-0.5 text-white text-[8px] font-black rounded-full ${colors.badge}`}>
                                                        {type === 'staged' ? 'STAGED' : type === 'extra' ? 'EXTRA' : type === 'pending' ? 'PENDING' : 'ASSIGNED'}
                                                      </span>
                                                      {(type === 'extra' || type === 'assigned' || type === 'staged') && (
                                                        <button onClick={() => triggerAssetConferenceAction(asset, 'unassign')} className="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 transition-all flex items-center justify-center shrink-0" title="Remove">
                                                          <i className="fa-solid fa-trash-can text-[9px]"></i>
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

                        if (packupList.length === 0) {
                          return (
                            <div className="grid grid-cols-1">
                              <div className="col-span-2 py-20 text-center space-y-4">
                                <div className="text-slate-200 text-6xl"><i className="fa-solid fa-truck-ramp-box"></i></div>
                                <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">No assets dispatched to site yet</p>
                              </div>
                            </div>
                          );
                        }

                        const groups = packupList.reduce((acc: Record<string, Asset[]>, a) => {
                          const key = a.aliasName || a.sku || 'Unknown';
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
                                      <i className="fa-solid fa-check-double"></i>
                                    </div>
                                    <span className="truncate flex-1 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                    <span className="shrink-0 px-2 py-0.5 bg-emerald-500 text-white text-[9px] font-black rounded-full">x {items.length}</span>
                                    <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                  </button>
                                  {isOpen && (
                                    <div className="border-t border-emerald-100 divide-y divide-emerald-50">
                                      {items.map(asset => (
                                        <div key={asset.id} className="relative flex items-center gap-2 px-4 py-2.5">
                                          <span className="font-mono text-[10px] text-slate-500 truncate flex-1">{asset.sku || asset.serialNumber}</span>
                                          <span className="shrink-0 px-2 py-0.5 bg-emerald-500 text-white text-[8px] font-black rounded-full">ON-SITE</span>
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
                                                <i className="fa-solid fa-circle-exclamation text-[9px]"></i>
                                              </button>
                                              <button
                                                onClick={() => triggerAssetConferenceAction(asset, 'remove')}
                                                className="w-7 h-7 bg-white border border-slate-200 text-slate-400 hover:text-orange-500 hover:border-orange-300 rounded-lg flex items-center justify-center transition-all"
                                                title="Move to Crosscheck (Return)"
                                              >
                                                <i className="fa-solid fa-arrow-right-from-bracket text-[9px]"></i>
                                              </button>
                                            </div>
                                          )}
                                          {/* Floating Issue Menu */}
                                          {flagMenuAssetId === asset.id && (
                                            <div className="absolute top-0 right-12 z-[60] bg-white border border-slate-200 rounded-2xl shadow-2xl p-2 min-w-[160px] animate-in fade-in slide-in-from-right-2 duration-200">
                                              <button
                                                onClick={() => handleQuickUpdateAsset(asset, { flag: AssetFlag.MISSING }, conferenceFormData.id, 'Packup')}
                                                className="w-full px-4 py-3 hover:bg-red-50 flex items-center gap-3 rounded-xl transition-colors text-left"
                                              >
                                                <i className="fa-solid fa-flag text-red-500 text-xs"></i>
                                                <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Missing</span>
                                              </button>
                                              <button
                                                onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.DAMAGED, flag: AssetFlag.REQUIRED_SERVICE }, conferenceFormData.id, 'Packup')}
                                                className="w-full px-4 py-3 hover:bg-orange-50 flex items-center gap-3 rounded-xl transition-colors text-left"
                                              >
                                                <i className="fa-solid fa-tools text-orange-500 text-xs"></i>
                                                <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Damaged</span>
                                              </button>
                                              <button
                                                onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.AVAILABLE, flag: AssetFlag.NONE }, conferenceFormData.id, 'Packup')}
                                                className="w-full px-4 py-3 hover:bg-slate-50 flex items-center gap-3 rounded-xl transition-colors text-left border-t border-slate-100"
                                              >
                                                <i className="fa-solid fa-check text-emerald-500 text-xs"></i>
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


                      {assetTab === 'crosscheck' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {(conferenceFormData.crosscheck_assets || []).length === 0 ? (
                            <div className="col-span-2 py-20 text-center space-y-4">
                              <div className="text-slate-200 text-6xl"><i className="fa-solid fa-truck-loading"></i></div>
                              <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">No assets in crosscheck queue</p>
                            </div>
                          ) : (() => {
                             // F-3: Cart view for crosscheck tab
                             const crossPool = allAssetsRef.current.length > 0 ? allAssetsRef.current : assets;
                             const crosscheckList = crossPool.filter(a => new Set((conferenceFormData.crosscheck_assets || []).map(String)).has(String(a.id)));
                             const groups = crosscheckList.reduce((acc: Record<string, Asset[]>, a) => {
                               const key = a.aliasName || a.sku || 'Unknown';
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
                                       <i className="fa-solid fa-box"></i>
                                     </div>
                                     <span className="truncate flex-1 font-black uppercase text-xs text-slate-800 text-left">{name}</span>
                                     <span className="shrink-0 px-2 py-0.5 bg-orange-500 text-white text-[9px] font-black rounded-full">x {items.length}</span>
                                     <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[10px] shrink-0`}></i>
                                   </button>
                                   {isOpen && (
                                     <div className="border-t border-orange-100 divide-y divide-orange-50">
                                       {items.map(asset => (
                                         <div key={asset.id} className="flex items-center gap-2 px-4 py-2.5">
                                           <span className="font-mono text-[10px] text-slate-500 truncate flex-1">{asset.sku || asset.serialNumber}</span>
                                           {(user?.role === 'godown_incharge' || user?.is_staff) && (
                                             <div className="flex gap-1.5 shrink-0">
                                               <button 
                                                 onClick={() => setFlagMenuAssetId(flagMenuAssetId === asset.id ? null : asset.id)}
                                                 className={`w-7 h-7 border rounded-lg flex items-center justify-center transition-all ${
                                                   asset.status === 'Damaged' || asset.flag === 'Missing'
                                                     ? 'bg-red-500 border-red-400 text-white animate-pulse'
                                                     : 'bg-white border-slate-200 text-slate-400 hover:text-red-500'
                                                 }`} title="Report Issue">
                                                 <i className="fa-solid fa-circle-exclamation text-[9px]"></i>
                                               </button>
                                               <button onClick={() => verifyCrosscheckAsset(asset)} className="w-7 h-7 bg-orange-500 text-white rounded-lg flex items-center justify-center transition-all active:scale-95" title="Verify Receipt">
                                                 <i className="fa-solid fa-check text-[9px]"></i>
                                               </button>
                                             </div>
                                           )}
                                           {/* Floating Issue Menu */}
                                           {flagMenuAssetId === asset.id && (
                                             <div className="absolute top-0 right-12 z-[60] bg-white border border-slate-200 rounded-2xl shadow-2xl p-2 min-w-[160px] animate-in fade-in slide-in-from-right-2 duration-200">
                                               <button onClick={() => handleQuickUpdateAsset(asset, { flag: AssetFlag.MISSING }, conferenceFormData.id, 'Crosscheck')} className="w-full px-4 py-3 hover:bg-red-50 flex items-center gap-3 rounded-xl transition-colors text-left">
                                                 <i className="fa-solid fa-flag text-red-500 text-xs"></i>
                                                 <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Missing</span>
                                               </button>
                                               <button onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.DAMAGED, flag: AssetFlag.REQUIRED_SERVICE }, conferenceFormData.id, 'Crosscheck')} className="w-full px-4 py-3 hover:bg-orange-50 flex items-center gap-3 rounded-xl transition-colors text-left">
                                                 <i className="fa-solid fa-tools text-orange-500 text-xs"></i>
                                                 <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Mark Damaged</span>
                                               </button>
                                               <button onClick={() => handleQuickUpdateAsset(asset, { status: AssetStatus.AVAILABLE, flag: AssetFlag.NONE }, conferenceFormData.id, 'Crosscheck')} className="w-full px-4 py-3 hover:bg-slate-50 flex items-center gap-3 rounded-xl transition-colors text-left border-t border-slate-100">
                                                 <i className="fa-solid fa-check text-emerald-500 text-xs"></i>
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
                          
                          {(user?.role === 'godown_incharge' || user?.is_staff) && (
                            <div className="col-span-2 pt-10 border-t border-slate-100 mt-6">
                              <button 
                                onClick={handleUpdateLogistics}
                                className="w-full py-6 bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-[2rem] font-black uppercase text-xs tracking-[0.3em] shadow-2xl shadow-orange-500/30 hover:from-orange-600 hover:to-amber-600 hover:-translate-y-1 active:scale-[0.96] transition-all flex items-center justify-center gap-4 border-b-4 border-orange-700/50 group"
                              >
                                <span className="opacity-70 group-hover:translate-x-1 transition-transform"><i className="fa-solid fa-paper-plane"></i></span>
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
            currentPage === 'Billing' && challanViewMode === 'Detail' && selectedBookingForChallan && (
              <div className="animate-in fade-in zoom-in duration-300">
                <div className="no-print p-8 flex justify-between container mx-auto">
                  <button onClick={() => setChallanViewMode('List')} className="px-6 py-3 bg-slate-800 text-white rounded-xl font-bold uppercase text-xs">Back to List</button>
                  <div className="flex gap-4">
                    <button onClick={() => handlePrintChallan(selectedBookingForChallan)} className="px-6 py-3 bg-sky-500 text-white rounded-xl font-bold uppercase text-xs">Print Challan</button>
                  </div>
                </div>
                <div className="bg-white p-8 min-h-screen container mx-auto rounded-3xl shadow-2xl challan-container">
                  <ChallanView
                    booking={selectedBookingForChallan}
                    client={MOCK_CLIENTS[0]}
                    assets={(allAssetsRef.current.length > 0 ? allAssetsRef.current : assets).filter(a => {
                      const historicalList = selectedBookingForChallan.challanAssets && selectedBookingForChallan.challanAssets.length > 0 
                                             ? selectedBookingForChallan.challanAssets 
                                             : [...(selectedBookingForChallan.assets || []), ...(selectedBookingForChallan.staged_assets || [])];
                      return historicalList.map(String).includes(a.id.toString());
                    })}
                    companySettings={companySettings}
                    onUpdateAsset={handleChallanAssetUpdate}
                    onAddAdhocItem={handleAddAdhocChallanItem}
                    showScanToast={showScanToast}
                    onUpdateConferenceValue={handleUpdateConferenceValue}
                    onUpdateChallanNumber={handleUpdateChallanNumber}
                    onSaveFullChallan={handleSaveFullChallan}
                    subrentalTickets={confSubrentalTickets}
                    onRemoveAssets={async (assetIds) => {
                      if (!selectedBookingForChallan) return;
                      const currentAssets = (selectedBookingForChallan.assets || []).map(String);
                      const currentChallanAssets = (selectedBookingForChallan.challanAssets || []).map(String);
                      const updatedAssets = currentAssets.filter(id => !assetIds.includes(String(id)));
                      const updatedChallanAssets = currentChallanAssets.filter(id => !assetIds.includes(String(id)));
                      
                      const confRes = await apiFetch(`${API_BASE}/api/conferences/${selectedBookingForChallan.id}/`, {
                        method: 'PATCH',
                        body: JSON.stringify({
                          assets: updatedAssets.map(id => parseInt(id, 10)),
                          challan_assets: updatedChallanAssets.map(id => parseInt(id, 10))
                        })
                      });
                      if (confRes.ok) {
                        setSelectedBookingForChallan(prev => prev ? { ...prev, assets: updatedAssets, challanAssets: updatedChallanAssets } : null);
                        await fetchConferences();
                      }
                    }}
                  />
                </div>
              </div>
            )
          }


        </div >
      </main >

      {/* Quick Scroller */}
      {showScrollTop && (
        <button
          onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-24 right-8 z-[100] w-14 h-14 bg-orange-500/20 hover:bg-orange-500 text-orange-400 hover:text-white rounded-full border border-orange-500/30 backdrop-blur-xl shadow-2xl flex items-center justify-center transition-all animate-in fade-in zoom-in duration-300"
          title="Scroll to Top"
        >
          <i className="fa-solid fa-arrow-up text-xl" />
        </button>
      )}

      {showScanner && <Scanner onScan={handleScan} onClose={() => setShowScanner(false)} />}

      {/* QR Label Modal */}
      {qrTarget && (
        <QRLabelModal
          assetId={qrTarget.id}
          sku={qrTarget.sku}
          assetName={qrTarget.name}
          onPrint={handlePrintAsset}
          onClose={() => setQrTarget(null)}
          companySettings={companySettings}
        />
      )}

      {/* Pending Sub-Asset Checklist Modal */}
      {pendingParentAsset && pendingAction && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 backdrop-blur-xl p-4 animate-in fade-in duration-300">
          <div className="bg-slate-900 border border-slate-700 max-w-lg w-full rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col">
            <div className="p-8 border-b border-slate-800 flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-orange-500/20 text-orange-400 rounded-full flex items-center justify-center mb-6 border border-orange-500/30">
                <i className="fa-solid fa-boxes-stacked text-2xl" />
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
                <i className="fa-solid fa-check-circle text-emerald-500 text-xl" />
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

                          if (newScanned.length >= (pendingParentAsset.sub_assets?.length || 0)) {
                            // Proceed if all done via clicks too
                            const allIdsToProcess = [pendingParentAsset.id, ...(pendingParentAsset.sub_assets?.map(s => s.id.toString()) || [])];
                            if (pendingAction === 'add') {
                              if (user?.role === 'technician') {
                                setConferenceFormData((prev: any) => ({
                                  ...prev,
                                  requirements: Array.from(new Set([...(prev.requirements || []), ...allIdsToProcess]))
                                }));
                              } else {
                                setConferenceFormData((prev: any) => ({
                                  ...prev,
                                  staged_assets: Array.from(new Set([...(prev.staged_assets || []), ...allIdsToProcess.map(String)])),
                                  requirements: (prev.requirements || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString()))
                                }));
                              }
                            } else if (pendingAction === 'remove') {
                              setConferenceFormData((prev: any) => ({
                                ...prev,
                                assets: (prev.assets || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString())),
                                staged_assets: (prev.staged_assets || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString())),
                                crosscheck_assets: Array.from(new Set([...(prev.crosscheck_assets || []), ...allIdsToProcess.map(String)]))
                              }));
                            } else if (pendingAction === 'verify_crosscheck') {
                              setConferenceFormData((prev: any) => ({
                                ...prev,
                                crosscheck_assets: (prev.crosscheck_assets || []).filter((id: any) => !allIdsToProcess.map(String).includes(id.toString()))
                              }));
                            }
                            setPendingParentAsset(null); setPendingAction(null); setScannedSubAssetIds([]);

                            // AUTO-SAVE to backend
                            if (editingConference?.id) {
                              setTimeout(() => {
                                setConferenceFormData((current: any) => {
                                  const payload = {
                                    assets: (current.assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                                    requirements: (current.requirements || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                                    staged_assets: (current.staged_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                                    crosscheck_assets: (current.crosscheck_assets || []).map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id)),
                                  };
                                  apiFetch(`${API_BASE}/api/conferences/${editingConference.id}/`, {
                                    method: 'PATCH',
                                    body: JSON.stringify(payload)
                                  }).then(res => {
                                    if (res.ok) fetchConferences();
                                  });
                                  return current;
                                });
                              }, 0);
                            }
                          }
                        }
                      }}
                      className={`flex items-center justify-between p-4 rounded-2xl border transition-all cursor-pointer ${isScanned ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900 border-slate-700 hover:border-sky-500/50'}`}
                    >
                      <div>
                        <p className={`text-xs font-black uppercase ${isScanned ? 'text-emerald-400' : 'text-slate-300'}`}>{sub.alias_name || sub.sku}</p>
                        <p className="text-[9px] text-slate-500 font-mono tracking-wider">{sub.serial_number}</p>
                      </div>
                      {isScanned ? (
                        <i className="fa-solid fa-circle-check text-emerald-500 text-lg animate-in zoom-in" />
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
                        <i className="fa-solid fa-link"></i>
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
                    <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
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
                          {linkingAsset?.id === a.id && <i className="fa-solid fa-circle-check text-sky-500 text-xl"></i>}
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
                <i className="fa-solid fa-times text-xl"></i>
              </button>
            </div>

            <div className="p-8 space-y-6">
              <div className="relative">
                <i className="fa-solid fa-magnifying-glass absolute left-6 top-1/2 -translate-y-1/2 text-slate-500"></i>
                <input
                  type="text"
                  placeholder="SEARCH CONSUMABLES..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl py-4 pl-14 pr-6 text-xs font-black text-white uppercase tracking-widest focus:border-amber-500 outline-none transition"
                  value={consumablesPickerSearchQuery}
                  onChange={(e) => setConsumablesPickerSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="max-h-[40vh] overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                {assets
                  .filter(a => a.type === AssetCategory.CONSUMABLES && a.status === 'Available' && (a.quantity || 0) > 0)
                  .filter(a => {
                    const q = normalizeSearch(consumablesPickerSearchQuery);
                    return normalizeSearch(a.aliasName || a.sku || '').includes(q);
                  })
                  .map(a => (
                    <button
                      key={a.id}
                      onClick={() => {
                        setQuantityAsset(a);
                        setSelectedQuantity(a.quantity);
                        setShowConsumablesPicker(false);
                        setShowQuantityModal(true);
                      }}
                      className="w-full flex items-center justify-between p-6 bg-slate-950/50 border border-slate-800 rounded-2xl hover:border-amber-500 group transition animate-in fade-in slide-in-from-left-4"
                    >
                      <div className="text-left">
                        <p className="text-sm font-black text-white uppercase group-hover:text-amber-500 transition">{a.aliasName || a.sku}</p>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">Stock Level: <span className="text-slate-300">{a.quantity} Units</span></p>
                      </div>
                      <i className="fa-solid fa-chevron-right text-slate-700 group-hover:text-amber-500 group-hover:translate-x-1 transition"></i>
                    </button>
                  ))}

                {assets.filter(a => a.type === AssetCategory.CONSUMABLES && a.status === 'Available' && (a.quantity || 0) > 0).length === 0 && (
                  <div className="py-12 text-center space-y-4">
                    <i className="fa-solid fa-box-open text-4xl text-slate-800"></i>
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
      {showQuantityModal && quantityAsset && (
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
                <i className="fa-solid fa-times text-xl"></i>
              </button>
            </div>

            <div className="p-10 space-y-10">
              <div className="bg-slate-950/50 p-8 rounded-3xl border border-slate-800 text-center space-y-4">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Available Items</p>
                <p className="text-6xl font-black text-white tracking-widest">{quantityAsset.quantity}</p>
              </div>

              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Taking to Conference</label>
                  <span className="px-4 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-full text-[10px] font-black uppercase">
                    Splitting stock
                  </span>
                </div>

                <div className="flex items-center gap-6">
                  <button
                    onClick={() => setSelectedQuantity(Math.max(1, selectedQuantity - 1))}
                    className="w-20 h-20 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-white rounded-2xl border border-slate-700 transition text-2xl"
                  >
                    <i className="fa-solid fa-minus"></i>
                  </button>

                  <input
                    type="number"
                    min="1"
                    max={quantityAsset.quantity}
                    value={selectedQuantity}
                    onChange={(e) => setSelectedQuantity(Math.min(quantityAsset.quantity, Math.max(1, parseInt(e.target.value) || 1)))}
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-3xl p-6 text-center text-4xl font-black text-white outline-none focus:border-amber-500 transition"
                  />

                  <button
                    onClick={() => setSelectedQuantity(Math.min(quantityAsset.quantity, selectedQuantity + 1))}
                    className="w-20 h-20 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-white rounded-2xl border border-slate-700 transition text-2xl"
                  >
                    <i className="fa-solid fa-plus"></i>
                  </button>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button
                  onClick={() => setShowQuantityModal(false)}
                  className="flex-1 py-5 bg-slate-800 text-slate-400 rounded-2xl font-black uppercase text-[10px] hover:bg-slate-700 hover:text-white transition"
                >
                  Cancel
                </button>
                <button
                  onClick={submitQuantityAssignment}
                  className="flex-[2] py-5 bg-amber-500 text-white rounded-2xl font-black uppercase text-[10px] hover:bg-amber-400 transition shadow-lg shadow-amber-500/20"
                >
                  Add <span className="mx-1 opacity-50">•</span> {selectedQuantity} {selectedQuantity === 1 ? 'Unit' : 'Units'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
