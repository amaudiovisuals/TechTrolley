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
  const [isSuccessFlash, setIsSuccessFlash] = useState(false);
  const lastScanned = useRef<string>("");
  const lastScannedTime = useRef<number>(0);

  useEffect(() => {
    let isMounted = true;
    const scannerId = "qr-reader";

    const startScanner = async () => {
      try {
        const hasCamera = await Html5Qrcode.getCameras();
        if (!hasCamera || hasCamera.length === 0) {
          throw new Error("No camera camera found");
        }

        if (!isMounted) return;

        // Ensure cleanup of any old instance before starting
        if (scannerRef.current) {
          try {
            await scannerRef.current.stop();
            scannerRef.current.clear();
          } catch (e) {
            console.warn("Cleanup error during restart:", e);
          }
        }

        scannerRef.current = new Html5Qrcode(scannerId);

        await scannerRef.current.start(
          { facingMode: "environment" },
          {
            fps: 25,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const minEdgeSize = Math.min(viewfinderWidth, viewfinderHeight);
              const qrboxSize = Math.floor(minEdgeSize * 0.75);
              return { width: qrboxSize, height: qrboxSize };
            }
          },
          (decodedText) => {
            const code = decodedText.trim();
            const now = Date.now();

            // Local debouncing to avoid flooding the parent during continuous mode
            if (code === lastScanned.current && (now - lastScannedTime.current) < 2000) {
              return;
            }

            lastScanned.current = code;
            lastScannedTime.current = now;

            if (isMounted) {
              // Trigger Visual Feedback
              setIsSuccessFlash(true);
              setTimeout(() => setIsSuccessFlash(false), 400);
              
              // Pass to parent
              onScan(code);
            }
          },
          () => {
            // Ignore scan errors
          }
        );

        if (isMounted) setIsReady(true);

      } catch (err: any) {
        console.error("Camera error:", err);
        if (isMounted) {
          setCameraError(err?.message || "Camera access denied. Please enable camera permissions.");
        }
      }
    };

    startScanner();

    return () => {
      isMounted = false;
      if (scannerRef.current) {
        // Robust cleanup to prevent "hanging"
        const currentRef = scannerRef.current;
        currentRef.stop().then(() => {
          try {
            currentRef.clear();
          } catch (e) {
            console.error("Clear error on unmount:", e);
          }
        }).catch(err => {
          console.warn("Stop error on unmount:", err);
          // If stopping fails, we try to clear anyway
          try { currentRef.clear(); } catch(e) {}
        });
        scannerRef.current = null;
      }
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black p-0 sm:p-4 animate-in fade-in duration-300">
      <div className="relative w-full h-full sm:h-auto sm:max-w-md bg-slate-900 sm:rounded-[2.5rem] overflow-hidden border-0 sm:border border-slate-800 shadow-2xl">

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-6 left-6 z-[110] w-12 h-12 bg-black/40 backdrop-blur-md rounded-full flex items-center justify-center text-white hover:bg-white/20 transition-all border border-white/10 shadow-xl"
        >
          <i className="fa-solid fa-xmark text-xl" />
        </button>

        {/* Minimalist UI Header */}
        <div className="absolute top-6 right-6 z-[110] text-right pointer-events-none">
          <p className="text-[10px] font-black text-white/60 uppercase tracking-[0.3em]">Scanner Active</p>
          <p className="text-[8px] font-bold text-sky-400 uppercase tracking-widest mt-0.5 animate-pulse">Continuous Workflow</p>
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
              <div className={`w-[220px] h-[220px] sm:w-[260px] sm:h-[260px] border-2 rounded-[2.5rem] relative transition-all duration-300 ${isSuccessFlash ? 'border-emerald-500 scale-110' : 'border-white/20'}`}>
                <div className={`absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 rounded-tl-[2rem] transition-colors ${isSuccessFlash ? 'border-emerald-500' : 'border-sky-500'}`} />
                <div className={`absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 rounded-tr-[2rem] transition-colors ${isSuccessFlash ? 'border-emerald-500' : 'border-sky-500'}`} />
                <div className={`absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 rounded-bl-[2rem] transition-colors ${isSuccessFlash ? 'border-emerald-500' : 'border-sky-500'}`} />
                <div className={`absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 rounded-br-[2rem] transition-colors ${isSuccessFlash ? 'border-emerald-500' : 'border-sky-500'}`} />
                <div className={`absolute inset-0 rounded-[2rem] transition-all duration-300 ${isSuccessFlash ? 'bg-emerald-500/30' : 'bg-sky-500/10'}`} />
                
                {isSuccessFlash && (
                  <div className="absolute inset-0 flex items-center justify-center animate-out zoom-out fade-out duration-500">
                    <i className="fa-solid fa-circle-check text-4xl text-emerald-500 shadow-xl" />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer info - Minimalist */}
        <div className="absolute bottom-8 sm:bottom-10 left-0 right-0 text-center pointer-events-none z-[110]">
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
