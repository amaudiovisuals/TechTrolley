// Serialize camera ownership across close/reopen and React StrictMode. Disposal
// gates callbacks immediately, then stops the exact instance when start settles.
let lane:Promise<unknown>=Promise.resolve();
export interface CameraAdapter {start:(success:(text:string)=>void)=>Promise<unknown>;stop:()=>Promise<unknown>;clear:()=>unknown;cancel?:()=>void;}
export function cameraMessage(error:unknown){
  const text=error instanceof Error?`${error.name} ${error.message}`:String(error||'');
  if(/NotAllowed|Permission|denied/i.test(text))return 'Camera permission is blocked. Allow camera access in browser settings, then retry.';
  if(/NotFound|DevicesNotFound/i.test(text))return 'No camera was found. Use another camera or the barcode input.';
  if(/NotReadable|TrackStart|in use|Could not start/i.test(text))return 'The camera is busy. Close other camera apps and retry.';
  return 'The camera could not start. Check camera access, use HTTPS and retry. Barcode input remains available.';
}
export function createCameraSession(adapter:()=>CameraAdapter,onRead:(code:string)=>unknown,onReady:()=>void,onError:(error:unknown)=>void,now=()=>Date.now(),onReadError:(error:unknown)=>void=onError){
  let disposed=false,instance:CameraAdapter|undefined,started=false;
  const recent=new Map<string,number>();
  const enqueue=(run:()=>Promise<unknown>)=>{const task=lane.then(run,run);lane=task.catch(()=>{});return task;};
  const stop=async()=>{if(!instance)return;try{if(started)await instance.stop();}finally{started=false;try{instance.clear();}catch{/* Container may be removed. */}instance=undefined;}};
  const task=enqueue(async()=>{
    if(disposed)return;
    try{
      instance=adapter();
      await instance.start(text=>{
        const code=text.trim(),time=now();if(disposed||!code)return;
        const previous=recent.get(code);if(previous!==undefined&&time-previous<2000)return;
        recent.set(code,time);if(recent.size>256)recent.delete(recent.keys().next().value!);
        // Decode is not a save acknowledgement. Parent commands decide the result.
        try{Promise.resolve(onRead(code)).catch(error=>{if(!disposed){recent.delete(code);onReadError(error);}});}catch(error){recent.delete(code);if(!disposed)onReadError(error);}
      });
      started=true;
      if(disposed)await stop();else onReady();
    }catch(error){try{await stop();}catch{/* Preserve original error. */}if(!disposed)onError(error);}
  });
  return {started:task,close:()=>{disposed=true;instance?.cancel?.();return enqueue(stop);}};
}
