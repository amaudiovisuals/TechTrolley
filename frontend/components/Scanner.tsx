import React,{useEffect,useRef,useState} from 'react';
import {cameraMessage,createCameraSession} from '../state/cameraSession';
import {html5Camera} from '../state/html5Camera';
interface ScannerProps {onScan:(decodedText:string)=>void|Promise<unknown>;onClose:()=>void;}
let nextScannerId=0;
const ScannerComponent:React.FC<ScannerProps>=({onScan,onClose})=>{
  const onScanRef=useRef(onScan);onScanRef.current=onScan;
  const id=useRef(`qr-reader-${++nextScannerId}`),session=useRef<ReturnType<typeof createCameraSession>|null>(null);
  const [attempt,setAttempt]=useState(0),[visible,setVisible]=useState(!document.hidden),[ready,setReady]=useState(false),[error,setError]=useState(''),[read,setRead]=useState(false);
  const flash=useRef<ReturnType<typeof setTimeout>|null>(null),audio=useRef<AudioContext|null>(null);
  const [readError,setReadError]=useState('');
  useEffect(()=>{const changed=()=>setVisible(!document.hidden);document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
  useEffect(()=>{
    let active=true;setReady(false);setError('');
    if(!visible)return;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){setError('Camera access needs HTTPS and a supported browser. Barcode input remains available.');return;}
    const current=createCameraSession(()=>html5Camera(id.current),code=>{
      if(!active)return;
      setReadError('');
      setRead(true);if(flash.current)clearTimeout(flash.current);flash.current=setTimeout(()=>{if(active)setRead(false);},400);
      try{navigator.vibrate?.(40);}catch{/* Optional feedback. */}
      try{
        const AudioCtx=window.AudioContext||(window as any).webkitAudioContext;
        if(AudioCtx){const ctx=audio.current||(audio.current=new AudioCtx());const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=880;gain.gain.value=.05;osc.connect(gain);gain.connect(ctx.destination);osc.onended=()=>{osc.disconnect();gain.disconnect();};osc.start();osc.stop(ctx.currentTime+.08);}
      }catch{/* Audio restrictions never block a scan. */}
      return onScanRef.current(code);
    },()=>{if(active)setReady(true);},err=>{if(active){setError(cameraMessage(err));setReady(false);}},()=>Date.now(),()=>{if(active)setReadError('The code could not be checked. Try again or use barcode input.');});
    session.current=current;
    return()=>{active=false;void current.close().catch(()=>{});if(session.current===current)session.current=null;if(flash.current)clearTimeout(flash.current);};
  },[attempt,visible]);
  useEffect(()=>()=>{if(audio.current){void audio.current.close().catch(()=>{});audio.current=null;}},[]);
  const close=()=>{void session.current?.close().catch(()=>{});onClose();};
  return <div role="dialog" aria-label="Camera scanner" aria-modal="true" className="fixed inset-0 z-[100] bg-black/95 p-4 flex items-center justify-center">
    <div style={{maxHeight:'calc(100dvh - 32px)',overflow:'auto'}} className="w-full max-w-lg bg-slate-950 rounded-2xl border border-slate-700 text-white">
      <div className="flex justify-between items-center p-4"><h3>Camera scanner</h3><button aria-label="Close Scanner" onClick={close} className="min-h-12 px-4 rounded bg-slate-800">Close</button></div>
      <p role="status" className="px-4 pb-3">{!visible?'Camera paused while the app is in the background':error?'Camera needs attention':ready?'Live Scanning':'Starting camera…'}</p>
      {error&&<div role="alert" className="p-4"><p>{error}</p><button onClick={()=>setAttempt(n=>n+1)} className="mt-3 min-h-12 px-4 bg-sky-700 rounded">Retry camera</button></div>}
      {readError&&<p role="alert" className="p-4">{readError}</p>}
      <div style={{height:'min(52dvh, 420px)',minHeight:120}} className={`relative bg-black ${error?'hidden':''}`}><div id={id.current} className="w-full h-full [&_video]:w-full [&_video]:h-full [&_video]:object-contain"/><div className={`pointer-events-none absolute inset-8 border-2 rounded-xl ${read?'border-sky-300':'border-white/40'}`}/></div>
      <p className="p-4 text-sm text-slate-300">{read?'Code read. Check the item result before moving on.':'Point at a barcode or QR code. A read is confirmed separately from saving.'}</p>
    </div>
  </div>;
};
export const Scanner=React.memo(ScannerComponent);
