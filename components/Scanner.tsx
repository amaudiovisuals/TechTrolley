import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface ScannerProps {
  onScan: (decodedText: string) => void;
  onClose: () => void;
}

export const Scanner: React.FC<ScannerProps> = ({ onScan, onClose }) => {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const scannerId = "qr-reader";

    const startScanner = async () => {
      try {
        const hasCamera = await Html5Qrcode.getCameras();
        if (!hasCamera || hasCamera.length === 0) {
          throw new Error("No camera found");
        }

        if (!isMounted) return;

        scannerRef.current = new Html5Qrcode(scannerId);

        await scannerRef.current.start(
          { facingMode: "environment" },
          {
            fps: 20,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const minEdgeSize = Math.min(viewfinderWidth, viewfinderHeight);
              const qrboxSize = Math.floor(minEdgeSize * 0.7);
              return { width: qrboxSize, height: qrboxSize };
            }
          },
          (decodedText) => {
            if (isMounted) onScan(decodedText.trim());
          },
          () => {
            // Ignore scan errors (usually just means no code found yet)
          }
        );

        if (isMounted) setIsReady(true);

      } catch (err: any) {
        console.error("Camera error:", err);
        if (isMounted) {
          setCameraError(err?.message || "Camera access denied. Please enable camera permissions in your settings.");
        }
      }
    };

    startScanner();

    return () => {
      isMounted = false;
      if (scannerRef.current) {
        scannerRef.current.stop().then(() => {
          scannerRef.current?.clear();
        }).catch(console.error);
      }
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black p-0 sm:p-4 animate-in fade-in duration-300">
      <div className="relative w-full h-full sm:h-auto sm:max-w-md bg-slate-900 sm:rounded-[2.5rem] overflow-hidden border-0 sm:border border-slate-800 shadow-2xl">

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-6 left-6 z-50 w-12 h-12 bg-black/40 backdrop-blur-md rounded-full flex items-center justify-center text-white hover:bg-white/20 transition-all border border-white/10 shadow-xl"
        >
          <i className="fa-solid fa-xmark text-xl" />
        </button>

        {/* Minimalist UI Header */}
        <div className="absolute top-6 right-6 z-50 text-right pointer-events-none">
          <p className="text-[10px] font-black text-white/60 uppercase tracking-[0.3em]">Scanner Active</p>
          <p className="text-[8px] font-bold text-sky-400 uppercase tracking-widest mt-0.5 animate-pulse">Focus QR or Barcode</p>
        </div>

        {cameraError ? (
          <div className="h-full flex flex-col items-center justify-center p-12 text-center text-white bg-slate-950">
            <i className="fa-solid fa-camera-slash text-4xl text-red-500 mb-6" />
            <h4 className="text-xl font-black uppercase tracking-tight">Access Denied</h4>
            <p className="text-sm text-slate-400 mt-2 max-w-[200px]">{cameraError}</p>
            <button onClick={onClose} className="mt-8 px-8 py-4 bg-slate-800 rounded-2xl font-black uppercase text-xs tracking-widest hover:bg-slate-700 transition">Go Back</button>
          </div>
        ) : (
          <div className="relative w-full h-full aspect-[3/4] sm:aspect-square bg-black flex items-center justify-center pt-20 sm:pt-0">
            <div id="qr-reader" className="w-full h-full absolute inset-0 [&>video]:object-cover" />

            {/* Visual Scan Area (Stylistic overlay) */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-40">
              <div className="w-[200px] h-[200px] sm:w-[250px] sm:h-[250px] border-2 border-white/20 rounded-[2.5rem] relative">
                <div className="absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 border-sky-500 rounded-tl-[2rem]" />
                <div className="absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 border-sky-500 rounded-tr-[2rem]" />
                <div className="absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 border-sky-500 rounded-bl-[2rem]" />
                <div className="absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 border-sky-500 rounded-br-[2rem]" />
                <div className="absolute inset-0 bg-sky-500/10 animate-pulse rounded-[2rem]" />
              </div>
            </div>
          </div>
        )}

        {/* Footer info - Minimalist */}
        <div className="absolute bottom-8 sm:bottom-10 left-0 right-0 text-center pointer-events-none z-50">
          <div className="inline-flex items-center gap-2 bg-black/50 backdrop-blur px-4 py-2 rounded-full border border-white/10">
            <div className={`w-2 h-2 rounded-full ${isReady ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></div>
            <p className="text-[9px] font-black text-white/60 uppercase tracking-[0.4em]">
              {isReady ? 'Engine Optical Ready' : 'Initializing...'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
