import React, { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface QRLabelModalProps {
  sku: string;
  assetName: string;
  onClose: () => void;
}

export const QRLabelModal: React.FC<QRLabelModalProps> = ({ sku, assetName, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      // Generate QR data URL directly for the print window
      const qrDataUrl = await QRCode.toDataURL(sku, {
        width: 150,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });

      const printWindow = window.open('', '_blank', 'width=800,height=400');
      if (!printWindow) return;

      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>&nbsp;</title>
            <style>
              @page {
                size: 100mm 20mm;
                margin: 0;
              }
              body {
                margin: 0;
                padding: 0;
                width: 100mm;
                height: 20mm;
                background: white;
                color: black !important;
                font-family: Arial, sans-serif;
                overflow: hidden;
              }
              .label-table {
                width: 100mm;
                height: 20mm;
                border: 0; /* Removed debug border */
                border-collapse: collapse;
              }
              .qr-cell {
                width: 25mm;
                text-align: center;
                vertical-align: middle;
                padding: 0;
              }
              .qr-img {
                width: 18mm;
                height: 18mm;
                display: block;
                margin: 0 auto;
              }
              .asset-name {
                font-size: 4pt;
                font-weight: bold;
                white-space: nowrap;
                overflow: hidden;
                width: 24mm;
                margin: 0 auto;
                text-align: center;
              }
              .text-cell {
                padding-left: 2mm;
                padding-top: 1mm;
                vertical-align: top;
                text-align: left;
              }
              .company {
                font-size: 9pt;
                font-weight: 800;
                margin-bottom: 0px;
                text-transform: lowercase;
                line-height: 1;
              }
              .phone {
                font-size: 8pt;
                font-weight: 700;
                margin-bottom: 2mm;
                line-height: 1;
              }
              .sku {
                font-size: 13pt;
                font-weight: 900;
                letter-spacing: 0.5px;
                line-height: 1;
              }
            </style>
          </head>
          <body>
            <table class="label-table">
              <tr>
                <td class="qr-cell">
                  <img src="${qrDataUrl}" class="qr-img" />
                  <div class="asset-name">${assetName}</div>
                </td>
                <td class="text-cell">
                  <div class="company">a m audiovisuals</div>
                  <div class="phone">9845204137</div>
                  <div class="sku">${sku}</div>
                </td>
              </tr>
            </table>
            <script>
              window.onload = () => { 
                setTimeout(() => {
                  window.print();
                  window.close();
                }, 750);
              };
            </script>
          </body>
        </html>
      `);
      printWindow.document.close();
    } catch (err) {
      console.error('Print error:', err);
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
