import {Html5Qrcode} from 'html5-qrcode';
import type {CameraAdapter} from './cameraSession';

// html5-qrcode 2.3.x does not handle the Promise returned by video.play().
// Observe playback only on this reader's own video, including after its modal
// unmounts. Do not patch browser prototypes or swallow unrelated rejections.
export function html5Camera(id:string):CameraAdapter {
  const container=document.getElementById(id);
  if(!container)throw new Error('Camera container is unavailable');
  const reader=new Html5Qrcode(id,{experimentalFeatures:{useBarCodeDetectorIfSupported:true},verbose:false});
  const videos=new Set<HTMLVideoElement>();
  const append=container.append;
  let closing=false,rejectPlayback:(error:unknown)=>void=()=>{};
  const playbackFailure=new Promise<never>((_,reject)=>{rejectPlayback=reject;});
  const watch=(node:Node|string)=>{
    if(!(node instanceof HTMLVideoElement)||videos.has(node))return;
    videos.add(node);
    const play=node.play;
    node.play=function(){
      const result=play.call(this);
      // Attaching a rejection handler marks this exact play promise handled.
      // Active failures reject startup; aborts after disposal need only cleanup.
      void result.catch(error=>{if(!closing)rejectPlayback(error);});
      return result;
    };
  };
  container.append=function(...nodes:(Node|string)[]){nodes.forEach(watch);append.apply(this,nodes);};
  return {
    start:success=>Promise.race([
      reader.start({facingMode:'environment'},{fps:15,qrbox:(w,h)=>({width:Math.max(1,Math.min(Math.floor(w*.88),340)),height:Math.max(1,Math.min(Math.floor(h*.58),230))})},success,()=>{}),
      playbackFailure,
    ]),
    cancel:()=>{closing=true;},
    stop:()=>reader.stop(),
    clear:()=>{
      closing=true;
      if(container.append!==append)container.append=append;
      videos.forEach(video=>(video.srcObject as MediaStream|null)?.getTracks?.().forEach(track=>track.stop()));
      reader.clear();
    },
  };
}
