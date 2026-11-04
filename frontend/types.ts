
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
  inventory_mode?: 'unreviewed' | 'shared_warehouse' | 'external_supplier';
  created_at: string;
}


export interface Asset {
  challanLine?: ChallanLine;
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
  quantity_tracking?: boolean;
  quantity_available?: number;
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
  staff_revision?: number;
  // Sub-asset / parent-child fields
  parent_asset?: number | null;
  sub_assets?: Asset[];
  current_conference_name?: string | null;
  subrental_company?: number | string | null;
  subrental_company_name?: string;
  subrental_inventory_mode?: 'unreviewed' | 'shared_warehouse' | 'external_supplier';
  warehouse_managed?: boolean;
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
  role?: 'admin' | 'boss' | 'godown_incharge' | 'technician' | 'accounts';
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
  lifecycle_state?: 'open' | 'completed' | 'archived';
  completed_at?: string | null;
  completed_by?: number | null;
  archived_at?: string | null;
  archived_by?: number | null;
  consumable_ledger?: Record<string, any>;
  consumable_assets_details?: any[];
  quantity_assets_details?: any[];
  truck_manifest?: { master_document_id: string; entries: { master_line_id: string; truck_id: number; quantity: number; document_line_id: string }[] } | null;
  quantity_allocations?: Record<string, { asset_id: number; reserved: number; dispatched: number;
    awaiting_verification: number; dispatched_total: number; verified_total: number }>;
  challan_documents?: ChallanDocument[];
  revision?: number;
  consumable_data?: Record<string, any>;
  flag_log?: any[];
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
  status?: 'Pending' | 'Active' | 'Completed' | 'Cancelled';
  operatorId?: string;
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
  is_invoiced?: boolean; // Track if challan has been marked invoiced by accounts
  isInvoiced?: boolean;
  transfer_log?: any[];
  truckChallans?: TruckChallan[];
  // Backend / Legacy compatibility properties
  name?: string;
  association?: string;
  start_date?: string;
  end_date?: string;
  type?: any;
  requirements?: string[];
  challan_assets_details?: any[];
}

export interface ChallanLine {
  id: string;
  asset_id: number | null;
  ticket_item_id: number | null;
  supplier_id: number | null;
  source_kind: 'owned' | 'supplier' | 'manual';
  snapshot: Record<string, string>;
  quantity: number;
  unit_value: string;
  position: number;
}

export interface ChallanDocument {
  id: string;
  conference_id: number;
  truck_id: number | null;
  scope: string;
  revision: number;
  number: string;
  state: 'draft' | 'issued';
  document_date: string | null;
  total_override: string | null;
  header: Record<string, any>;
  provenance: string;
  lines: ChallanLine[];
}

export interface ChallanSave {
  /** Local retry envelope; sent to the manifest route, never the generic document route. */
  manifest_command?: Record<string, any>;
  request_id: string;
  expected_revision: number;
  expected_event_revision: number;
  number: string;
  total_override: number | null;
  document_date: string | null;
  state: 'draft' | 'issued';
  correction_reason: string;
  lines: ChallanLine[];
}

export interface TruckChallan {
  id: string;
  conference: string;
  truck_number: number;
  label: string;
  vehicle_number: string;
  driver_phone: string;
  /** Each truck's own unique challan number, separate from the master challan */
  challan_number: string;
  assets: string[];  // asset IDs as strings
  asset_quantities?: Record<string, number>;
  assets_details?: any[];
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
  /** Fixed prefix in challan number (e.g. "AMDL" → "26-27/AMDL-00122") */
  challan_prefix?: string;
  /** Financial year the current counter belongs to (e.g. "26-27"). Auto-managed. */
  challan_fy?: string;
}

export interface SubrentalTicketItem {
  supplier_balance?: {state:'opening_review_required'|'inconsistent'|'recorded';revision?:number;received?:number;returned?:number;cancelled?:number;pending_receipt?:number;with_us?:number;closed?:boolean;provenance?:string;ordered?:number};
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
  conference_revision?: number;
  created_at: string;
  available_from: string;
  available_till: string;
  items: SubrentalTicketItem[];
}
