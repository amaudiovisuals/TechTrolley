import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChallanView } from '../components/ChallanView';
const supplier = { id: '7002', sku: 'AM-QR', aliasName: 'Same model', serialNumber: 'AM-SERIAL', type: 'Laptops', quantity: 1, itemPrice: 100, depreciationPercentage: 0, purchasedDate: '', subrental_company: 7, subrental_company_name: 'AM test supplier', barcode: 'AM-QR' };
const main = { ...supplier, id: '7001', sku: 'MAIN-QR', serialNumber: 'MAIN-SERIAL', barcode: 'MAIN-QR', subrental_company: null, subrental_company_name: '' };
const overlap = new URLSearchParams(location.search).has('overlap');
const manual = { ...main, id: 'new-manual-fixture', sku: 'ADHOC-FIXTURE', aliasName: 'Manual fixture row', isTemporary: true };
createRoot(document.getElementById('root')!).render(<ChallanView
  booking={{ id: overlap ? 'synthetic-overlap' : 'synthetic-owners', conferenceName: 'Synthetic mixed-owner event', associationName: 'Synthetic customer', assets: ['7001','7002'], startDate: '2026-11-03', endDate: '2026-11-04', venue: 'Synthetic venue' } as any}
  client={{ name: 'Synthetic customer' } as any}
  assets={[main, supplier, manual] as any}
  companySettings={{ name: 'Pvt Ltd test issuer' } as any}
  subrentalTickets={overlap ? [{ id: 1, company_name: 'AM test supplier', items: [{ id: 1, asset: 7002, quantity: 1, rental_price: 100 }] }] : []}
/>);
