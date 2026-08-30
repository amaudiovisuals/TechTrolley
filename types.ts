
export enum AssetStatus {
  AVAILABLE = 'Available',
  IN_USE = 'In Use',
  DAMAGED = 'Damaged',
  CROSSCHECK = 'Crosscheck',
  ON_SERVICE = 'On Service',
  EXPIRED = 'Expired',
  MISSING = 'Missing'
}

export enum AssetFlag {
  NONE = '',
  EXPIRED = 'Expired',
  REQUIRED_SERVICE = 'Required Service',
  ON_SERVICE = 'On Service',
  MISSING = 'Missing'
}

export enum AssetCategory {
  SPEAKERS = 'Speakers & Audio',
  MIXERS = 'Audio Mixers',
  MICS = 'Microphones',
  LAPTOPS = 'Laptops',
  SMARTPHONES = 'Smartphones',
  COMPUTERS = 'Computers & Servers',
  IT = 'IT & Networking',
  PERIPHERALS = 'Peripherals',
  MONITORS = 'Monitors',
  TVS = 'TVs',
  PROJECTORS = 'Projectors',
  LIGHTING = 'Lighting & LED',
  SWITCHERS = 'Video Switchers',
  CAPTURE = 'Capture Cards',
  CONVERTERS = 'Splitters & Converters',
  CAMERAS = 'Cameras',
  POWER = 'UPS & Power',
  PRINTERS = 'Printers',
  CONSUMABLES = 'Consumables',
  CABLE = 'Cable',
  OTHER = 'Other'
}

export enum UICategory {
  IT = 'IT & Networking',
  AV = 'AV Equipment',
  SOUND = 'Sound System',
  DISPLAY = 'Display System',
  CABLE = 'Cable',
  CONSUMABLES = 'Consumables',
  LIGHTING = 'Lighting & Effects',
  OTHER = 'Other'
}

export const CATEGORY_MAP: Record<string, UICategory> = {
  // Original DB types -> UI Categories
  'Speakers & Audio': UICategory.SOUND,
  'Audio Mixers': UICategory.SOUND,
  'Microphones': UICategory.SOUND,
  'Laptops': UICategory.IT,
  'Smartphones': UICategory.IT,
  'Computers & Servers': UICategory.IT,
  'IT & Networking': UICategory.IT,
  'Peripherals': UICategory.IT,
  'UPS & Power': UICategory.IT,
  'Printers': UICategory.IT,
  'Monitors': UICategory.DISPLAY,
  'TVs': UICategory.DISPLAY,
  'Projectors': UICategory.DISPLAY,
  'Video Switchers': UICategory.AV,
  'Capture Cards': UICategory.AV,
  'Cameras': UICategory.AV,
  'Splitters & Converters': UICategory.CABLE,
  'Consumables': UICategory.CONSUMABLES,
  'Cable': UICategory.CABLE,
  'Lighting & LED': UICategory.LIGHTING,
  
  // Also map UI Categories to themselves (if not already listed above)
  'Sound System': UICategory.SOUND,
  'Display System': UICategory.DISPLAY,
  'AV Equipment': UICategory.AV,
  'Lighting & Effects': UICategory.LIGHTING,
  'Other': UICategory.OTHER
};

export interface SubrentalCompany {
  id: string;
  name: string;
  address: string;
  gst_number: string;
  created_at: string;
}


export interface Asset {
  id: string | number;
  sku: string;
  aliasName: string;
  alias_name?: string; // Compatibility
  macAddress: string;
  mac_address?: string; // Compatibility
  imeiNumber1: string;
  imei_number_1?: string; // Compatibility
  imeiNumber2: string;
  imei_number_2?: string; // Compatibility
  serialNumber: string;
  serial_number?: string; // Compatibility
  description: string;
  isBarcodeAdded: boolean;
  type: string;
  quantity: number;
  purchasedDate: string;
  purchased_date?: string; // Compatibility
  itemPrice: number;
  item_price?: number; // Compatibility
  depreciationPercentage: number;
  depreciation_percentage?: number; // Compatibility
  availableFrom: string;
  available_from?: string; // Compatibility
  availableTill: string;
  available_till?: string; // Compatibility
  createdAt: string;
  created_at?: string; // Compatibility
  // System fields
  barcodeType?: string;
  barcode: string;
  qrCode?: string;
  status: AssetStatus;
  flag?: AssetFlag | string;
  condition: string;
  lastMaintained: string;
  isTemporary?: boolean;
  assigned_to?: number;
  assigned_to_name?: string;
  // Sub-asset / parent-child fields
  parent_asset?: number | null;
  sub_assets?: Asset[];
  current_conference_name?: string | null;
  subrental_company?: number | string | null;
  // Legacy / Optional compatibility
  name?: string;
  brand?: string;
  modelNumber?: string;
}

export type Page = 'Dashboard' | 'Assets' | 'Employees' | 'Conferences' | 'Billing' | 'Reports' | 'Settings' | 'Subrentals';

export interface Employee {
  id: string;
  name: string;
  employee_id: string;
  department: string;
  email: string;
  phone: string;
  joined_at: string;
  role?: 'admin' | 'godown_incharge' | 'technician' | 'accounts';
}

export interface Client {
  id: string;
  name: string;
  type: 'Medical Association' | 'Corporate' | 'Private';
  contactPerson: string;
  email: string;
  phone: string;
}

export type ConferenceType = 'Medical Conference' | 'Personal Rental';

export interface Booking {
  id: string;
  conferenceName: string;
  associationName: string;
  billingAddress: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string;
  conferenceType: ConferenceType;
  venue: string;
  startDate: string;
  endDate: string;
  assets: string[];
  crosscheckAssets?: string[];
  challanAssets?: string[];
  staged_assets?: string[];
  status: 'Pending' | 'Active' | 'Completed' | 'Cancelled';
  operatorId: string;
  challanNumber: string;
  clientId?: string;
  transportAddress?: string;
  gstNumber?: string;
  vehicleNumber?: string;
  driverPhone?: string;
  challanDate?: string;
  challan_date?: string;
  assigned_employees?: number[];
  pdf_document?: string | null;
  approximate_value?: number;
  isAudit?: boolean; // J-109: When true, assets in this conference do not lock other events
  transfer_log?: any[];
  truckChallans?: TruckChallan[];
}

export interface TruckChallan {
  id: string;
  conference: string;
  truck_number: number;
  label: string;
  vehicle_number: string;
  driver_phone: string;
  assets: string[];  // asset IDs as strings
  created_at: string;
}

export interface DeliveryChallanRecord {
  id: string;
  challanNumber: string;
  bookingId: string;
  conferenceName: string;
  clientName: string;
  dateIssued: string;
  issuedBy: string;
  assetCount: number;
}

export interface CompanySettings {
  name: string;
  address: string;
  phone: string;
  email: string;
  gst_number: string;
  website: string;
  logo: string | null;
  powered_by_name: string;
  dashboard_config: Record<string, any>;
  theme_template?: 'blue' | 'green';
  print_label_width: number;
  print_label_height: number;
  next_challan_number?: number;
}

export interface SubrentalTicketItem {
  id: string | number;
  ticket: string | number;
  asset: string | number;
  asset_details?: Asset;
  rental_price: number;
  quantity: number;
}

export interface SubrentalTicket {
  id: string | number;
  company: string | number;
  company_name?: string;
  conference: string | number;
  conference_name?: string;
  created_at: string;
  available_from: string;
  available_till: string;
  items: SubrentalTicketItem[];
}
