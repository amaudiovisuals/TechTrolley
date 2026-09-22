import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface ScannerProps {
  onScan: (decodedText: string) => void;
  onClose: () => void;
}

const ScannerComponent: React.FC<ScannerProps> = ({ onScan, onClose }) => {
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isScanning = useRef(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isSuccessFlash, setIsSuccessFlash] = useState(false);
  const lastScanned = useRef<string>("");
  const lastScannedTime = useRef<number>(0);

  const playFeedback = () => {
    // 1. Tactile Haptic Vibration
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate([40, 30, 40]);
      } catch {
        // Ignore vibration errors on unsupported hardware
      }
    }

    // 2. High-Precision Audio Beep
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
      }
    } catch {
      // Audio playback might be restricted if no user interaction yet
    }
  };

  const handleClose = async () => {
    if (scannerRef.current && isScanning.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
        isScanning.current = false;
      } catch (e) {
        console.warn("Cleanup error on close:", e);
      }
    }
    onClose();
  };

  useEffect(() => {
    let isMounted = true;
    const scannerId = "qr-reader";

    const startScanner = async () => {
      try {
        if (!isMounted) return;

        // Ensure cleanup of any old instance before starting
        if (scannerRef.current && isScanning.current) {
          try {
            await scannerRef.current.stop();
            scannerRef.current.clear();
            isScanning.current = false;
          } catch (e) {
            console.warn("Cleanup error during restart:", e);
          }
        }

        // Initialize with hardware-accelerated BarcodeDetector where supported (Android/Chrome 60fps zero-lag)
        scannerRef.current = new Html5Qrcode(scannerId, {
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
          },
          verbose: false
        });

        // Request back-facing camera directly via facingMode: "environment"
        await scannerRef.current.start(
          { facingMode: "environment" },
          {
            fps: 15, // 15 FPS for snappy asset scanning without draining battery
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              // Wide rectangular region to naturally accommodate 1D barcodes (Code128, EAN) and 2D QR codes
              const width = Math.min(Math.floor(viewfinderWidth * 0.88), 340);
              const height = Math.min(Math.floor(viewfinderHeight * 0.58), 230);
              return { width, height };
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
              // Trigger Visual & Haptic/Audio Feedback
              setIsSuccessFlash(true);
              playFeedback();
              setTimeout(() => setIsSuccessFlash(false), 400);

              // Pass to parent
              onScanRef.current(code);
            }
          },
          () => {
            // Ignore scan errors
          }
        );

        isScanning.current = true;
        if (isMounted) setIsReady(true);

      } catch (err: any) {
        console.error("Camera error:", err);
        if (isMounted) {
          const errMsg = err?.message || "";
          if (errMsg.includes("NotAllowedError") || errMsg.includes("Permission denied")) {
            setPermissionError(true);
          } else {
            setCameraError(errMsg || "Camera access denied. Please enable camera permissions in your browser settings.");
          }
        }
      }
    };

    startScanner();

    return () => {
      isMounted = false;
      if (scannerRef.current && isScanning.current) {
        const currentRef = scannerRef.current;
        isScanning.current = false;
        currentRef.stop().then(() => {
          try {
            currentRef.clear();
          } catch (e) {
            console.error("Clear error on unmount:", e);
          }
        }).catch(err => {
          console.warn("Stop error on unmount:", err);
          try { currentRef.clear(); } catch {}
        });
        scannerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md p-0 sm:p-4 animate-in fade-in duration-300">
      <div className="relative w-full h-full sm:h-auto sm:max-w-lg bg-slate-950 sm:rounded-[2.5rem] overflow-hidden border-0 sm:border border-slate-800 shadow-2xl flex flex-col">

        {/* Dedicated Touch-Friendly Close Button */}
        <button
          onClick={handleClose}
          className="absolute top-5 left-5 z-[120] w-12 h-12 bg-black/60 backdrop-blur-md rounded-2xl flex items-center justify-center text-white hover:bg-white/20 active:scale-90 transition-all border border-white/15 shadow-2xl"
          title="Close Scanner"
          aria-label="Close Scanner"
        >
          <i className="fa-solid fa-xmark text-xl" />
        </button>

        {/* Minimalist Scanner Status Header */}
        <div className="absolute top-5 right-5 z-[120] text-right pointer-events-none">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/60 backdrop-blur border border-white/10 text-[9px] font-black text-white/80 uppercase tracking-widest">
            <span className={`w-2 h-2 rounded-full ${isReady ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            {isReady ? 'Live Scanning' : 'Starting...'}
          </span>
          <p className="text-[8px] font-bold text-sky-400 uppercase tracking-widest mt-1">Continuous Mode</p>
        </div>

        {permissionError ? (
          <div className="h-full flex flex-col items-center justify-center p-6 sm:p-12 text-center text-white bg-slate-950">
            <div className="w-16 h-16 rounded-3xl bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center text-2xl mb-4">
              <i className="fa-solid fa-camera-slash" />
            </div>
            <h4 className="text-xl font-black uppercase tracking-tight text-white mb-2">Camera Blocked</h4>
            <p className="text-xs text-slate-400 max-w-sm mb-6 leading-relaxed">
              Please ensure camera permissions are allowed in your phone browser settings and that you are using a secure connection (HTTPS).
            </p>
            <button
              onClick={handleClose}
              className="px-8 py-3.5 bg-slate-800 hover:bg-slate-700 rounded-2xl font-black uppercase text-xs tracking-widest text-white transition active:scale-95"
            >
              Close
            </button>
          </div>
        ) : cameraError ? (
          <div className="h-full flex flex-col items-center justify-center p-8 sm:p-12 text-center text-white bg-slate-950">
            <div className="w-16 h-16 rounded-3xl bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center text-2xl mb-4">
              <i className="fa-solid fa-triangle-exclamation" />
            </div>
            <h4 className="text-xl font-black uppercase tracking-tight text-white mb-2">Access Denied</h4>
            <p className="text-xs text-slate-400 max-w-sm mb-6 leading-relaxed">{cameraError}</p>
            <button
              onClick={handleClose}
              className="px-8 py-3.5 bg-slate-800 hover:bg-slate-700 rounded-2xl font-black uppercase text-xs tracking-widest text-white transition active:scale-95"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="relative w-full flex-1 sm:flex-initial sm:h-[480px] bg-black flex items-center justify-center overflow-hidden">
            {/* HTML5 QR Code Container with Universal Video Fill Rules */}
            <div
              id="qr-reader"
              className="w-full h-full absolute inset-0 [&_video]:w-full [&_video]:h-full [&_video]:object-cover [&_canvas]:hidden"
            />

            {/* Visual Scan Reticle (Rectangular for 1D Barcodes + QR) */}
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center z-40 p-4">
              <div className={`w-[290px] h-[190px] sm:w-[340px] sm:h-[220px] border-2 rounded-[2rem] relative transition-all duration-300 ${
                isSuccessFlash ? 'border-emerald-500 scale-105 shadow-[0_0_40px_rgba(16,185,129,0.5)]' : 'border-white/30 shadow-2xl'
              }`}>
                {/* Corner Markers */}
                <div className={`absolute -top-0.5 -left-0.5 w-8 h-8 border-t-4 border-l-4 rounded-tl-[1.8rem] transition-colors ${isSuccessFlash ? 'border-emerald-400' : 'border-sky-400'}`} />
                <div className={`absolute -top-0.5 -right-0.5 w-8 h-8 border-t-4 border-r-4 rounded-tr-[1.8rem] transition-colors ${isSuccessFlash ? 'border-emerald-400' : 'border-sky-400'}`} />
                <div className={`absolute -bottom-0.5 -left-0.5 w-8 h-8 border-b-4 border-l-4 rounded-bl-[1.8rem] transition-colors ${isSuccessFlash ? 'border-emerald-400' : 'border-sky-400'}`} />
                <div className={`absolute -bottom-0.5 -right-0.5 w-8 h-8 border-b-4 border-r-4 rounded-br-[1.8rem] transition-colors ${isSuccessFlash ? 'border-emerald-400' : 'border-sky-400'}`} />

                {/* Laser scanline indicator */}
                <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 h-0.5 bg-gradient-to-r from-transparent via-sky-400 to-transparent opacity-70 animate-pulse pointer-events-none" />

                {/* Success Flash Fill */}
                <div className={`absolute inset-0 rounded-[1.8rem] transition-all duration-300 ${isSuccessFlash ? 'bg-emerald-500/25' : 'bg-sky-500/5'}`} />

                {isSuccessFlash && (
                  <div className="absolute inset-0 flex items-center justify-center animate-out zoom-out fade-out duration-400">
                    <i className="fa-solid fa-circle-check text-5xl text-emerald-400 shadow-2xl" />
                  </div>
                )}
              </div>

              {/* Guidance text under viewfinder */}
              <p className="mt-4 text-[10px] font-bold text-white/70 uppercase tracking-widest bg-black/50 backdrop-blur px-4 py-1.5 rounded-full border border-white/10 shadow-lg">
                Point at Barcode or QR Code
              </p>
            </div>
          </div>
        )}

        {/* Footer info banner */}
        <div className="bg-slate-950 p-4 border-t border-slate-900 flex items-center justify-between text-[9px] font-black text-slate-500 uppercase tracking-widest">
          <span>TechTrolley Optical Suite</span>
          <span className="text-sky-400">Continuous Auto-Scan</span>
        </div>
      </div>
    </div>
  );
};

export const Scanner = React.memo(ScannerComponent);
