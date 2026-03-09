import React from 'react';
import { Booking, Asset, Client, CompanySettings } from '../types';
import { Logo } from './Logo';

interface ChallanViewProps {
  booking: Booking;
  client: Client;
  assets: Asset[];
  companySettings?: CompanySettings;
}

// Converts a number to Indian-style words (e.g. 45000 → "Rupees Forty Five Thousand Only")
const numberToWords = (num: number): string => {
  if (num === 0) return 'Rupees Zero Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const toWords = (n: number): string => {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '') + ' ';
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred ' + toWords(n % 100);
    if (n < 100000) return toWords(Math.floor(n / 1000)) + 'Thousand ' + toWords(n % 1000);
    if (n < 10000000) return toWords(Math.floor(n / 100000)) + 'Lakh ' + toWords(n % 100000);
    return toWords(Math.floor(n / 10000000)) + 'Crore ' + toWords(n % 10000000);
  };
  return 'Rupees ' + toWords(Math.round(num)).trim() + ' Only';
};

// Formats a date string (YYYY-MM-DD or DD/MM/YYYY) to DD/MM/YYYY
const fmtDate = (d?: string): string => {
  if (!d) return '';
  // already DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d;
  // YYYY-MM-DD
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
};
export const ChallanView: React.FC<ChallanViewProps> = ({ booking, client, assets, companySettings }) => {
  const copies = [
    { label: 'Original for Recipient', key: 'ORIG' },
    { label: 'Duplicate for Transporter', key: 'DUP' },
    { label: 'Triplicate for Supplier', key: 'TRI' },
  ];

  return (
    <>
      {copies.map((copy, index) => (
        <div
          key={copy.key}
          className="print:w-full print:flex print:flex-col"
          style={{ pageBreakAfter: index < copies.length - 1 ? 'always' : 'auto' }}
        >
          <ChallanTemplate
            booking={booking}
            client={client}
            assets={assets}
            companySettings={companySettings}
            copyLabel={copy.label}
            bw={false}
          />
        </div>
      ))}
    </>
  );
};

interface ChallanTemplateProps extends ChallanViewProps {
  copyLabel: string;
  bw: boolean;
}

