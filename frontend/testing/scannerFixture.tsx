import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Scanner} from '../components/Scanner';
function Fixture(){const [open,setOpen]=useState(false),[codes,setCodes]=useState<string[]>([]);return <><button onClick={()=>setOpen(true)}>Open camera</button><output data-testid="camera-codes">{codes.join(',')}</output>{open&&<Scanner onScan={async code=>{if((window as any).__scannerFail)throw Error('Synthetic failed parent');setCodes(old=>[...old,code]);}} onClose={()=>setOpen(false)}/>}</>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
