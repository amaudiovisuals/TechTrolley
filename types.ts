
export enum AssetStatus {
  AVAILABLE = 'Available',
  IN_USE = 'In Use',
  DAMAGED = 'Damaged',
  CROSSCHECK = 'Crosscheck'
}

export enum AssetCategory {
  SOUND = 'Sound System',
  AV = 'AV Equipment',
  IT = 'IT & Networking',
  LED = 'LED Wall',
  LIGHTING = 'Lighting',
  POWER = 'Power',
  TRUSS = 'Truss & Rigging',
  OTHER = 'Other'
}

export interface Asset {
  id: string;
  sku: string;
  aliasName: string;
  macAddress: string;
  imeiNumber1: string;
  imeiNumber2: string;
  serialNumber: string;
  description: string;
  isBarcodeAdded: boolean;
  type: string;
  purchasedDate: string;
  itemPrice: number;
  depreciationPercentage: number;
  availableFrom: string;
  availableTill: string;
  createdAt: string;
  // System fields
  barcodeType?: string;
  barcode: string;
  qrCode?: string;
  status: AssetStatus;
  condition: string;
  lastMaintained: string;
  assigned_to?: number;
  assigned_to_name?: string;
  // Sub-asset / parent-child fields
  parent_asset?: number | null;
  sub_assets?: Asset[];
  current_conference_name?: string | null;
  // Legacy / Optional compatibility
  name?: string;
  brand?: string;
  modelNumber?: string;
}

export interface Employee {
  id: string;
  name: string;
  employee_id: string;
  department: string;
  email: string;
  phone: string;
  joined_at: string;
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
  status: 'Pending' | 'Active' | 'Completed' | 'Cancelled';
  operatorId: string;
  challanNumber: string;
  clientId?: string;
  transportAddress?: string;
  gstNumber?: string;
  vehicleNumber?: string;
  driverPhone?: string;
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
  logo?: string | null;
  powered_by_name?: string;
  dashboard_config?: Record<string, boolean>;
  theme_template?: 'blue' | 'green';
}
