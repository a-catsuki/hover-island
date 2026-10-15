import { createSignal } from 'solid-js'
const KEY = 'hover-island.focus.v1'
type Timer = { duration:number; remaining:number; endsAt:number|null; completed:boolean }
const defaults = ():Timer => ({ duration:1500,remaining:1500,endsAt:null,completed:false })
function restore():Timer { try { const item=JSON.parse(localStorage.getItem(KEY) ?? 'null') as Timer|null; if(item && Number.isInteger(item.duration) && item.duration>=60 && item.duration<=10800 && Number.isFinite(item.remaining) && item.remaining>=0 && item.remaining<=item.duration && typeof item.completed==='boolean' && (item.endsAt===null || Number.isFinite(item.endsAt))) return item } catch {} return defaults() }
const [focusTimer,setFocusTimer]=createSignal(restore())
const persist=()=>{try{localStorage.setItem(KEY,JSON.stringify(focusTimer()))}catch{}}
export function tickFocus():void { const item=focusTimer(); if(!item.endsAt)return; const remaining=Math.max(0,Math.ceil((item.endsAt-Date.now())/1000)); if(remaining!==item.remaining)setFocusTimer({...item,remaining,endsAt:remaining?item.endsAt:null,completed:!remaining}); if(!remaining)persist() }
export function startFocus():void { const item=focusTimer(); const remaining=item.remaining||item.duration; setFocusTimer({...item,remaining,endsAt:Date.now()+remaining*1000,completed:false});persist() }
export function pauseFocus():void { tickFocus();setFocusTimer({...focusTimer(),endsAt:null});persist() }
export function resetFocus(minutes=focusTimer().duration/60):void { if(!Number.isFinite(minutes))return; const duration=Math.round(Math.min(180,Math.max(1,minutes)))*60;setFocusTimer({duration,remaining:duration,endsAt:null,completed:false});persist() }
export const formatFocus=(seconds:number)=>`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`
export { focusTimer }
