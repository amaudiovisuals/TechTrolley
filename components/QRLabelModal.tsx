import React, { useEffect, useRef } from 'react';
import { CompanySettings } from '../types';
import QRCode from 'qrcode';

interface QRLabelModalProps {
  assetId?: string;
  sku: string;
  assetName: string;
  assetType?: string;    // J-97: used for future layout variants
  twoSideQr?: boolean;   // J-97: true → dual-QR cable label
  labelLayout?: string;  // J-102: 'single' | 'double' (default 'double')
  onClose: () => void;
  onPrint?: (assetId: string, sku: string) => void;
  companySettings: CompanySettings;
}

export const QRLabelModal: React.FC<QRLabelModalProps> = ({ assetId, sku, assetName, assetType, twoSideQr, labelLayout = 'double', onClose, onPrint, companySettings }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fallback defaults if settings are missing or zero
  const labelWidth = companySettings?.print_label_width || 50;
  const labelHeight = companySettings?.print_label_height || 25;

  useEffect(() => {
    if (canvasRef.current && sku) {
      QRCode.toCanvas(canvasRef.current, sku, {
        width: 220,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      }).catch(console.error);
    }
  }, [sku]);

  const handlePrint = async () => {
    try {
      // 1. Generate QR data URL
      const qrDataUrl = await QRCode.toDataURL(sku, {
        width: 250,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });

      // 2. Build layout HTML — branch on twoSideQr
      let bodyHtml: string;
      let pageStyle: string;

      if (twoSideQr) {
        // ── J-98: DUAL-QR CABLE LABEL ──────────────────────────────────────────
        // 100mm × 25mm landscape: [QR 22mm] | [text 56mm] | [QR 22mm]
        // table-layout: fixed + explicit col widths lock each cell — long SKUs
        // wrap inside the centre column without touching the QR columns.
        pageStyle = `
          @page { size: 100mm 25mm landscape; margin: 0; }
          * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          body { margin: 0; padding: 0; width: 100mm; height: 25mm; background: white;
                 font-family: 'Inter', Arial, sans-serif; overflow: hidden; }
          table  { table-layout: fixed; width: 100mm; height: 25mm;
                   border: 0; border-collapse: collapse; }
          .qr-td { width: 22mm; text-align: center; vertical-align: middle; padding: 0; }
          /* J-101: drift protection — symmetric 2mm+2mm padding, 22-4=18mm exact image fit */
          .qr-td-left  { width: 22mm; text-align: center; vertical-align: middle; padding-left: 2mm; padding-right: 2mm; }
          .qr-td-right { width: 22mm; text-align: center; vertical-align: middle; padding-left: 2mm; padding-right: 2mm; }
          .mid-td { width: 56mm; text-align: center; vertical-align: middle;
                    padding: 0 2mm; overflow: hidden; }
          .company { font-size: 8pt; font-weight: 900; text-transform: uppercase;
                     line-height: 1.1; margin: 0; }
          .phone   { font-size: 7pt; font-weight: 700; line-height: 1.1;
                     margin: 1mm 0; }
          .sku     { font-size: 11pt; font-weight: 900; line-height: 1.2;
                     word-break: break-all; margin: 0; }
        `;
        bodyHtml = `
          <table>
            <colgroup>
              <col style="width:22mm">
              <col style="width:56mm">
              <col style="width:22mm">
            </colgroup>
            <tr>
              <td class="qr-td-left">
                <img src="${qrDataUrl}" width="68" height="68"
                     style="display:block;margin:0 auto;width:18mm;height:18mm;flex-shrink:0" />
              </td>
              <td class="mid-td">
                <div class="company">${companySettings?.name || 'AM Audiovisuals'}</div>
                <div class="phone">${companySettings?.phone || '9845204137'}</div>
                <div class="sku">${sku}</div>
              </td>
              <td class="qr-td-right" style="transform:scaleX(-1)">
                <img src="${qrDataUrl}" width="68" height="68"
                     style="display:block;margin:0 auto;width:18mm;height:18mm;flex-shrink:0" />
              </td>
            </tr>
          </table>
        `;
      } else if (labelLayout === 'double') {
        // ── J-103: DOUBLE / MICRO TAG LABEL ────────────────────────────────────
        // 100mm × 20mm landscape: [QR 22mm | Text 28mm | QR 22mm | Text 28mm]
        // = 22+28+22+28 = 100mm exactly.
        //
        // Scissor gutter math (dead-centre at 50mm):
        //   Left  text-cell padding-right: 4mm  →  blank from 46mm → 50mm
        //   Right QR-cell  padding-left:   2mm  →  blank from 50mm → 52mm
        //   Combined white gutter = 4mm + 2mm = 6mm centred on the 50mm mark.
        //
        // Workable text width per half = 28mm − 4mm (right pad) = 24mm.
        pageStyle = `
          @page { size: 100mm 20mm landscape; margin: 0; }
          * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          body { margin: 0; padding: 0; width: 100mm; height: 20mm; background: white;
                 color: black !important; font-family: 'Inter', Arial, sans-serif; overflow: hidden; }
          table  { table-layout: fixed; width: 100mm; height: 20mm;
                   border: 0; border-collapse: collapse; }
          /* J-101 drift protection: symmetric 2mm+2mm, 22-4=18mm image */
          .qr-td  { width: 22mm; text-align: center; vertical-align: middle;
                    padding-left: 2mm; padding-right: 2mm; }
          /* 4mm right pad creates the 6mm scissor gutter with next cell's 2mm left pad */
          .txt-td { width: 28mm; vertical-align: middle;
                    padding: 1mm 4mm 1mm 0; overflow: hidden; }
          .company { font-size: 8pt; font-weight: 900; text-transform: uppercase;
                     line-height: 1.1; margin: 0; }
          .phone   { font-size: 8pt; font-weight: 700; line-height: 1.1; margin: 0.5mm 0; }
          .sku     { font-size: 10pt; font-weight: 900; line-height: 1.1;
                     word-break: break-all; margin: 0; }
        `;
        const half = `
          <td class="qr-td">
            <img src="${qrDataUrl}" width="68" height="68"
                 style="display:block;margin:0 auto;width:18mm;height:18mm;flex-shrink:0" />
          </td>
          <td class="txt-td">
            <div class="company">${companySettings?.name || 'AM Audiovisuals'}</div>
            <div class="phone">${companySettings?.phone || '9845204137'}</div>
            <div class="sku">${sku}</div>
          </td>
        `;
        bodyHtml = `
          <table>
            <colgroup>
              <col style="width:22mm">
              <col style="width:28mm">
              <col style="width:22mm">
              <col style="width:28mm">
            </colgroup>
            <tr>${half}${half}</tr>
          </table>
        `;
      } else {
        // ── J-98: STANDARD SINGLE-QR LABEL ─────────────────────────────────────
        // 100mm × 20mm landscape: [QR 22mm] | [text 78mm]
        // table-layout: fixed + explicit col widths guarantee the QR cell
        // never shrinks regardless of SKU length. Long SKUs wrap in the text cell.
        pageStyle = `
          @page { size: 100mm 20mm landscape; margin: 0; }
          * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          body { margin: 0; padding: 0; width: 100mm; height: 20mm; background: white;
                 color: black !important; font-family: 'Inter', Arial, sans-serif; overflow: hidden; }
          table  { table-layout: fixed; width: 100mm; height: 20mm;
                   border: 0; border-collapse: collapse; }
          /* J-101: drift protection — symmetric 2mm+2mm padding, 22-4=18mm exact image fit */
          .qr-td { width: 22mm; text-align: center; vertical-align: middle; padding-left: 2mm; padding-right: 2mm; }
          .txt-td { width: 78mm; vertical-align: middle; padding: 1mm 2mm 1mm 3mm;
                    overflow: hidden; }
          .company { font-size: 10pt; font-weight: 900; text-transform: uppercase;
                     line-height: 1.1; margin: 0 0 0.5mm 0; }
          .phone   { font-size: 10pt; font-weight: 700; line-height: 1.1;
                     margin: 0 0 1.5mm 0; }
          .sku     { font-size: 14pt; font-weight: 900; line-height: 1.2;
                     word-break: break-all; margin: 0; }
        `;
        bodyHtml = `
          <table>
            <colgroup>
              <col style="width:22mm">
              <col style="width:78mm">
            </colgroup>
            <tr>
              <td class="qr-td">
                <img src="${qrDataUrl}" width="68" height="68"
                     style="display:block;margin:0 auto;width:18mm;height:18mm;flex-shrink:0" />
              </td>
              <td class="txt-td">
                <div class="company">${companySettings?.name || 'AM Audiovisuals'}</div>
                <div class="phone">${companySettings?.phone || '9845204137'}</div>
                <div class="sku">${sku}</div>
              </td>
            </tr>
          </table>
        `;
      }


      // 3. Open print window
      const printWindow = window.open('', '_blank', 'width=800,height=400');
      if (!printWindow) return;

      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>&nbsp;</title>
            <style>${pageStyle}</style>
          </head>
          <body>
            ${bodyHtml}
            <script>
              window.onload = () => {
                setTimeout(() => { window.print(); window.close(); }, 750);
              };
            <\/script>
          </body>
        </html>
      `);
      printWindow.document.close();

      // 4. Mark as assigned in backend if onPrint provided
      if (assetId && onPrint) {
        onPrint(assetId, sku);
      }
    } catch (err) {
      console.error('Print error:', err);
      alert("Failed to prepare label for printing.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 rounded-3xl border border-slate-700 shadow-2xl p-8 w-full max-w-sm flex flex-col items-center gap-6">
        {/* Header */}
        <div className="flex justify-between items-center w-full">
          <div>
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">QR Label</p>
            <h3 className="text-lg font-black text-white uppercase">{assetName}</h3>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700 transition"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        {/* QR Code */}
        <div className="bg-white p-4 rounded-2xl shadow-lg">
          <canvas ref={canvasRef} />
        </div>

        {/* SKU Label */}
        <div className="text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">SKU / QR Value</p>
          <p className="text-xl font-black text-sky-400 font-mono tracking-widest">{sku}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 w-full">
          <button
            onClick={handlePrint}
            className="flex-1 py-4 bg-sky-500 text-white rounded-2xl font-black uppercase text-xs hover:bg-sky-400 transition flex items-center justify-center gap-2"
          >
            <i className="fa-solid fa-print" /> Print QR Label
          </button>
          <button
            onClick={onClose}
            className="px-6 py-4 bg-slate-800 text-slate-400 rounded-2xl font-black uppercase text-xs hover:bg-slate-700 hover:text-white transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
