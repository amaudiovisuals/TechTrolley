import React, { useEffect, useRef } from 'react';
import { CompanySettings } from '../types';
import QRCode from 'qrcode';

interface QRLabelModalProps {
  assetId?: string;
  sku: string;
  assetName: string;
  onClose: () => void;
  onPrint?: (assetId: string, sku: string) => void;
  companySettings: CompanySettings;
}

export const QRLabelModal: React.FC<QRLabelModalProps> = ({ assetId, sku, assetName, onClose, onPrint, companySettings }) => {
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
        width: 300, // Higher resolution for professional print
        margin: 1,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });

      // 2. Create or reuse hidden iframe
      let iframe = document.getElementById('sticker-print-iframe') as HTMLIFrameElement;
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'sticker-print-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.visibility = 'hidden';
        document.body.appendChild(iframe);
      }

      const doc = iframe.contentWindow?.document;
      if (!doc) return;

      doc.open();
      doc.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Print Label - ${sku}</title>
            <style>
              /* CRITICAL: Force exact dimensions and remove all browser defaults */
              @page {
                size: ${labelWidth}mm ${labelHeight}mm;
                margin: 0;
              }
              html, body {
                margin: 0;
                padding: 0;
                width: ${labelWidth}mm;
                height: ${labelHeight}mm;
                background: white;
                color: black;
                font-family: 'Inter', -apple-system, sans-serif;
                overflow: hidden;
                box-sizing: border-box;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }
              * {
                box-sizing: border-box;
              }
              .sticker {
                width: ${labelWidth}mm;
                height: ${labelHeight}mm;
                display: flex;
                align-items: center;
                padding: 1.5mm 3mm;
                border: 0.1mm solid transparent; /* Helps prevent bleed on some drivers */
                position: relative;
              }
              .qr-box {
                width: calc(${labelHeight}mm - 4mm); /* Height-based sizing for square QR */
                max-width: 35%;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
              }
              .qr-img {
                width: 100%;
                height: auto;
                display: block;
              }
              .asset-name {
                font-size: 5pt;
                font-weight: 800;
                text-align: center;
                white-space: nowrap;
                overflow: hidden;
                width: 100%;
                margin-top: 1px;
                text-transform: uppercase;
                letter-spacing: -0.1px;
              }
              .content-box {
                flex: 1;
                padding-left: 4mm;
                display: flex;
                flex-direction: column;
                justify-content: center;
                min-width: 0;
              }
              .company {
                font-size: 9pt;
                font-weight: 900;
                margin: 0;
                line-height: 1.1;
                text-transform: uppercase;
                letter-spacing: 0.2px;
                white-space: nowrap;
                overflow: hidden;
              }
              .phone {
                font-size: 7.5pt;
                font-weight: 700;
                margin: 0.5mm 0 1.5mm 0;
                line-height: 1;
                opacity: 0.8;
              }
              .sku {
                font-size: ${labelHeight > 25 ? '16pt' : '13pt'};
                font-weight: 950;
                margin: 0;
                line-height: 1;
                color: black;
                letter-spacing: -0.5px;
                white-space: nowrap;
                overflow: hidden;
              }
              
              /* Force no hidden margins or headers/footers */
              @media print {
                body {
                  -webkit-print-color-adjust: exact;
                }
              }
            </style>
          </head>
          <body>
            <div class="sticker">
              <div class="qr-box">
                <img src="${qrDataUrl}" class="qr-img" />
                <div class="asset-name">${assetName}</div>
              </div>
              <div class="content-box">
                <p class="company">${companySettings.name || 'AM Audiovisuals'}</p>
                <p class="phone">${companySettings.phone || '9845204137'}</p>
                <p class="sku">${sku}</p>
              </div>
            </div>
            <script>
              window.onload = () => {
                setTimeout(() => {
                  window.print();
                }, 300);
              };
            </script>
          </body>
        </html>
      `);
      doc.close();
      
      // 3. Mark as assigned in backend if onPrint provided
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