const ChallanTemplate: React.FC<ChallanTemplateProps> = ({ booking, client, assets, companySettings, copyLabel, bw }) => {
  // Colour tokens — swap to B&W-safe equivalents when bw=true
  const accent = bw ? '#111111' : '#00AEEF';   // blue  → near-black
  const orange = bw ? '#111111' : '#F15A24';   // orange → near-black
  const venueBg = bw ? '#f5f5f5' : '#f0f9ff';
  const venueBrd = bw ? '#999999' : '#bae6fd';
  const venueHd = bw ? '#111111' : '#0369a1';
  const venueTxt = bw ? '#111111' : '#0c4a6e';
  const hdrBg = bw ? '#222222' : '#00AEEF';

  const getDepreciatedPrice = (a: Asset) => {
    const price = a.itemPrice || 0;
    const dep = a.depreciationPercentage || 0;
    return price * (1 - dep / 100);
  };

  const totalValue = assets.reduce((sum, a) => sum + getDepreciatedPrice(a), 0);

  return (
    <div className="p-6 bg-white max-w-[210mm] mx-auto shadow-sm border border-gray-200 rounded-md my-4 font-sans print:shadow-none print:m-0 print:p-[10mm] print:w-[210mm] print:min-h-[297mm] print:box-border print:border-none print:rounded-none relative flex flex-col justify-between">

      {/* ── Header ── */}
      <div className="flex justify-between items-start pb-2 mb-2" style={{ borderBottom: `2px solid ${accent}` }}>
        {/* Left: Company info */}
        <div>
          <Logo size="sm" companySettings={companySettings} variant="challan" />
          <div className="mt-1 text-[9px] text-gray-900 font-medium leading-snug">
            <p className="font-black text-gray-900 uppercase tracking-tighter text-[10px]">{companySettings?.name || 'TECH TROLLEY'}</p>
            <p className="whitespace-pre-wrap">{companySettings?.address || 'Warehouse Complex 7, Industrial Area Phase II, New Delhi - 110020.'}</p>
            <p>GST: {companySettings?.gst_number || '07AAMAU9988Z2Z1'}</p>
            <p>Tel: {companySettings?.phone || '+91 9999 888 777'} | Email: {companySettings?.email || 'support@amaudiovisuals.in'}</p>
          </div>
        </div>

        {/* Right: Challan meta + vehicle */}
        <div className="text-right pt-20">
          <div className="mb-0.5">
            <span className="text-[8px] font-black uppercase tracking-widest border border-gray-900 px-2 py-0.5 rounded text-gray-900">{copyLabel}</span>
          </div>
          <div>
            <h2 className="text-lg font-black text-gray-900 tracking-tighter uppercase leading-none">Delivery Challan</h2>
            <p className="text-[9px] font-black uppercase tracking-widest" style={{ color: orange }}>Challan No: {booking.challanNumber}</p>
            <div className="mt-0.5 text-right">
              <p className="text-[9px] font-black text-gray-900 uppercase tracking-widest">
                <span className="text-gray-900 mr-1">Date:</span>
                {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              </p>
            </div>
            <div className="mt-1 pt-1 text-right space-y-0.5" style={{ borderTop: `1px dashed #999` }}>
              <p className="text-[7px] font-black text-gray-900 uppercase tracking-[0.3em]">Vehicle Details</p>
              <p className="text-[9px] font-bold text-gray-900 flex items-center justify-end gap-1.5">
                <i className="fa-solid fa-truck text-[8px]" style={{ color: orange }}></i>
                <span className="text-gray-900">Vehicle No:</span>
                <span className="font-black uppercase tracking-wider">{booking.vehicleNumber || '—'}</span>
              </p>
              <p className="text-[9px] font-bold text-gray-900 flex items-center justify-end gap-1.5">
                <i className="fa-solid fa-phone text-[8px]" style={{ color: accent }}></i>
                <span className="text-gray-900">Driver Ph:</span>
                <span className="font-black tracking-wider">{booking.driverPhone || '—'}</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Consignee + Event ── */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <h4 className="text-[7px] font-black text-gray-900 uppercase tracking-[0.3em] mb-0.5">Consignee Information</h4>
          <p className="font-black text-gray-900 text-[10px] leading-tight uppercase tracking-tighter">{booking.associationName}</p>
          <div className="mt-0.5 space-y-0.5">
            <p className="text-[9px] text-gray-900 font-bold flex items-center gap-2">
              <i className="fa-solid fa-user-doctor text-[8px]" style={{ color: orange }}></i>
              {booking.contactPerson}
            </p>
            <p className="text-[9px] text-gray-900 font-bold flex items-center gap-2">
              <i className="fa-solid fa-phone text-[8px]" style={{ color: accent }}></i>
              {booking.contactPhone}
            </p>
            <p className="text-[8px] text-gray-900 font-medium uppercase leading-tight">{booking.billingAddress}</p>
            {booking.gstNumber && <p className="text-[8px] font-bold text-gray-900 uppercase">GST: {booking.gstNumber}</p>}
          </div>
        </div>
        <div className="text-right flex flex-col justify-between">
          <div>
            <h4 className="text-[7px] font-black text-gray-900 uppercase tracking-[0.3em] mb-0.5">Event Context</h4>
            <p className="font-black text-gray-900 leading-tight text-[10px] tracking-tighter uppercase">{booking.conferenceName}</p>
            <div className="mt-1 p-1.5 rounded-lg text-right" style={{ backgroundColor: venueBg, border: `1px dashed ${venueBrd}` }}>
              <h5 className="text-[7px] font-black uppercase mb-0.5 tracking-[0.2em]" style={{ color: venueHd }}>Deployment Venue</h5>
              <p className="text-[9px] font-black leading-tight uppercase tracking-tighter" style={{ color: venueTxt }}>
                {booking.transportAddress || booking.venue}
              </p>
            </div>
            <p className="text-[9px] font-black mt-1 italic uppercase tracking-widest" style={{ color: orange }}>
              {fmtDate(booking.startDate)} — {fmtDate(booking.endDate)}
            </p>
          </div>
        </div>
      </div>

      {/* ── Asset Table ── */}
      <table className="w-full mb-2 border-collapse">
        <thead>
          <tr style={{ backgroundColor: hdrBg, WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>
            <th className="py-1 px-2 text-left text-[7px] font-black text-white uppercase tracking-[0.2em] w-6" style={{ color: 'white', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>Seq</th>
            <th className="py-1 px-2 text-left text-[7px] font-black text-white uppercase tracking-[0.2em]" style={{ color: 'white', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>Asset Specification</th>
            <th className="hidden print:table-cell py-1 px-2 text-left text-[7px] font-black text-white uppercase tracking-[0.2em]" style={{ color: 'white', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>Type</th>
            <th className="py-1 px-2 text-left text-[7px] font-black text-white uppercase tracking-[0.2em]" style={{ color: 'white', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>Identifiers</th>
            <th className="py-1 px-2 text-right text-[7px] font-black text-white uppercase tracking-[0.2em] w-16 print:hidden" style={{ color: 'white', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>Unit Rate</th>
            <th className="py-1 px-2 text-right text-[7px] font-black text-white uppercase tracking-[0.2em] w-10" style={{ color: 'white', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>Qty</th>
            <th className="py-1 px-2 text-right text-[7px] font-black text-white uppercase tracking-[0.2em] w-20 print:hidden" style={{ color: 'white', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as React.CSSProperties}>Total</th>
          </tr>
        </thead>
        <tbody className="text-[8px]">
          {assets.map((asset, index) => (
            <tr key={asset.id} className="border-b border-gray-300 page-break-inside-avoid">
              <td className="py-0.5 px-2 text-gray-900 font-bold">{index + 1}</td>
              <td className="py-0.5 px-2">
                <span className="font-black text-gray-900 uppercase tracking-tighter mr-2">{asset.aliasName || asset.sku}</span>
                <span className="text-[7px] font-bold uppercase tracking-widest print:hidden" style={{ color: accent }}>{asset.type}</span>
              </td>
              <td className="hidden print:table-cell py-0.5 px-2 text-[8px] font-bold text-gray-900 uppercase tracking-wide">{asset.type}</td>
              <td className="py-0.5 px-2 text-gray-900 font-mono font-bold tracking-widest uppercase text-[8px]">
                {asset.serialNumber} <span>/</span> {asset.sku}
              </td>
              <td className="py-0.5 px-2 text-right text-gray-900 font-mono print:hidden">₹{Math.round(getDepreciatedPrice(asset)).toLocaleString() || '0'}</td>
              <td className="py-0.5 px-2 text-right text-gray-900 font-black">1</td>
              <td className="py-0.5 px-2 text-right text-gray-900 font-bold print:hidden">₹{Math.round(getDepreciatedPrice(asset)).toLocaleString() || '0'}</td>
            </tr>
          ))}
          {assets.length === 0 && (
            <tr>
              <td colSpan={7} className="py-8 text-center text-[10px] font-black text-gray-900 uppercase tracking-widest">No assets selected.</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={7} className="pt-1 px-2 text-right text-[8px] font-black text-gray-900 uppercase tracking-widest" style={{ borderTop: '2px solid #999' }}>
              Total Quantity: <span style={{ color: accent }}>{assets.length}</span>
            </td>
          </tr>
          <tr className="bg-gray-50">
            <td colSpan={7} className="py-0.5 px-2 text-right text-[8px] font-black text-gray-900 uppercase tracking-widest">
              Approximate Value of Goods: <span className="text-[10px]" style={{ color: orange }}>₹{totalValue.toLocaleString()}</span>
            </td>
          </tr>
          <tr>
            <td colSpan={7} className="pb-1 px-2 text-right text-[7px] text-gray-900 italic font-medium">
              ({numberToWords(totalValue)})
            </td>
          </tr>
        </tfoot>
      </table>

      {/* ── Declaration + Signatures ── */}
      <div className="mt-2 page-break-inside-avoid">
        <div className="px-3 py-2 mb-3 rounded-md bg-gray-50" style={{ border: '1px dashed #999' }}>
          <p className="text-[8px] text-gray-900 font-medium leading-relaxed">
            The above items are used goods and are taken for supply of service and the same will be returned back on or by{' '}
            <span className="font-black uppercase tracking-wide">{fmtDate(booking.endDate)}</span>.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-12">
          <div className="text-center pt-2" style={{ borderTop: '2px double #555' }}>
            <p className="text-[8px] font-black text-gray-900 uppercase tracking-[0.4em]">Receiver Acknowledgement</p>
            <div className="mt-4 h-8 mx-auto w-36" style={{ borderBottom: '1px solid #555' }}></div>
            <p className="text-[7px] text-gray-900 mt-1 font-bold uppercase tracking-widest">Receiver's Name &amp; Signature</p>
            <p className="text-[7px] text-gray-700 mt-0.5 font-bold uppercase tracking-widest">Phone: _______________</p>
          </div>
          <div className="text-center pt-2" style={{ borderTop: '2px double #555' }}>
            <p className="text-[8px] font-black text-gray-900 uppercase tracking-[0.4em]">Authorized Dispatch</p>
            <div className="mt-4 h-8 mx-auto w-36" style={{ borderBottom: '1px solid #555' }}></div>
            <p className="text-[7px] text-gray-900 mt-1 font-bold uppercase tracking-widest italic">{companySettings?.name || 'TECH TROLLEY'}</p>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="mt-4 pt-2 text-[6px] text-gray-900 text-center leading-relaxed font-black uppercase tracking-[0.3em]" style={{ borderTop: '1px solid #999' }}>
        Technical Desk: {companySettings?.phone || '+91 9999 888 777'} | {companySettings?.email || 'support@amaudiovisuals.in'}
        <br />
        <span>Tech Trolley Monitor System</span> • Internal Asset of{' '}
        <span style={{ color: bw ? '#111' : '#00AEEF' }}>{companySettings?.name || 'TECH TROLLEY'}</span>
        <br />
        <span className="text-[9px] font-black text-gray-900 uppercase tracking-widest mt-0.5 inline-block border border-gray-400 px-1 rounded-sm">{copyLabel}</span>
        {bw && <span className="ml-2 text-[7px] font-black uppercase tracking-widest text-gray-500">[B&amp;W]</span>}
      </div>
    </div>
  );
};
