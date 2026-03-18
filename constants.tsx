
import { Asset, AssetStatus, AssetCategory, Client, Booking } from './types';

export const MOCK_ASSETS: Asset[] = [
  {
    id: 'AST001',
    sku: 'SKU-SOUND-001',
    aliasName: 'Main Sound Array',
    macAddress: '',
    imeiNumber1: '',
    imeiNumber2: '',
    serialNumber: 'SN-9921',
    description: 'JBL Pro Sound Array VRX932LAP',
    isBarcodeAdded: true,
    type: AssetCategory.SOUND,
    purchasedDate: '2024-01-01',
    itemPrice: 125000,
    depreciationPercentage: 10,
    availableFrom: '2024-01-01',
    availableTill: '2026-01-01',
    createdAt: '2024-01-01T00:00:00Z',
    barcode: '789001',
    status: AssetStatus.IN_USE,
    condition: 'Excellent',
    lastMaintained: '2024-04-01',
    quantity: 1
  },
  {
    id: 'AST002',
    sku: 'SKU-IT-002',
    aliasName: 'Producer Laptop',
    macAddress: '00:1A:2B:3C:4D:5E',
    imeiNumber1: '',
    imeiNumber2: '',
    serialNumber: 'AAPL-001',
    description: 'MacBook Pro 16" M3 A2991',
    isBarcodeAdded: true,
    type: AssetCategory.IT,
    purchasedDate: '2024-02-01',
    itemPrice: 350000,
    depreciationPercentage: 15,
    availableFrom: '2024-02-01',
    availableTill: '2027-02-01',
    createdAt: '2024-02-01T00:00:00Z',
    barcode: '789002',
    status: AssetStatus.AVAILABLE,
    condition: 'Good',
    lastMaintained: '2024-04-15',
    quantity: 1
  },
  {
    id: 'AST003',
    sku: 'SKU-LED-003',
    aliasName: 'Stage LED Panel 1',
    macAddress: '',
    imeiNumber1: '',
    imeiNumber2: '',
    serialNumber: 'LED-WALL-X1',
    description: 'P3.9 LED Wall Panel Absen PL3.9W',
    isBarcodeAdded: true,
    type: AssetCategory.LED,
    purchasedDate: '2024-03-01',
    itemPrice: 45000,
    depreciationPercentage: 20,
    availableFrom: '2024-03-01',
    availableTill: '2025-03-01',
    createdAt: '2024-03-01T00:00:00Z',
    barcode: '789003',
    status: AssetStatus.IN_USE,
    condition: 'Excellent',
    lastMaintained: '2024-03-20',
    quantity: 1
  },
];

export const MOCK_CLIENTS: Client[] = [
  { id: 'CL001', name: 'All India Medical Association', type: 'Medical Association', contactPerson: 'Dr. Ramesh Kumar', email: 'admin@aima.org', phone: '+91 9876543210' },
  { id: 'CL002', name: 'State Surgeons Guild', type: 'Medical Association', contactPerson: 'Dr. Anita Desai', email: 'anita@ssguild.in', phone: '+91 8877665544' },
  { id: 'CL003', name: 'TechEvents Corp', type: 'Corporate', contactPerson: 'Mark Zuckerberg', email: 'mark@techevents.com', phone: '+1 555 0199' },
];

export const MOCK_BOOKINGS: Booking[] = [
  {
    id: 'BK1001',
    conferenceName: 'International Cardiology Summit 2024',
    associationName: 'All India Medical Association',
    billingAddress: 'Medical Hub, South Extension, New Delhi - 110049',
    contactPerson: 'Dr. Ramesh Kumar',
    contactPhone: '9876543210',
    contactEmail: 'admin@aima.org',
    conferenceType: 'Medical Conference',
    venue: 'Convention Center, Delhi',
    startDate: '2024-05-15',
    endDate: '2024-05-18',
    assets: ['AST001', 'AST005'],
    status: 'Active',
    operatorId: 'OP01',
    challanNumber: 'DC-2024-055',
    // Linked to a mock client for data consistency
    clientId: 'CL001'
  }
];
